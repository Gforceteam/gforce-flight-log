require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@libsql/client');

process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const compression = require('compression');
const webpush = require('web-push');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const OFFICE_PASSWORD = process.env.OFFICE_PASSWORD;

// ─── App Settings (in-memory, persisted to DB) ────────────────────────────────
let _pushNotificationsEnabled = false; // off by default; loaded from DB at startup
let _trackerEnabledDate = null;        // NZ date string when tracker was enabled, null = off; auto-expires at midnight
let _officeTv = 0;              // token version — incremented on password change to invalidate all sessions
let _officeRefreshSecret = '';  // refresh secret — rotated on password change; seeded from env var

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var not set. Set it with: fly secrets set JWT_SECRET=<long-random-string>');
  process.exit(1);
}
if (!OFFICE_PASSWORD) {
  console.error('FATAL: OFFICE_PASSWORD env var not set. Set it with: fly secrets set OFFICE_PASSWORD=<password>');
  process.exit(1);
}
if (!process.env.OFFICE_REFRESH_SECRET) {
  console.error('FATAL: OFFICE_REFRESH_SECRET env var not set. Set it with: fly secrets set OFFICE_REFRESH_SECRET=<long-random-string>');
  process.exit(1);
}

// ─── Security helpers ─────────────────────────────────────────────────────────
// Constant-time string comparison (prevents timing attacks)
function safeCompare(a, b) {
  // Hash both to fixed 32-byte digests so timingSafeEqual always runs on equal-length buffers,
  // preventing timing attacks on both content and length differences.
  const key = Buffer.alloc(32);
  const hashA = crypto.createHmac('sha256', key).update(String(a)).digest();
  const hashB = crypto.createHmac('sha256', key).update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// In-memory rate limiter — strict (5/15min) for auth, general (1000/15min) for all other API routes
const _rateLimitBuckets = new Map();
function _checkLimit(ip, key, max, windowMs) {
  const now = Date.now();
  const mapKey = `${key}:${ip}`;
  let entry = _rateLimitBuckets.get(mapKey);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
  }
  entry.count++;
  _rateLimitBuckets.set(mapKey, entry);
  if (entry.count > max) {
    return { blocked: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { blocked: false };
}
function checkRateLimit(ip) { return _checkLimit(ip, 'auth', 5, 15 * 60 * 1000); }
function checkGlobalRateLimit(ip) { return _checkLimit(ip, 'global', 1000, 15 * 60 * 1000); }
function clearRateLimit(ip) {
  for (const k of _rateLimitBuckets.keys()) { if (k.endsWith(`:${ip}`)) _rateLimitBuckets.delete(k); }
}
// Clean up old entries every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of _rateLimitBuckets) { if (now > e.resetAt) _rateLimitBuckets.delete(k); }
}, 30 * 60 * 1000);

// Input sanitisation — trim and cap length
function sanitize(s, max = 200) {
  if (s == null) return null;
  return String(s).trim().slice(0, max) || null;
}

// ─── Server-side timer watcher — runs every 30 s ──────────────────────────────
// Sends push notifications at 10 min, 5 min, and 0 min remaining.
// Uses atomic DB flag updates so duplicate sends don't happen across two instances.
async function checkTimerNotifications() {
  try {
    const now = Date.now();
    const timers = await queryAll(`
      SELECT at.*, p.name as pilot_name
      FROM active_timers at
      JOIN pilots p ON at.pilot_id = p.id
    `);
    for (const timer of timers) {
      const remainingMs = new Date(timer.expires_at).getTime() - now;
      const remainingMins = Math.floor(remainingMs / 60000);

      // 10-minute push notification disabled

      // 5-minute push notification disabled

      // Expiry — send once when remaining hits 0 or below
      if (remainingMins <= 0 && !Number(timer.notif_expired)) {
        const r = await db.execute({
          sql: 'UPDATE active_timers SET notif_expired = 1 WHERE pilot_id = ? AND notif_expired = 0',
          args: [timer.pilot_id]
        });
        if (r.rowsAffected > 0) {
          // Push to pilot
          await sendPushToPilot(timer.pilot_id, {
            title: '⏰ Timer expired!',
            body: 'Your flight timer has expired. Please land and log your flight.',
            tag: 'timer-expired',
            requireInteraction: true
          });
          // Broadcast to office (shows alert banner + toast)
          broadcast({ type: 'TIMER_EXPIRED', pilot_id: timer.pilot_id, pilot_name: timer.pilot_name });
          // Audit log
          await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)',
            [uuidv4(), timer.pilot_id, 'timer_expired', new Date().toISOString()]);
          console.log(`⏰ Expired push + broadcast → ${timer.pilot_name}`);
        }
      }
    }
  } catch (e) {
    console.error('Timer notification check failed:', e.message);
  }
}
// Start after server is up (2 s delay so DB is ready)
setTimeout(() => setInterval(checkTimerNotifications, 30 * 1000), 2000);

// ─── Web Push (VAPID) ─────────────────────────────────────────────────────────
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@gforce.co.nz',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('✅ VAPID push notifications configured');
} else {
  console.warn('⚠️  VAPID keys not set — push notifications disabled');
}

// ─── Database ─────────────────────────────────────────────────────────────────
const db = createClient({
  url: process.env.TURSO_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function queryAll(sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return result.rows.map(row => {
    const obj = {};
    result.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

async function queryOne(sql, params = []) {
  const rows = await queryAll(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  await db.execute({ sql, args: params });
}

async function createTables() {
  await db.execute(`CREATE TABLE IF NOT EXISTS pilots (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL,
    created_at TEXT, last_seen TEXT, current_wing TEXT, available INTEGER DEFAULT 0,
    refresh_token TEXT)`);
  // Add available column to existing DBs that predate this column
  try { await db.execute('ALTER TABLE pilots ADD COLUMN available INTEGER DEFAULT 0'); } catch (_) {}
  // Add refresh_token column to existing DBs
  try { await db.execute('ALTER TABLE pilots ADD COLUMN refresh_token TEXT'); } catch (_) {}
  try { await db.execute('ALTER TABLE pilots ADD COLUMN avatar_data TEXT'); } catch (_) {}
  // presence: 0 = signed_out, 1 = available, 2 = down_bottom (replaces boolean-only available)
  try { await db.execute('ALTER TABLE pilots ADD COLUMN presence INTEGER DEFAULT 0'); } catch (_) {}
  try {
    await db.execute(`UPDATE pilots SET presence = CASE WHEN COALESCE(available,0) = 1 THEN 1 ELSE 0 END`);
  } catch (_) {}
  await db.execute(`CREATE TABLE IF NOT EXISTS flights (
    id TEXT PRIMARY KEY, pilot_id TEXT, client_name TEXT, date TEXT,
    flight_num INTEGER, weight REAL, takeoff TEXT, landing TEXT,
    time INTEGER, photos REAL, notes TEXT, landed_at TEXT,
    created_at TEXT, wing_reg TEXT, hours_worked REAL)`);
  // Add hours_worked column to existing DBs that predate this column
  try { await db.execute('ALTER TABLE flights ADD COLUMN hours_worked REAL'); } catch (_) {}
  // Add sent_away_at column to existing DBs
  try { await db.execute('ALTER TABLE flights ADD COLUMN sent_away_at TEXT'); } catch (_) {}
  // Add office acknowledgment emoji column
  try { await db.execute('ALTER TABLE flights ADD COLUMN office_ack_emoji TEXT'); } catch (_) {}
  // Add office acknowledgment timestamp column
  try { await db.execute('ALTER TABLE flights ADD COLUMN office_ack_at TEXT'); } catch (_) {}
  await db.execute(`CREATE TABLE IF NOT EXISTS office_logs (
    id TEXT PRIMARY KEY, pilot_id TEXT, event TEXT, created_at TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS active_timers (
    pilot_id TEXT PRIMARY KEY, client_name TEXT, started_at TEXT, expires_at TEXT, group_id TEXT,
    notif_10min INTEGER DEFAULT 0, notif_5min INTEGER DEFAULT 0, notif_expired INTEGER DEFAULT 0)`);
  // Add notification flag columns to existing DBs
  try { await db.execute('ALTER TABLE active_timers ADD COLUMN notif_10min INTEGER DEFAULT 0'); } catch (_) {}
  try { await db.execute('ALTER TABLE active_timers ADD COLUMN notif_5min INTEGER DEFAULT 0'); } catch (_) {}
  try { await db.execute('ALTER TABLE active_timers ADD COLUMN notif_expired INTEGER DEFAULT 0'); } catch (_) {}
  // Add cancelled_at column for early-land tracking
  try { await db.execute('ALTER TABLE active_timers ADD COLUMN cancelled_at TEXT'); } catch (_) {}
  // Add office_adjustments column to track cumulative time adjustments
  try { await db.execute('ALTER TABLE active_timers ADD COLUMN office_adjustments INTEGER DEFAULT 0'); } catch (_) {}
  await db.execute(`CREATE TABLE IF NOT EXISTS drives (
    id TEXT PRIMARY KEY, pilot_id TEXT, date TEXT, notes TEXT, group_id TEXT, created_at TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS extension_requests (
    id TEXT PRIMARY KEY, pilot_id TEXT NOT NULL, requested_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', responded_at TEXT)`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_ext_req_pilot ON extension_requests(pilot_id, status)');
  await db.execute(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY, pilot_id TEXT NOT NULL, subscription TEXT NOT NULL, created_at TEXT)`);
  // Indexes for common queries
  await db.execute('CREATE INDEX IF NOT EXISTS idx_flights_pilot_date ON flights(pilot_id, date)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_flights_date ON flights(date)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_timers_pilot ON active_timers(pilot_id)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_push_pilot ON push_subscriptions(pilot_id)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_drives_pilot ON drives(pilot_id)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_flights_landed ON flights(landed_at)');
  await db.execute(`CREATE TABLE IF NOT EXISTS loop_board (
    slot INTEGER PRIMARY KEY,
    pilot_id TEXT,
    pilot_name TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);
  await run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('push_notifications_enabled', 'false')");
  try { await db.execute('ALTER TABLE loop_board ADD COLUMN tallies TEXT'); } catch (_) {}
  // Date-aware loop board table
  await db.execute(`CREATE TABLE IF NOT EXISTS coronet_trips (
    id TEXT PRIMARY KEY,
    van INTEGER NOT NULL,
    van_label TEXT NOT NULL,
    date TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    sent_at TEXT NOT NULL
  )`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_coronet_trips_date ON coronet_trips(date)');
  // Add status columns to existing table (safe no-op if already present)
  try { await db.execute("ALTER TABLE coronet_trips ADD COLUMN status TEXT DEFAULT NULL"); } catch (_) {}
  try { await db.execute("ALTER TABLE coronet_trips ADD COLUMN van_left_at TEXT DEFAULT NULL"); } catch (_) {}
  try { await db.execute("ALTER TABLE coronet_trips ADD COLUMN flying_started_at TEXT DEFAULT NULL"); } catch (_) {}
  try { await db.execute("ALTER TABLE coronet_trips ADD COLUMN landed_at TEXT DEFAULT NULL"); } catch (_) {}

  await db.execute(`CREATE TABLE IF NOT EXISTS loop_board_v2 (
    date TEXT NOT NULL,
    slot INTEGER NOT NULL,
    pilot_id TEXT,
    pilot_name TEXT,
    tallies TEXT,
    PRIMARY KEY (date, slot)
  )`);
  // Completed pilots per day (removed from loop board, done flying)
  await db.execute(`CREATE TABLE IF NOT EXISTS loop_board_completed (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    pilot_id TEXT,
    pilot_name TEXT NOT NULL,
    completed_at TEXT NOT NULL
  )`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_lbc_date ON loop_board_completed(date)');
  try { await db.execute('ALTER TABLE loop_board_completed ADD COLUMN slot INTEGER'); } catch (_) {}
  try { await db.execute('ALTER TABLE loop_board_completed ADD COLUMN tallies TEXT'); } catch (_) {}
  try { await db.execute('ALTER TABLE loop_board_v2 ADD COLUMN done INTEGER DEFAULT 0'); } catch (_) {}
  await db.execute(`CREATE TABLE IF NOT EXISTS pilot_location_consent (
    pilot_id    TEXT NOT NULL,
    date        TEXT NOT NULL,
    consented   INTEGER NOT NULL DEFAULT 0,
    consented_at TEXT,
    PRIMARY KEY (pilot_id, date)
  )`);
  // Pilot location tracker
  try { await db.execute('ALTER TABLE pilots ADD COLUMN owntracks_key TEXT'); } catch (_) {}
  const pilotsMissingKey = await queryAll('SELECT id FROM pilots WHERE owntracks_key IS NULL');
  for (const p of pilotsMissingKey) {
    await run('UPDATE pilots SET owntracks_key = ? WHERE id = ?', [uuidv4(), p.id]);
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS pilot_locations (
    pilot_id   TEXT PRIMARY KEY,
    pilot_name TEXT NOT NULL,
    lat        REAL NOT NULL,
    lng        REAL NOT NULL,
    accuracy   REAL,
    updated_at TEXT NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS duty_sheet_overrides (
    pilot_id TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (pilot_id, date)
  )`);
  // Migrate existing loop_board rows into loop_board_v2 for today's date
  const todayForMigration = new Date().toLocaleDateString('en-CA', { timeZone: NZ_TZ });
  const legacyRows = await queryAll('SELECT * FROM loop_board');
  for (const row of legacyRows) {
    await run(
      'INSERT OR IGNORE INTO loop_board_v2 (date, slot, pilot_id, pilot_name, tallies) VALUES (?, ?, ?, ?, ?)',
      [todayForMigration, row.slot, row.pilot_id, row.pilot_name, row.tallies]
    );
  }
  // Fix flights where date was stored as UTC date instead of NZ date (timezone bug in office landing endpoints).
  // Only corrects flights whose stored date equals the raw UTC date extracted from landed_at —
  // meaning they were written by the buggy server code, not manually entered by a pilot.
  try {
    const buggyFlights = await queryAll(
      `SELECT id, landed_at, date FROM flights WHERE landed_at IS NOT NULL AND landed_at != '' AND (notes LIKE '%PENDING_PILOT_FILL%' OR notes LIKE '%Office landed pilot%')`
    );
    let fixedCount = 0;
    for (const f of buggyFlights) {
      const utcDate = f.landed_at.slice(0, 10);
      const nzDate = new Date(f.landed_at).toLocaleDateString('en-CA', { timeZone: NZ_TZ });
      if (f.date === utcDate && nzDate !== utcDate) {
        await run('UPDATE flights SET date = ? WHERE id = ?', [nzDate, f.id]);
        fixedCount++;
      }
    }
    if (fixedCount > 0) console.log(`✅ Corrected ${fixedCount} flight(s) with UTC date → NZ date`);
  } catch (e) { console.error('Date migration error:', e.message); }

  console.log('✅ Tables ready');
}

async function seedIfNeeded() {
  const existing = await queryOne('SELECT COUNT(*) as c FROM pilots');
  if (existing && Number(existing.c) > 0) {
    console.log(`✅ DB has ${existing.c} pilots — skipping seed`);
    return;
  }
  const pinHash = bcrypt.hashSync('1234', 10);
  const pilots = [
    'Brooke', 'Balda', 'Bellett', 'Ben F', 'Blake', 'Casey', 'Cathal',
    'Cima', 'Clem', 'Dom', 'Eddy', 'Gavin', 'Georges', 'Janik', 'Leo',
    'Marika', 'Mike', 'Pete', 'Thomas', 'Todd'
  ];
  for (const name of pilots) {
    await db.execute({
      sql: 'INSERT INTO pilots (id, name, pin_hash, created_at) VALUES (?, ?, ?, ?)',
      args: [uuidv4(), name, pinHash, new Date().toISOString()]
    });
  }
  console.log(`✅ ${pilots.length} pilots seeded with PIN 1234`);
}

// ─── NZ date / presence helpers ────────────────────────────────────────────────
const NZ_TZ = 'Pacific/Auckland';
function isoToNZDateString(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: NZ_TZ });
}
function nzToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: NZ_TZ });
}
// Tracker is active only if it was enabled today (NZ time) — auto-resets at midnight
function isTrackerActive() {
  return _trackerEnabledDate === nzToday();
}
async function ensureLoopBoardDate(date) {
  for (let i = 1; i <= 20; i++) {
    await run('INSERT OR IGNORE INTO loop_board_v2 (date, slot, pilot_id, pilot_name, tallies) VALUES (?, ?, NULL, NULL, NULL)', [date, i]);
  }
}

/** presence: 0 signed out, 1 available, 2 down bottom — keeps legacy `available` in sync (1 iff presence===1) */
async function setPilotPresence(pilotId, presence) {
  const p = Math.max(0, Math.min(2, Math.floor(Number(presence))));
  const avail = p === 1 ? 1 : 0;
  await run('UPDATE pilots SET presence = ?, available = ? WHERE id = ?', [p, avail, pilotId]);
  await run(
    'INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)',
    [uuidv4(), pilotId, `presence:${p}`, new Date().toISOString()]
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.type === 'office') {
      return res.status(403).json({ error: 'Pilot token required' });
    }
    if (!decoded.id) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.pilot = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function verifyOffice(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const office = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    if (office.type !== 'office') return res.status(403).json({ error: 'Not office staff' });
    if (office.tv !== _officeTv) {
      // In-memory may be stale (e.g. after a server restart or brief multi-machine window).
      // Re-read from DB before rejecting.
      try {
        const tvRow = await queryOne("SELECT value FROM app_settings WHERE key = 'office_token_version'");
        const dbTv = tvRow ? parseInt(tvRow.value || '0', 10) : 0;
        if (office.tv === dbTv) {
          _officeTv = dbTv; // update in-memory so future checks are fast
        } else {
          console.log(`[verifyOffice] tv mismatch: token=${office.tv} mem=${_officeTv} db=${dbTv}`);
          return res.status(401).json({ error: 'Session invalidated' });
        }
      } catch (dbErr) {
        console.error('[verifyOffice] DB read failed during tv fallback:', dbErr.message);
        return res.status(401).json({ error: 'Session invalidated' });
      }
    }
    req.office = office;
    next();
  } catch (e) {
    console.log(`[verifyOffice] jwt.verify failed: ${e.message}`);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/** Pilot JWT or office JWT (for shared routes like avatar fetch). */
function verifyPilotOrOffice(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.type === 'office') {
      req.office = decoded;
      return next();
    }
    // Pilot: explicit type or legacy token with id (no type field)
    if (decoded.id && decoded.type !== 'office') {
      req.pilot = decoded;
      return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

const MAX_AVATAR_BYTES = 320 * 1024;

/** Returns validated data URL string, or null to clear. Throws on invalid input. */
function validateAvatarBody(body) {
  if (body == null || !Object.prototype.hasOwnProperty.call(body, 'avatar')) {
    throw new Error('Missing avatar field');
  }
  const raw = body.avatar;
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new Error('avatar must be a string or null');
  const compact = raw.replace(/\s/g, '');
  const m = compact.match(/^data:(image\/(?:jpeg|jpg|png|webp))(?:;charset=[^;]+)?;base64,(.+)$/i);
  if (!m) throw new Error('Avatar must be a base64 data URL (JPEG, PNG, or WebP)');
  let buf;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch {
    throw new Error('Invalid base64');
  }
  if (buf.length > MAX_AVATAR_BYTES) throw new Error(`Image too large (max ${MAX_AVATAR_BYTES / 1024}KB)`);
  if (buf.length < 80) throw new Error('Image too small');
  return compact;
}


function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ─── WebSocket connection handler (ping/pong to prune dead clients) ──────────
wss.on('connection', (ws, req) => {
  // Require a valid JWT passed as ?token= query param
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  let authenticated = false;
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      authenticated = true;
    } catch (_) {}
  }
  if (!authenticated) {
    ws.close(1008, 'Unauthorized');
    return;
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { ws.terminate(); });
});
const _wsPingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(_wsPingInterval));

// ─── Middleware ────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://brookewhatnall.github.io',
  'https://gforceteam.github.io',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : [])
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (native apps, curl, Postman)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`Origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// Global rate limit — 1000 requests per IP per 15 min across all API routes
app.use('/api/', (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const rl = checkGlobalRateLimit(ip);
  if (rl.blocked) return res.status(429).json({ error: `Too many requests. Try again in ${Math.ceil(rl.retryAfter / 60)} minutes.` });
  next();
});

// ─── Diagnostic (no auth) ─────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const tvRow = await queryOne("SELECT value FROM app_settings WHERE key = 'office_token_version'");
    const dbTv = tvRow ? parseInt(tvRow.value || '0', 10) : 0;
    res.json({ ok: true, memTv: _officeTv, dbTv });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Public Routes ────────────────────────────────────────────────────────────
app.get('/api/public/pilots', async (req, res) => {
  try {
    const pilots = await queryAll('SELECT id, name FROM pilots ORDER BY name');
    res.json(pilots);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/pilot', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const rl = checkRateLimit(ip);
  if (rl.blocked) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(rl.retryAfter / 60)} minutes.` });
  }
  try {
    const { name, password, pin } = req.body; // accept both 'password' and legacy 'pin'
    const credential = password || pin;
    if (!name || !credential) return res.status(400).json({ error: 'Name and password required' });
    const pilot = await queryOne('SELECT * FROM pilots WHERE name = ?', [name]);
    if (!pilot || !(await bcrypt.compare(credential, pilot.pin_hash))) {
      return res.status(401).json({ error: 'Invalid name or password' });
    }
    clearRateLimit(ip); // reset on successful login
    const token = jwt.sign({ id: pilot.id, name: pilot.name, type: 'pilot' }, JWT_SECRET, { expiresIn: '24h' });
    const refreshToken = uuidv4();
    await run('UPDATE pilots SET refresh_token = ? WHERE id = ?', [refreshToken, pilot.id]);
    res.json({ token, refresh_token: refreshToken, pilot: { id: pilot.id, name: pilot.name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.put('/api/office/change-password', verifyOffice, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both fields required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  try {
    const stored = await queryOne("SELECT value FROM app_settings WHERE key = 'office_password_hash'");
    let valid = false;
    if (stored && stored.value) {
      valid = await bcrypt.compare(current_password, stored.value);
    } else {
      valid = safeCompare(current_password, OFFICE_PASSWORD);
    }
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 12);
    await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('office_password_hash', ?)", [hash]);
    // Invalidate all active sessions: rotate token version and refresh secret
    _officeTv++;
    _officeRefreshSecret = crypto.randomBytes(32).toString('hex');
    await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('office_token_version', ?)", [String(_officeTv)]);
    await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('office_refresh_secret', ?)", [_officeRefreshSecret]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

app.post('/api/auth/office', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const rl = checkRateLimit(ip);
  if (rl.blocked) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(rl.retryAfter / 60)} minutes.` });
  }
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    // Check DB-stored hash first (set via in-app change password), fall back to env var
    const stored = await queryOne("SELECT value FROM app_settings WHERE key = 'office_password_hash'");
    let valid = false;
    if (stored && stored.value) {
      valid = await bcrypt.compare(password, stored.value);
    } else {
      valid = safeCompare(password, OFFICE_PASSWORD);
    }
    if (!valid) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    clearRateLimit(ip);
    const token = jwt.sign({ type: 'office', tv: _officeTv }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, refresh_token: _officeRefreshSecret });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── Refresh Token (keep pilots logged in) ───────────────────────────────────
app.post('/api/auth/refresh-pilot', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });
    // Find pilot by refresh token
    const pilot = await queryOne('SELECT * FROM pilots WHERE refresh_token = ?', [refresh_token]);
    if (!pilot) return res.status(401).json({ error: 'Invalid refresh token' });
    // Issue new access token (24h)
    const token = jwt.sign({ id: pilot.id, name: pilot.name, type: 'pilot' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

app.post('/api/auth/refresh-office', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });
    if (!_officeRefreshSecret || !safeCompare(refresh_token, _officeRefreshSecret)) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    const token = jwt.sign({ type: 'office', tv: _officeTv }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// ─── Pilot Routes ─────────────────────────────────────────────────────────────
app.get('/api/pilots', verifyPilotOrOffice, async (req, res) => {
  try {
    const pilots = await queryAll(`
      SELECT id, name, last_seen, current_wing,
        COALESCE(presence, CASE WHEN COALESCE(available,0)=1 THEN 1 ELSE 0 END) AS presence,
        available,
        CASE WHEN avatar_data IS NOT NULL AND LENGTH(avatar_data) > 0 THEN 1 ELSE 0 END AS has_avatar
      FROM pilots ORDER BY name`);
    const timers = await queryAll('SELECT * FROM active_timers');
    const lastLanded = await queryAll('SELECT pilot_id, MAX(landed_at) as last_landed FROM flights WHERE landed_at IS NOT NULL GROUP BY pilot_id');

    const pilotsWithStatus = pilots.map(p => {
      const timer = timers.find(t => t.pilot_id === p.id);
      const lastL = lastLanded.find(f => f.pilot_id === p.id);
      const pr = Number(p.presence);
      const presence = Number.isFinite(pr) ? pr : (Number(p.available) === 1 ? 1 : 0);
      return {
        ...p,
        presence,
        available: presence === 1,
        status: timer ? 'airborne' : 'in_office',
        client_name: timer ? timer.client_name : null,
        timer_started_at: timer ? timer.started_at : null,
        timer_expires_at: timer ? timer.expires_at : null,
        group_id: timer ? timer.group_id : null,
        last_landed_at: lastL ? lastL.last_landed : null,
        last_seen: p.last_seen || null
      };
    });

    res.json(pilotsWithStatus);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/my-status', verifyToken, async (req, res) => {
  try {
    await run('UPDATE pilots SET last_seen = ? WHERE id = ?', [new Date().toISOString(), req.pilot.id]);
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [req.pilot.id]);
    const pilot = await queryOne(
      'SELECT current_wing, available, presence, CASE WHEN avatar_data IS NOT NULL AND LENGTH(avatar_data) > 0 THEN 1 ELSE 0 END AS has_avatar FROM pilots WHERE id = ?',
      [req.pilot.id]
    );
    let groupName = null;
    let groupPilots = [];
    let groupId = timer ? (timer.group_id || null) : null;
    if (timer && timer.group_id) {
      // Group name is stored as client_name on the timer
      groupName = timer.client_name || null;
      // Find other pilots in the same group via active_timers
      const otherTimers = await queryAll(
        'SELECT at.pilot_id, p.name FROM active_timers at JOIN pilots p ON at.pilot_id = p.id WHERE at.group_id = ? AND at.pilot_id != ?',
        [timer.group_id, req.pilot.id]
      );
      groupPilots = otherTimers.map(t => ({ id: t.pilot_id, name: t.name }));
    }
    const pr = pilot ? Number(pilot.presence) : 0;
    const presence = Number.isFinite(pr) ? pr : (pilot && Number(pilot.available) === 1 ? 1 : 0);
    // Most recent acknowledged flight for this pilot (so the app can notify in-foreground)
    const latestAck = await queryOne(
      'SELECT id, office_ack_emoji FROM flights WHERE pilot_id = ? AND office_ack_emoji IS NOT NULL ORDER BY landed_at DESC LIMIT 1',
      [req.pilot.id]
    );
    res.json({
      status: timer ? 'airborne' : 'in_office',
      client_name: timer ? timer.client_name : null,
      timer_started_at: timer ? timer.started_at : null,
      timer_expires_at: timer ? timer.expires_at : null,
      current_wing: pilot ? pilot.current_wing : null,
      presence,
      available: presence === 1,
      has_avatar: pilot ? Number(pilot.has_avatar) === 1 : false,
      group_name: groupName,
      group_pilots: groupPilots,
      group_id: groupId,
      latest_ack: latestAck ? { flight_id: latestAck.id, emoji: latestAck.office_ack_emoji } : null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Pilot requests 30-min extension — office must approve
app.post('/api/pilot/request-extension', verifyToken, async (req, res) => {
  try {
    const pilotId = req.pilot.id;
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilotId]);
    if (!timer) return res.status(404).json({ error: 'No active timer' });

    // Only one pending request at a time
    const existing = await queryOne(
      "SELECT id FROM extension_requests WHERE pilot_id = ? AND status = 'pending'", [pilotId]);
    if (existing) return res.status(409).json({ error: 'Request already pending' });

    const id = uuidv4();
    await run(
      "INSERT INTO extension_requests (id, pilot_id, requested_at, status) VALUES (?, ?, ?, 'pending')",
      [id, pilotId, new Date().toISOString()]);

    broadcast({ type: 'EXTENSION_REQUEST', request_id: id, pilot_id: pilotId, pilot_name: req.pilot.name, client_name: timer.client_name });
    res.json({ message: 'Extension request sent', request_id: id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Office approves extension request
app.post('/api/office/approve-extension', verifyOffice, async (req, res) => {
  try {
    const { request_id } = req.body;
    if (!request_id) return res.status(400).json({ error: 'request_id required' });

    const req_ = await queryOne("SELECT * FROM extension_requests WHERE id = ? AND status = 'pending'", [request_id]);
    if (!req_) return res.status(404).json({ error: 'Request not found or already resolved' });

    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [req_.pilot_id]);
    if (!timer) return res.status(404).json({ error: 'No active timer for pilot' });

    const now = new Date().toISOString();
    await run("UPDATE extension_requests SET status = 'approved', responded_at = ? WHERE id = ?", [now, request_id]);

    const newExpiry = new Date(new Date(timer.expires_at).getTime() + 30 * 60 * 1000);
    await run('UPDATE active_timers SET expires_at = ?, notif_10min = 0, notif_5min = 0, notif_expired = 0 WHERE pilot_id = ?',
      [newExpiry.toISOString(), req_.pilot_id]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), req_.pilot_id, 'timer_extended_30min_approved', now]);

    const pilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [req_.pilot_id]);
    await sendPushToPilot(req_.pilot_id, { title: '✅ Extra time approved!', body: '30 minutes added to your timer.', tag: 'extension-approved' });
    broadcast({ type: 'EXTENSION_APPROVED', request_id, pilot_id: req_.pilot_id, pilot_name: pilot?.name, expires_at: newExpiry.toISOString() });

    res.json({ message: 'Extension approved', expires_at: newExpiry.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Office denies extension request
app.post('/api/office/deny-extension', verifyOffice, async (req, res) => {
  try {
    const { request_id } = req.body;
    if (!request_id) return res.status(400).json({ error: 'request_id required' });

    const req_ = await queryOne("SELECT * FROM extension_requests WHERE id = ? AND status = 'pending'", [request_id]);
    if (!req_) return res.status(404).json({ error: 'Request not found or already resolved' });

    const now = new Date().toISOString();
    await run("UPDATE extension_requests SET status = 'denied', responded_at = ? WHERE id = ?", [now, request_id]);

    const pilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [req_.pilot_id]);
    await sendPushToPilot(req_.pilot_id, { title: '❌ Extra time denied', body: 'Your extension request was not approved.', tag: 'extension-denied' });
    broadcast({ type: 'EXTENSION_DENIED', request_id, pilot_id: req_.pilot_id, pilot_name: pilot?.name });

    res.json({ message: 'Extension denied' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Office fetches pending extension requests
app.get('/api/office/pending-extensions', verifyOffice, async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT er.id, er.pilot_id, er.requested_at, p.name AS pilot_name
       FROM extension_requests er JOIN pilots p ON p.id = er.pilot_id
       WHERE er.status = 'pending' ORDER BY er.requested_at ASC`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Flight Routes ────────────────────────────────────────────────────────────
app.post('/api/flights', verifyToken, async (req, res) => {
  try {
    const { date, flight_num, weight, takeoff, landing, time, photos, notes, client_name, wing_reg } = req.body;
    const pilotId = req.pilot.id;

    if (!date || !flight_num || !weight || !takeoff || !landing || !time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // Validate date is a real calendar date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
    const parsedDate = new Date(date + 'T00:00:00Z');
    if (isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    // Validate numeric fields
    const numWeight = Number(weight);
    const numTime = Number(time);
    const numFlightNum = Number(flight_num);
    if (!Number.isFinite(numWeight) || numWeight < 0 || numWeight > 500) {
      return res.status(400).json({ error: 'weight must be a number between 0 and 500' });
    }
    if (!Number.isFinite(numTime) || numTime < 0 || numTime > 1440) {
      return res.status(400).json({ error: 'time must be a non-negative number (minutes)' });
    }
    if (!Number.isInteger(numFlightNum) || numFlightNum < 1 || numFlightNum > 100) {
      return res.status(400).json({ error: 'flight_num must be a positive integer' });
    }

    const timer = await queryOne('SELECT client_name, started_at FROM active_timers WHERE pilot_id = ?', [pilotId]);
    const resolvedClientName = sanitize(client_name || (timer ? timer.client_name : null), 100);
    // Capture sent_away_at from active timer if pilot is currently airborne
    const sentAwayAt = timer ? timer.started_at : null;
    const id = uuidv4();
    const now = new Date().toISOString();
    const cleanNotes = sanitize(notes, 500);
    const cleanWingReg = sanitize(wing_reg, 10);
    const cleanTakeoff = sanitize(takeoff, 100);
    const cleanLanding = sanitize(landing, 100);

    const dup = await queryOne(
      'SELECT id FROM flights WHERE pilot_id = ? AND date = ? AND flight_num = ?',
      [pilotId, date, flight_num]
    );
    if (dup) {
      return res.status(409).json({ error: 'A flight with this date and flight number already exists' });
    }

    if (cleanWingReg) {
      await run('UPDATE pilots SET current_wing = ? WHERE id = ?', [cleanWingReg, pilotId]);
    }

    await run(
      `INSERT INTO flights (id, pilot_id, client_name, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at, wing_reg, sent_away_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, pilotId, resolvedClientName, date, flight_num, weight, cleanTakeoff, cleanLanding, time, photos || 0, cleanNotes || '', now, cleanWingReg || null, sentAwayAt]
    );

    const activeTimer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilotId]);
    if (activeTimer) {
      await run('DELETE FROM active_timers WHERE pilot_id = ?', [pilotId]);
      await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pilotId, 'landed', new Date().toISOString()]);
    }
    // Always notify office when a flight is logged, regardless of whether a timer was active
    broadcast({ type: 'LANDED', pilot_id: pilotId, pilot_name: req.pilot.name, landed_at: now, flight_id: id });

    res.status(201).json({ id, message: 'Flight logged, office notified' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/flights', verifyToken, async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    // Always use the authenticated pilot's own ID — never allow cross-pilot reads
    let sql = `
      SELECT f.*,
        (SELECT GROUP_CONCAT(p.name, ', ')
         FROM flights f2
         JOIN pilots p ON p.id = f2.pilot_id
         WHERE f2.sent_away_at = f.sent_away_at
           AND f2.date = f.date
           AND f2.pilot_id != f.pilot_id
           AND f2.sent_away_at IS NOT NULL
        ) as group_pilot_names
      FROM flights f
      WHERE f.pilot_id = ?`;
    const params = [req.pilot.id];
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (date_from && dateRe.test(date_from)) { sql += ' AND f.date >= ?'; params.push(date_from); }
    if (date_to && dateRe.test(date_to)) { sql += ' AND f.date <= ?'; params.push(date_to); }
    sql += ' ORDER BY f.date DESC, f.flight_num ASC';
    const flights = await queryAll(sql, params);
    res.json(flights);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

app.put('/api/flights/:id', verifyToken, async (req, res) => {
  try {
    const { date, flight_num, weight, takeoff, landing, time, photos, notes, wing_reg } = req.body;
    const { id } = req.params;
    const pilotId = req.pilot.id;
    const existing = await queryOne('SELECT * FROM flights WHERE id = ? AND pilot_id = ?', [id, pilotId]);
    if (!existing) return res.status(404).json({ error: 'Flight not found' });
    await run(
      `UPDATE flights SET date=?, flight_num=?, weight=?, takeoff=?, landing=?, time=?, photos=?, notes=?, wing_reg=? WHERE id=? AND pilot_id=?`,
      [sanitize(date, 10), flight_num, weight, sanitize(takeoff, 10), sanitize(landing, 10), time, photos || 0, sanitize(notes, 500) || '', sanitize(wing_reg, 10), id, pilotId]
    );
    broadcast({ type: 'FLIGHT_UPDATED', pilot_id: pilotId, pilot_name: req.pilot.name, flight_id: id });
    res.json({ id, message: 'Flight updated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update flight' });
  }
});

/** Set wing_reg on flights from from_date onward where wing is still empty (fill-only). */
app.post('/api/pilot/flights/apply-wing-from-date', verifyToken, async (req, res) => {
  try {
    const { wing_reg, from_date } = req.body;
    if (!from_date || !/^\d{4}-\d{2}-\d{2}$/.test(from_date)) {
      return res.status(400).json({ error: 'from_date (YYYY-MM-DD) required' });
    }
    const cleanWing = sanitize(wing_reg, 10);
    if (!cleanWing) return res.status(400).json({ error: 'wing_reg required' });
    const pilotId = req.pilot.id;
    const pending = await queryOne(
      `SELECT COUNT(*) AS c FROM flights WHERE pilot_id = ? AND date >= ? AND (wing_reg IS NULL OR TRIM(wing_reg) = '')`,
      [pilotId, from_date]
    );
    const n = Number(pending?.c) || 0;
    if (n > 0) {
      await run(
        `UPDATE flights SET wing_reg = ? WHERE pilot_id = ? AND date >= ? AND (wing_reg IS NULL OR TRIM(wing_reg) = '')`,
        [cleanWing, pilotId, from_date]
      );
    }
    res.json({ updated: n, wing_reg: cleanWing, from_date });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to apply wing to flights' });
  }
});

app.delete('/api/flights/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const pilotId = req.pilot.id;
    const existing = await queryOne('SELECT * FROM flights WHERE id = ? AND pilot_id = ?', [id, pilotId]);
    if (!existing) return res.status(404).json({ error: 'Flight not found' });
    await run('DELETE FROM flights WHERE id = ? AND pilot_id = ?', [id, pilotId]);
    res.json({ id, message: 'Flight deleted' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Wing Registration ────────────────────────────────────────────────────────
app.put('/api/pilot/wing', verifyToken, async (req, res) => {
  try {
    const { wing_reg } = req.body;
    await run('UPDATE pilots SET current_wing = ? WHERE id = ?', [sanitize(wing_reg, 10) || null, req.pilot.id]);
    res.json({ message: 'Wing updated', wing_reg: wing_reg || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Profile photo (small JPEG/PNG/WebP stored as data URL in DB) ────────────
app.put('/api/pilot/avatar', verifyToken, async (req, res) => {
  try {
    let dataUrl;
    try {
      dataUrl = validateAvatarBody(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Invalid avatar' });
    }
    await run('UPDATE pilots SET avatar_data = ? WHERE id = ?', [dataUrl, req.pilot.id]);
    res.json({ message: dataUrl ? 'Profile photo updated' : 'Profile photo removed', has_avatar: !!dataUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update profile photo' });
  }
});

app.get('/api/pilot/avatar/:pilotId', verifyPilotOrOffice, async (req, res) => {
  try {
    const { pilotId } = req.params;
    // Pilots can only fetch their own avatar; office tokens have unrestricted access
    if (req.pilot && req.pilot.id !== pilotId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // req.office is set for office tokens — intentionally allowed to read any avatar
    const row = await queryOne('SELECT avatar_data FROM pilots WHERE id = ?', [pilotId]);
    if (!row || !row.avatar_data) return res.status(404).json({ error: 'No profile photo' });
    res.json({ avatar: row.avatar_data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load profile photo' });
  }
});

// ─── Push Notifications ──────────────────────────────────────────────────────
async function sendPushToPilot(pilotId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  if (!_pushNotificationsEnabled) return;
  const subs = await queryAll('SELECT id, subscription FROM push_subscriptions WHERE pilot_id = ?', [pilotId]);
  const body = JSON.stringify(payload);
  await Promise.allSettled(subs.map(async (row) => {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription), body);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
      } else {
        console.error('Push send failed:', e.statusCode, e.message);
      }
    }
  }));
}

app.post('/api/pilot/push-subscription', verifyToken, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    // Replace any existing subscription for this pilot (device may re-subscribe)
    await run('DELETE FROM push_subscriptions WHERE pilot_id = ?', [req.pilot.id]);
    await run('INSERT INTO push_subscriptions (id, pilot_id, subscription, created_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), req.pilot.id, JSON.stringify(subscription), new Date().toISOString()]);
    res.json({ message: 'Push subscription saved' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/pilot/push-subscription', verifyToken, async (req, res) => {
  try {
    await run('DELETE FROM push_subscriptions WHERE pilot_id = ?', [req.pilot.id]);
    res.json({ message: 'Push subscription removed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

// ─── Pilot presence (0 signed out, 1 available, 2 down bottom) ───────────────
app.put('/api/pilot/presence', verifyToken, async (req, res) => {
  try {
    let p = req.body.presence;
    if (p === undefined && req.body.available !== undefined) {
      p = req.body.available ? 1 : 0;
    }
    if (p === undefined) return res.status(400).json({ error: 'presence (0–2) or available required' });
    p = Math.floor(Number(p));
    if (![0, 1, 2].includes(p)) return res.status(400).json({ error: 'presence must be 0, 1, or 2' });
    await setPilotPresence(req.pilot.id, p);
    broadcast({ type: 'PRESENCE_UPDATED', pilot_id: req.pilot.id, presence: p });
    if (p === 1) broadcast({ type: 'PILOT_SIGNED_IN', pilot_id: req.pilot.id });
    else if (p === 0) broadcast({ type: 'PILOT_SIGNED_OUT', pilot_id: req.pilot.id });
    else if (p === 2) broadcast({ type: 'PILOT_DOWN_BELOW', pilot_id: req.pilot.id });
    res.json({ message: 'Presence updated', presence: p, available: p === 1 });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/pilot/available', verifyToken, async (req, res) => {
  try {
    const { available } = req.body;
    const p = available ? 1 : 0;
    await setPilotPresence(req.pilot.id, p);
    broadcast({ type: available ? 'PILOT_SIGNED_IN' : 'PILOT_SIGNED_OUT', pilot_id: req.pilot.id });
    broadcast({ type: 'PRESENCE_UPDATED', pilot_id: req.pilot.id, presence: p });
    res.json({ message: 'Availability updated', available: !!available, presence: p });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

/** Suggested duty hours from first sign-in (presence 1 or 2) to last sign-out (presence 0) in NZ calendar day */
app.get('/api/pilot/duty-hours-suggestion', verifyToken, async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date query (YYYY-MM-DD) required' });
    }
    const todayNZ = new Date().toLocaleDateString('en-CA', { timeZone: NZ_TZ });
    const logs = await queryAll(
      `SELECT event, created_at FROM office_logs WHERE pilot_id = ? AND event LIKE 'presence:%' ORDER BY created_at ASC`,
      [req.pilot.id]
    );
    const dayLogs = logs.filter(l => isoToNZDateString(l.created_at) === date);
    let firstIn = null;
    let lastOut = null;
    for (const l of dayLogs) {
      const v = parseInt(String(l.event).split(':')[1], 10);
      if (Number.isNaN(v)) continue;
      const t = new Date(l.created_at).getTime();
      if (v === 1 || v === 2) {
        if (firstIn === null) firstIn = t;
      }
      if (v === 0 && firstIn !== null) {
        lastOut = t;
      }
    }
    if (firstIn === null) {
      return res.json({ suggested_hours: null, date });
    }
    let endMs;
    if (lastOut !== null && lastOut >= firstIn) {
      endMs = lastOut;
    } else if (date === todayNZ) {
      endMs = Date.now();
    } else {
      return res.json({ suggested_hours: null, date });
    }
    const hours = Math.round((endMs - firstIn) / 3600000);
    const suggested = Math.max(0, Math.min(24, hours));
    res.json({ suggested_hours: suggested, date });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Pilot changes their own password ────────────────────────────────────────
app.put('/api/pilot/password', verifyToken, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const rl = checkRateLimit(ip);
  if (rl.blocked) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'current_password and new_password required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    if (new_password.length > 128) return res.status(400).json({ error: 'Password too long' });
    const pilot = await queryOne('SELECT * FROM pilots WHERE id = ?', [req.pilot.id]);
    if (!pilot || !(await bcrypt.compare(current_password, pilot.pin_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    clearRateLimit(ip);
    const newHash = await bcrypt.hash(new_password, 10);
    await run('UPDATE pilots SET pin_hash = ? WHERE id = ?', [newHash, req.pilot.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Password change failed' });
  }
});

// ─── Office: create a new pilot ──────────────────────────────────────────────
app.post('/api/office/pilots', verifyOffice, async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'name and password required' });
    if (name.length > 60) return res.status(400).json({ error: 'Name too long' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (password.length > 128) return res.status(400).json({ error: 'Password too long' });
    const cleanName = sanitize(name, 60);
    const existing = await queryOne('SELECT id FROM pilots WHERE name = ?', [cleanName]);
    if (existing) return res.status(409).json({ error: `A pilot named "${cleanName}" already exists` });
    const id = uuidv4();
    const pinHash = await bcrypt.hash(password, 10);
    await run(
      'INSERT INTO pilots (id, name, pin_hash, created_at, presence) VALUES (?, ?, ?, ?, ?)',
      [id, cleanName, pinHash, new Date().toISOString(), 1]
    );
    res.status(201).json({ id, name: cleanName, message: `Pilot "${cleanName}" created` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create pilot' });
  }
});

// ─── Office: reset a pilot's password ────────────────────────────────────────
app.put('/api/office/pilot-password', verifyOffice, async (req, res) => {
  try {
    const { pilot_id, new_password } = req.body;
    if (!pilot_id || !new_password) return res.status(400).json({ error: 'pilot_id and new_password required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (new_password.length > 128) return res.status(400).json({ error: 'Password too long' });
    const pilot = await queryOne('SELECT id, name FROM pilots WHERE id = ?', [pilot_id]);
    if (!pilot) return res.status(404).json({ error: 'Pilot not found' });
    const newHash = await bcrypt.hash(new_password, 10);
    await run('UPDATE pilots SET pin_hash = ? WHERE id = ?', [newHash, pilot_id]);
    res.json({ message: `Password reset for ${pilot.name}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// ─── Office: Delete Pilot ─────────────────────────────────────────────────────
app.delete('/api/office/pilots/:id', verifyOffice, async (req, res) => {
  try {
    const { id } = req.params;
    const pilot = await queryOne('SELECT id, name FROM pilots WHERE id = ?', [id]);
    if (!pilot) return res.status(404).json({ error: 'Pilot not found' });
    await run('DELETE FROM active_timers WHERE pilot_id = ?', [id]);
    await run('DELETE FROM push_subscriptions WHERE pilot_id = ?', [id]);
    await run('UPDATE loop_board SET pilot_id = NULL, pilot_name = NULL WHERE pilot_id = ?', [id]);
    await run('UPDATE loop_board_v2 SET pilot_id = NULL, pilot_name = NULL, done = 0 WHERE pilot_id = ?', [id]);
    await run('DELETE FROM pilots WHERE id = ?', [id]);
    broadcast({ type: 'PILOT_DELETED', pilot_id: id, pilot_name: pilot.name });
    res.json({ ok: true, pilot_name: pilot.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});



// ─── Pilot lands another pilot in the same group ──────────────────────────────
app.post('/api/pilot/land-group-member', verifyToken, async (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    const myTimer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [req.pilot.id]);
    if (!myTimer || !myTimer.group_id) return res.status(403).json({ error: 'Not in an active group' });
    const targetTimer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ? AND group_id = ?', [pilot_id, myTimer.group_id]);
    if (!targetTimer) return res.status(404).json({ error: 'Pilot not found in your group' });
    const pilot = await queryOne('SELECT * FROM pilots WHERE id = ?', [pilot_id]);
    if (!pilot) return res.status(404).json({ error: 'Pilot not found' });
    const now = new Date().toISOString();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: NZ_TZ });
    const flightId = uuidv4();
    const todayCount = await queryOne('SELECT COUNT(*) as c FROM flights WHERE pilot_id = ? AND date = ?', [pilot_id, today]);
    const flightNum = (Number(todayCount?.c) || 0) + 1;
    const pilotRec = await queryOne('SELECT current_wing FROM pilots WHERE id = ?', [pilot_id]);
    await run(
      `INSERT INTO flights (id, pilot_id, client_name, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at, sent_away_at, wing_reg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [flightId, pilot_id, targetTimer.client_name || '', today, flightNum,
       0, '', '', 0, 0, 'PENDING_PILOT_FILL', now, targetTimer.started_at || null, pilotRec?.current_wing || null]
    );
    await run('DELETE FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), pilot_id, 'landed_by_group_member', now]);
    broadcast({ type: 'LANDED_EARLY', pilot_id, pilot_name: pilot.name, landed_at: now, flight_id: flightId });
    res.json({ flight_id: flightId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── Did Not Fly — pilot cancels their own timer without logging a flight ─────
app.post('/api/pilot/cancel-timer', verifyToken, async (req, res) => {
  try {
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [req.pilot.id]);
    if (!timer) return res.status(404).json({ error: 'No active timer' });
    await run('DELETE FROM active_timers WHERE pilot_id = ?', [req.pilot.id]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), req.pilot.id, 'did_not_fly', new Date().toISOString()]);
    broadcast({ type: 'DID_NOT_FLY', pilot_id: req.pilot.id, pilot_name: req.pilot.name });
    res.json({ message: 'Timer cancelled — marked as did not fly' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Pilot self-reports landing — clears timer, creates pending flight record ──
app.post('/api/pilot/land', verifyToken, async (req, res) => {
  try {
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [req.pilot.id]);
    if (!timer) return res.status(404).json({ error: 'No active timer' });

    const now = new Date().toISOString();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: NZ_TZ });
    const flightId = uuidv4();

    const todayCount = await queryOne(
      'SELECT COUNT(*) as c FROM flights WHERE pilot_id = ? AND date = ?',
      [req.pilot.id, today]
    );
    const flightNum = (Number(todayCount?.c) || 0) + 1;

    const pilotRec = await queryOne('SELECT current_wing FROM pilots WHERE id = ?', [req.pilot.id]);

    await run(
      `INSERT INTO flights (id, pilot_id, client_name, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at, sent_away_at, wing_reg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [flightId, req.pilot.id, timer.client_name || '', today, flightNum,
       0, '', '', 0, 0, 'PENDING_PILOT_FILL', now, timer.started_at || null, pilotRec?.current_wing || null]
    );

    await run('DELETE FROM active_timers WHERE pilot_id = ?', [req.pilot.id]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), req.pilot.id, 'pilot_landed', now]);

    broadcast({ type: 'LANDED_EARLY', pilot_id: req.pilot.id, pilot_name: req.pilot.name, landed_at: now, flight_id: flightId });

    res.json({ flight_id: flightId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Daily Hours Worked — stored on last flight of the day ───────────────────
app.put('/api/pilot/hours', verifyToken, async (req, res) => {
  const { date, hours } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    // Find the last flight for this pilot on this date (highest flight_num)
    const flight = await queryOne(
      'SELECT id FROM flights WHERE pilot_id = ? AND date = ? ORDER BY flight_num DESC, created_at DESC LIMIT 1',
      [req.pilot.id, date]
    );
    if (!flight) return res.status(404).json({ error: 'No flights on this date' });
    const h = hours !== null && hours !== '' ? parseFloat(hours) : null;
    await run('UPDATE flights SET hours_worked = ? WHERE id = ?', [h, flight.id]);
    res.json({ message: 'Hours updated', flight_id: flight.id, hours: h });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Drives ───────────────────────────────────────────────────────────────────
app.get('/api/drives', verifyToken, async (req, res) => {
  try {
    const drives = await queryAll(
      'SELECT * FROM drives WHERE pilot_id = ? ORDER BY date DESC, created_at DESC',
      [req.pilot.id]
    );
    res.json(drives);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/drives', verifyToken, async (req, res) => {
  try {
    const { date, notes, group_id } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    const id = uuidv4();
    const now = new Date().toISOString();
    await run(
      'INSERT INTO drives (id, pilot_id, date, notes, group_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.pilot.id, date, notes || '', group_id || null, now]
    );
    // Clear active timer — pilot is back in office after the drive
    const activeTimer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [req.pilot.id]);
    if (activeTimer) {
      await run('DELETE FROM active_timers WHERE pilot_id = ?', [req.pilot.id]);
      await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), req.pilot.id, 'drive_logged', new Date().toISOString()]);
      broadcast({ type: 'LANDED', pilot_id: req.pilot.id, pilot_name: req.pilot.name, landed_at: now });
    }
    res.status(201).json({ id, message: 'Drive logged' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/drives/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await queryOne('SELECT * FROM drives WHERE id = ? AND pilot_id = ?', [id, req.pilot.id]);
    if (!existing) return res.status(404).json({ error: 'Drive not found' });
    await run('DELETE FROM drives WHERE id = ? AND pilot_id = ?', [id, req.pilot.id]);
    res.json({ message: 'Drive deleted' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Who's Flying (pilot-facing) ─────────────────────────────────────────────
app.get('/api/flying', verifyToken, async (req, res) => {
  try {
    const rows = await queryAll(`
      SELECT p.name, at.client_name, at.started_at, at.expires_at, at.group_id
      FROM active_timers at
      JOIN pilots p ON at.pilot_id = p.id
      ORDER BY at.started_at ASC
    `);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Today's Flights (pilot-facing) ──────────────────────────────────────────
app.get('/api/today-flights', verifyToken, async (req, res) => {
  try {
    const today = nzToday();
    const flights = await queryAll(`
      SELECT f.id, f.pilot_id, f.flight_num, f.date, f.landed_at, f.sent_away_at, f.client_name,
             p.name AS pilot_name
      FROM flights f
      JOIN pilots p ON f.pilot_id = p.id
      WHERE f.date = ?
      ORDER BY f.sent_away_at ASC, f.flight_num ASC
    `, [today]);
    res.json(flights);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Flight Following ─────────────────────────────────────────────────────────
app.get('/api/flight-following', verifyToken, async (req, res) => {
  try {
    const dates = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }));
    }
    const from = dates[0];

    const pilots = await queryAll('SELECT id, name FROM pilots ORDER BY name');
    const flightCounts = await queryAll(
      'SELECT pilot_id, date, COUNT(*) as cnt FROM flights WHERE date >= ? GROUP BY pilot_id, date',
      [from]
    );
    const overrides = await queryAll(
      'SELECT pilot_id, date, count FROM duty_sheet_overrides WHERE date >= ? AND date <= ?',
      [from, dates[dates.length - 1]]
    );

    const flightMap = {};
    flightCounts.forEach(row => {
      if (!flightMap[row.pilot_id]) flightMap[row.pilot_id] = {};
      flightMap[row.pilot_id][row.date] = Number(row.cnt);
    });

    const result = pilots.map(p => {
      const dayCounts = {};
      let daysWorked = 0;
      dates.forEach(d => {
        const ov = overrides.find(o => String(o.pilot_id) === String(p.id) && o.date === d);
        const cnt = ov !== undefined ? (ov.count || 0) : ((flightMap[p.id] && flightMap[p.id][d]) || 0);
        if (cnt > 0) { dayCounts[d] = cnt; daysWorked++; }
      });
      return { id: p.id, name: p.name, dayCounts, daysWorked };
    });

    res.json({ dates, pilots: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Office Routes ────────────────────────────────────────────────────────────
app.post('/api/office/leave', verifyOffice, async (req, res) => {
  try {
    const { pilot_id, client_name } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    const pilot = await queryOne('SELECT * FROM pilots WHERE id = ?', [pilot_id]);
    if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60 * 1000);
    const cleanClientName = sanitize(client_name, 100);

    await run('INSERT OR REPLACE INTO active_timers (pilot_id, client_name, started_at, expires_at) VALUES (?, ?, ?, ?)',
      [pilot_id, cleanClientName || null, now.toISOString(), expires.toISOString()]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pilot_id, 'left_office', new Date().toISOString()]);

    broadcast({
      type: 'LEFT_OFFICE',
      pilot_id,
      pilot_name: pilot.name,
      client_name: cleanClientName || null,
      started_at: now.toISOString(),
      expires_at: expires.toISOString()
    });

    // Push notification to pilot's device (works even when app is closed)
    await sendPushToPilot(pilot_id, {
      title: '🪂 GForce — YOU\'RE AWAY!',
      body: cleanClientName ? `Client: ${cleanClientName}. Timer started — 60 minutes.` : 'Office has started your timer. Have a great flight!',
      tag: 'pilot-sent-away'
    });

    res.json({ message: `Timer started for ${pilot.name}`, expires_at: expires.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/office/group-leave', verifyOffice, async (req, res) => {
  try {
    const { group_name, pilot_ids, pilot_nums, is_peak_trip } = req.body;
    if (!Array.isArray(pilot_ids) || !pilot_ids.length) return res.status(400).json({ error: 'pilot_ids required' });

    const now = new Date();
    const duration = is_peak_trip ? 120 : 60; // peak trips get 2 hours, standard 1 hour
    const expires = new Date(now.getTime() + duration * 60 * 1000);
    const groupId = uuidv4();

    const pilotNames = [];
    const pilotMap = []; // { id, name } for push after all names known
    const cleanedPilotNums = {};
    for (const pid of pilot_ids) {
      const pilot = await queryOne('SELECT * FROM pilots WHERE id = ?', [pid]);
      if (!pilot) continue;
      const clientName = pilot_nums ? (sanitize(pilot_nums[pid], 20) || null) : (group_name || null);
      cleanedPilotNums[pid] = clientName;
      await run('INSERT OR REPLACE INTO active_timers (pilot_id, client_name, started_at, expires_at, group_id) VALUES (?, ?, ?, ?, ?)',
        [pid, clientName, now.toISOString(), expires.toISOString(), groupId]);
      await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pid, 'group_left_office', new Date().toISOString()]);
      pilotNames.push(pilot.name);
      pilotMap.push({ id: pid, name: pilot.name });
    }
    // Push notification to each pilot in parallel — tells them who else is in the group
    await Promise.all(pilotMap.map(p => {
      const others = pilotNames.filter(n => n !== p.name);
      const body = others.length
        ? `Flying with ${others.join(', ')} — ${duration} min timer started.`
        : `Timer started — ${duration} minutes.`;
      return sendPushToPilot(p.id, {
        title: `🪂 GForce — YOU'RE AWAY!`,
        body,
        tag: 'pilot-sent-away'
      });
    }));

    broadcast({
      type: 'GROUP_LEFT_OFFICE',
      group_id: groupId,
      group_name,
      pilot_ids,
      pilot_names: pilotNames,
      pilot_nums: cleanedPilotNums,
      started_at: now.toISOString(),
      expires_at: expires.toISOString(),
      is_peak_trip: !!is_peak_trip
    });

    res.json({ message: `Group "${group_name}" sent away — ${pilotNames.join(', ')}`, group_id: groupId, expires_at: expires.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Office Add Pilot to Existing Group ─────────────────────────────────────
app.post('/api/office/add-to-group', verifyOffice, async (req, res) => {
  try {
    const { pilot_id, group_id, client_name } = req.body;
    if (!pilot_id || !group_id) return res.status(400).json({ error: 'pilot_id and group_id required' });
    // Find the group's active timer
    const groupTimer = await queryOne('SELECT * FROM active_timers WHERE group_id = ? LIMIT 1', [group_id]);
    if (!groupTimer) return res.status(404).json({ error: 'No active group with that ID' });
    // Get pilot info
    const pilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [pilot_id]);
    if (!pilot) return res.status(404).json({ error: 'Pilot not found' });
    // Add pilot with their own fresh timer starting from now, using their individual flight #
    const now = new Date();
    const newExpires = new Date(now.getTime() + 60 * 60 * 1000);
    const pilotClientName = client_name != null ? sanitize(String(client_name), 100) : groupTimer.client_name;
    await run('INSERT OR REPLACE INTO active_timers (pilot_id, client_name, started_at, expires_at, group_id, office_adjustments) VALUES (?, ?, ?, ?, ?, ?)',
      [pilot_id, pilotClientName, now.toISOString(), newExpires.toISOString(), group_id, 0]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pilot_id, 'added_to_group', now.toISOString()]);
    broadcast({ type: 'PILOT_ADDED_TO_GROUP', pilot_id, pilot_name: pilot.name, group_id, group_name: groupTimer.client_name, expires_at: newExpires.toISOString() });
    await sendPushToPilot(pilot_id, {
      title: '🪂 GForce — YOU\'RE AWAY!',
      body: groupTimer.client_name ? `Added to group: ${groupTimer.client_name}. Timer started — 60 minutes.` : 'Office has added you to a group. Timer started — 60 minutes.',
      tag: 'pilot-sent-away'
    });
    res.json({ message: `${pilot.name} added to group`, expires_at: newExpires.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Office Convert Solo to Group ───────────────────────────────────────────
app.post('/api/office/convert-to-group', verifyOffice, async (req, res) => {
  try {
    const { solo_pilot_id, new_pilot_id, client_name } = req.body;
    if (!solo_pilot_id || !new_pilot_id) return res.status(400).json({ error: 'solo_pilot_id and new_pilot_id required' });

    const soloTimer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [solo_pilot_id]);
    if (!soloTimer) return res.status(404).json({ error: 'No active timer for solo pilot' });
    if (soloTimer.group_id) return res.status(400).json({ error: 'Pilot is already in a group' });

    const newPilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [new_pilot_id]);
    if (!newPilot) return res.status(404).json({ error: 'New pilot not found' });

    const groupId = uuidv4();
    const now = new Date();
    const newExpires = new Date(now.getTime() + 60 * 60 * 1000);
    const groupClientName = soloTimer.client_name || null;
    const pilotClientName = client_name != null ? sanitize(String(client_name), 100) : groupClientName;

    // Assign group_id to the existing solo timer
    await run('UPDATE active_timers SET group_id = ? WHERE pilot_id = ?', [groupId, solo_pilot_id]);
    // Add the new pilot with a fresh 60-min timer in the same group
    await run('INSERT OR REPLACE INTO active_timers (pilot_id, client_name, started_at, expires_at, group_id, office_adjustments) VALUES (?, ?, ?, ?, ?, ?)',
      [new_pilot_id, pilotClientName, now.toISOString(), newExpires.toISOString(), groupId, 0]);

    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), solo_pilot_id, 'converted_to_group', now.toISOString()]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), new_pilot_id, 'added_to_group', now.toISOString()]);

    broadcast({ type: 'PILOT_ADDED_TO_GROUP', pilot_id: new_pilot_id, pilot_name: newPilot.name, group_id: groupId, group_name: groupClientName, expires_at: newExpires.toISOString() });
    await sendPushToPilot(new_pilot_id, {
      title: '🪂 GForce — YOU\'RE AWAY!',
      body: groupClientName ? `Added to group: ${groupClientName}. Timer started — 60 minutes.` : 'Office has added you to a group. Timer started — 60 minutes.',
      tag: 'pilot-sent-away'
    });

    const soloPilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [solo_pilot_id]);
    res.json({ message: `Group created: ${soloPilot?.name} + ${newPilot.name}`, group_id: groupId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Office Land Pilot (manual landing via office button) ──────────────────
app.post('/api/office/land-pilot', verifyOffice, async (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    if (!timer) return res.status(404).json({ error: 'No active timer for this pilot' });

    const now = new Date().toISOString();
    const flightId = uuidv4();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: NZ_TZ });

    const todayFlights = await queryAll('SELECT COUNT(*) as c FROM flights WHERE pilot_id = ? AND date = ?', [pilot_id, today]);
    const flightNum = (Number(todayFlights?.[0]?.c) || 0) + 1;

    const pilotRec = await queryOne('SELECT current_wing FROM pilots WHERE id = ?', [pilot_id]);
    const adjustments = Number(timer.office_adjustments || 0);
    let note = 'PENDING_PILOT_FILL';
    if (adjustments !== 0) {
      note = adjustments > 0
        ? `PENDING_PILOT_FILL — office added ${adjustments} min to timer`
        : `PENDING_PILOT_FILL — office removed ${Math.abs(adjustments)} min from timer`;
    }

    await run(
      `INSERT INTO flights (id, pilot_id, client_name, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at, sent_away_at, wing_reg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [flightId, pilot_id, timer.client_name || '', today, flightNum, 0, '', '', 0, 0, note, now, timer.started_at || null, pilotRec?.current_wing || null]
    );

    await run('DELETE FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pilot_id, 'office_landed', now]);

    const pilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [pilot_id]);
    if (!pilot) return res.status(404).json({ error: 'Pilot not found' });
    broadcast({ type: 'LANDED_EARLY', pilot_id, pilot_name: pilot.name, landed_at: now, flight_id: flightId });

    res.json({ message: 'Pilot landed and flight logged', flight_id: flightId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Office cancel timer — removes the active timer without logging any flight
app.post('/api/office/cancel-timer', verifyOffice, async (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    if (!timer) return res.status(404).json({ error: 'No active timer for this pilot' });
    await run('DELETE FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), pilot_id, 'office_cancelled_timer', new Date().toISOString()]);
    const pilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [pilot_id]);
    broadcast({ type: 'DID_NOT_FLY', pilot_id, pilot_name: pilot?.name });
    res.json({ message: 'Timer cancelled — no flight logged' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/office/landed-early', verifyOffice, async (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    if (!timer) return res.status(404).json({ error: 'No active timer for this pilot' });

    const now = new Date().toISOString();
    const flightId = uuidv4();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: NZ_TZ });

    const todayFlights = await queryAll('SELECT COUNT(*) as c FROM flights WHERE pilot_id = ? AND date = ?', [pilot_id, today]);
    const flightNum = (Number(todayFlights?.[0]?.c) || 0) + 1;

    const pilotRec = await queryOne('SELECT current_wing FROM pilots WHERE id = ?', [pilot_id]);
    const adjustments = Number(timer.office_adjustments || 0);
    let note = 'Office landed pilot';
    if (adjustments !== 0) {
      note = adjustments > 0
        ? `Office landed pilot — added ${adjustments} minutes`
        : `Office landed pilot — removed ${Math.abs(adjustments)} minutes`;
    }

    await run(
      `INSERT INTO flights (id, pilot_id, client_name, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at, sent_away_at, wing_reg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [flightId, pilot_id, timer.client_name || '', today, flightNum, 0, '', '', 0, 0, note, now, timer.started_at || null, pilotRec?.current_wing || null]
    );

    await run('DELETE FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pilot_id, 'landed_early', now]);

    const pilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [pilot_id]);
    if (!pilot) return res.status(404).json({ error: 'Pilot not found' });
    broadcast({ type: 'LANDED_EARLY', pilot_id, pilot_name: pilot.name, landed_at: now, flight_id: flightId });

    res.json({ message: 'Timer cancelled and flight logged', flight_id: flightId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/office/adjust-timer', verifyOffice, async (req, res) => {
  try {
    const { pilot_id, delta } = req.body;
    if (!pilot_id || delta === undefined) return res.status(400).json({ error: 'pilot_id and delta required' });
    const clampedDelta = Math.max(-120, Math.min(120, Number(delta)));
    if (!Number.isFinite(clampedDelta)) return res.status(400).json({ error: 'delta must be a number' });
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    if (!timer) return res.status(404).json({ error: 'No active timer for this pilot' });
    const deltaMs = clampedDelta * 60 * 1000;
    const newExpiry = new Date(new Date(timer.expires_at).getTime() + deltaMs);
    if (newExpiry <= new Date()) return res.status(400).json({ error: 'New time must be in the future' });
    const currentAdjustments = Number(timer.office_adjustments || 0);
    await run('UPDATE active_timers SET expires_at = ?, office_adjustments = ? WHERE pilot_id = ?', [newExpiry.toISOString(), currentAdjustments + clampedDelta, pilot_id]);
    const pilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [pilot_id]);
    if (!pilot) return res.status(404).json({ error: 'Pilot not found' });
    broadcast({ type: 'TIMER_ADJUSTED', pilot_id, pilot_name: pilot.name, expires_at: newExpiry.toISOString() });
    res.json({ message: `Timer ${clampedDelta > 0 ? 'added' : 'removed'} ${Math.abs(clampedDelta)} min`, expires_at: newExpiry.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/office/extend', verifyOffice, async (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    if (!timer) return res.status(404).json({ error: 'No active timer for this pilot' });

    const newExpiry = new Date(new Date(timer.expires_at).getTime() + 30 * 60 * 1000);
    await run('UPDATE active_timers SET expires_at = ? WHERE pilot_id = ?', [newExpiry.toISOString(), pilot_id]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pilot_id, 'timer_extended_30min', new Date().toISOString()]);

    const pilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [pilot_id]);
    broadcast({
      type: 'TIMER_EXTENDED',
      pilot_id,
      pilot_name: pilot.name,
      client_name: timer.client_name,
      started_at: timer.started_at,
      expires_at: newExpiry.toISOString()
    });

    res.json({ message: `Timer extended by 30 minutes for ${pilot.name}`, expires_at: newExpiry.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Office: pending landing acknowledgments ──────────────────────────────────
app.get('/api/office/pending-acks', verifyOffice, async (req, res) => {
  try {
    // Flights logged in the last 24 hours with no office acknowledgment
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await queryAll(
      `SELECT f.id AS flight_id, f.pilot_id, p.name AS pilot_name, f.landed_at
       FROM flights f
       JOIN pilots p ON f.pilot_id = p.id
       WHERE f.landed_at >= ? AND (f.office_ack_emoji IS NULL OR f.office_ack_emoji = '')
       ORDER BY f.landed_at DESC`,
      [since]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/office/flights', verifyOffice, async (req, res) => {
  try {
    const flights = await queryAll(`
      SELECT f.*, p.name as pilot_name
      FROM flights f
      JOIN pilots p ON f.pilot_id = p.id
      ORDER BY f.date DESC, f.flight_num ASC
    `);
    res.json(flights);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Download exports (token accepted via query param for browser navigation) ──
async function verifyOfficeQuery(req, res, next) {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).send('No token');
  try {
    const office = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (office.type !== 'office') return res.status(403).send('Not office');
    if (office.tv !== _officeTv) {
      try {
        const tvRow = await queryOne("SELECT value FROM app_settings WHERE key = 'office_token_version'");
        const dbTv = tvRow ? parseInt(tvRow.value || '0', 10) : 0;
        if (office.tv === dbTv) { _officeTv = dbTv; } else { return res.status(401).send('Session invalidated'); }
      } catch { return res.status(401).send('Session invalidated'); }
    }
    req.office = office;
    next();
  } catch { return res.status(401).send('Invalid token'); }
}

function csvRow(cells) {
  return cells.map(c => {
    const s = String(c ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(',');
}

app.get('/api/office/export/loop-board', verifyOfficeQuery, async (req, res) => {
  try {
    const date = req.query.date || nzToday();
    const board = await queryAll('SELECT slot, pilot_name, tallies FROM loop_board_v2 WHERE date = ? ORDER BY slot ASC', [date]);
    const completed = await queryAll('SELECT slot, pilot_name, tallies FROM loop_board_completed WHERE date = ? ORDER BY completed_at ASC', [date]);
    const colNums = ['1','2','3','4','5','6','7','8','9','10','11','12'];
    const header = ['Slot','Pilot',...colNums];
    const lines = [
      `Loop Board (${date})`,
      csvRow(header),
    ];
    const maxSlot = board.reduce((m, s) => Math.max(m, Number(s.slot)), board.length);
    for (let i = 1; i <= maxSlot; i++) {
      const slot = board.find(s => Number(s.slot) === i) || {};
      let tallies = [];
      try { tallies = JSON.parse(slot.tallies || '[]'); } catch (_) {}
      while (tallies.length < 12) tallies.push('');
      lines.push(csvRow([i, slot.pilot_name || '', ...tallies.slice(0, 12)]));
    }
    if (completed.length) {
      lines.push('');
      lines.push('Completed');
      lines.push(csvRow(header));
      completed.forEach(s => {
        let tallies = [];
        try { tallies = JSON.parse(s.tallies || '[]'); } catch (_) {}
        while (tallies.length < 12) tallies.push('');
        lines.push(csvRow([Number(s.slot), s.pilot_name || '', ...tallies.slice(0, 12)]));
      });
    }
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Loop Board (${date}).csv"`);
    res.send(csv);
  } catch (e) { res.status(500).send('Export failed: ' + e.message); }
});

app.get('/api/office/duty-sheet/overrides', verifyOffice, async (req, res) => {
  try {
    const overrides = await queryAll('SELECT pilot_id, date, count FROM duty_sheet_overrides');
    res.json(overrides);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/office/duty-sheet/override', verifyOffice, async (req, res) => {
  try {
    const { pilot_id, date, count } = req.body;
    if (!pilot_id || !date) return res.status(400).json({ error: 'pilot_id and date required' });
    if (count === null || count === undefined) {
      await run('DELETE FROM duty_sheet_overrides WHERE pilot_id = ? AND date = ?', [String(pilot_id), date]);
    } else {
      await run(
        'INSERT OR REPLACE INTO duty_sheet_overrides (pilot_id, date, count, updated_at) VALUES (?, ?, ?, ?)',
        [String(pilot_id), date, Number(count), new Date().toISOString()]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/office/export/duty-sheet', verifyOfficeQuery, async (req, res) => {
  try {
    const today = nzToday();
    const dates = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today + 'T12:00:00+12:00');
      d.setDate(d.getDate() - i);
      dates.push(d.toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }));
    }
    const pilots = await queryAll('SELECT id, name FROM pilots ORDER BY name');
    const flights = await queryAll(`SELECT pilot_id, date FROM flights WHERE date >= ? AND date <= ?`, [dates[0], dates[dates.length - 1]]);
    const overrides = await queryAll(`SELECT pilot_id, date, count FROM duty_sheet_overrides WHERE date >= ? AND date <= ?`, [dates[0], dates[dates.length - 1]]);
    const dateLabels = dates.map(d => {
      const dt = new Date(d + 'T12:00:00');
      return dt.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
    });
    const header = ['Pilot', ...dateLabels, 'Days Worked', 'Days Left'];
    const lines = [`Duty Sheet (${today})`, csvRow(header)];
    const dailyTotals = new Array(dates.length).fill(0);
    pilots.forEach(p => {
      const dayCounts = dates.map((d, i) => {
        const ov = overrides.find(o => String(o.pilot_id) === String(p.id) && o.date === d);
        const cnt = ov !== undefined ? (ov.count || 0) : flights.filter(f => String(f.pilot_id) === String(p.id) && f.date === d).length;
        if (cnt > 0) dailyTotals[i] += cnt;
        return cnt || '';
      });
      const worked = dayCounts.filter(c => c !== '').length;
      lines.push(csvRow([p.name, ...dayCounts, worked, 14 - worked]));
    });
    lines.push(csvRow(['Total', ...dailyTotals.map(t => t || ''), '', '']));
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Duty Sheet (${today}).csv"`);
    res.send(csv);
  } catch (e) { res.status(500).send('Export failed: ' + e.message); }
});

app.get('/api/export/flights', verifyOffice, async (req, res) => {
  try {
    const { pilot_id } = req.query;
    let flights;
    if (pilot_id) {
      flights = await queryAll(`
        SELECT f.*, p.name as pilot_name FROM flights f
        JOIN pilots p ON f.pilot_id = p.id
        WHERE f.pilot_id = ? ORDER BY f.date, f.flight_num
      `, [pilot_id]);
    } else {
      flights = await queryAll(`
        SELECT f.*, p.name as pilot_name FROM flights f
        JOIN pilots p ON f.pilot_id = p.id
        ORDER BY p.name, f.date, f.flight_num
      `);
    }
    if (!flights.length) return res.status(404).json({ error: 'No flights found' });

    const header = ['Date','Pilot','Client Name','Flight #','Weight (kg)','Takeoff','Landing','Time (min)','Notes'];
    const rows = flights.map(f => [
      f.date, f.pilot_name||'', f.client_name||'', f.flight_num, f.weight,
      f.takeoff, f.landing, f.time, f.notes||''
    ]);
    const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="flights${pilot_id?'_'+pilot_id:'_all'}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Office Acknowledge Landing ───────────────────────────────────────────────
const ALLOWED_ACK_EMOJIS = ['👍', '✅', '🎉', '🤙', '🪂'];
app.post('/api/office/acknowledge-landing', verifyOffice, async (req, res) => {
  try {
    const { flight_id, emoji } = req.body;
    if (!flight_id) return res.status(400).json({ error: 'flight_id required' });
    if (!emoji || !ALLOWED_ACK_EMOJIS.includes(emoji)) {
      return res.status(400).json({ error: 'Invalid emoji' });
    }
    const flight = await queryOne('SELECT id, pilot_id FROM flights WHERE id = ?', [flight_id]);
    if (!flight) return res.status(404).json({ error: 'Flight not found' });
    await run('UPDATE flights SET office_ack_emoji = ?, office_ack_at = ? WHERE id = ?', [emoji, new Date().toISOString(), flight_id]);
    const pilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [flight.pilot_id]);
    await sendPushToPilot(flight.pilot_id, {
      title: `${emoji} Flight confirmed!`,
      body: 'Office has acknowledged your landing.',
      tag: 'office-ack',
      requireInteraction: false
    });
    broadcast({ type: 'LANDING_ACKNOWLEDGED', flight_id, pilot_id: flight.pilot_id, pilot_name: pilot?.name || 'Pilot', emoji });
    res.json({ message: 'Landing acknowledged' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/office/pilot-signout', verifyOffice, async (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    await setPilotPresence(pilot_id, 0);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'PILOT_SIGNED_OUT', pilot_id })); });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'PRESENCE_UPDATED', pilot_id, presence: 0 })); });
    res.json({ message: 'Pilot signed out' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/office/pilot-signin', verifyOffice, async (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    await setPilotPresence(pilot_id, 1);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'PILOT_SIGNED_IN', pilot_id })); });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'PRESENCE_UPDATED', pilot_id, presence: 1 })); });
    res.json({ message: 'Pilot signed in' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── Office: Edit / Delete Flight ────────────────────────────────────────────
app.put('/api/office/flights/:id', verifyOffice, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, flight_num, weight, takeoff, landing, time, notes, client_name, wing_reg } = req.body;
    const existing = await queryOne('SELECT * FROM flights WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Flight not found' });
    await run(
      `UPDATE flights SET date=?, flight_num=?, weight=?, takeoff=?, landing=?, time=?, notes=?, client_name=?, wing_reg=? WHERE id=?`,
      [sanitize(date, 10), flight_num, weight, sanitize(takeoff, 10), sanitize(landing, 10), time, sanitize(notes, 500) || '', sanitize(client_name, 100), sanitize(wing_reg, 10), id]
    );
    res.json({ id, message: 'Flight updated by office' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to update flight' }); }
});

app.delete('/api/office/flights/:id', verifyOffice, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await queryOne('SELECT * FROM flights WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Flight not found' });
    await run('DELETE FROM flights WHERE id = ?', [id]);
    res.json({ id, message: 'Flight deleted by office' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ name: 'GForce API', status: 'running', time: new Date().toISOString() }));

// JSON body too large (e.g. avatar) — return JSON so the client can show a clear message
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Request too large (try a smaller photo)' });
  }
  next(err);
});

// End-of-day pilot sign-out reminders removed — pilots do not want this notification.

// ─── Daily Data Backup ────────────────────────────────────────────────────────
async function pushDailyBackup() {
  try {
    const flights = await queryAll(`
      SELECT f.*, p.name as pilot_name
      FROM flights f JOIN pilots p ON f.pilot_id = p.id
      ORDER BY f.date DESC, f.created_at DESC
    `);
    if (!flights.length) return;

    const headers = ['Date','Pilot','Client','Flight #','Weight (kg)','Takeoff','Landing','Time (min)','Notes','Wing','Sent Away','Pilot Landed','Hours Worked'];
    const rows = flights.map(f => [
      f.date, f.pilot_name||'', f.client_name||'', f.flight_num, f.weight,
      f.takeoff, f.landing, f.time, (f.notes||'').replace(/,/g,''), f.wing_reg||'',
      f.sent_away_at ? new Date(f.sent_away_at).toISOString() : '',
      f.landed_at ? new Date(f.landed_at).toISOString() : '',
      f.hours_worked||''
    ].map(v => `"${v}"`).join(','));
    const csv = [headers.join(','), ...rows].join('\n');

    const NZ_TZ = 'Pacific/Auckland';
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: NZ_TZ });
    const filename = `backups/flights-${dateStr}.csv`;
    const token = process.env.GITHUB_TOKEN;
    if (!token) { console.log('[backup] No GITHUB_TOKEN, skipping'); return; }

    // Never push flight data to the public pilot-app repo. Use a private repo (override with GITHUB_BACKUP_REPO).
    const repo = process.env.GITHUB_BACKUP_REPO || 'brookewhatnall/gforce-flight-data-backups';
    const metaRes = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Authorization: `token ${token}`, 'User-Agent': 'gforce-api' }
    });
    if (metaRes.ok) {
      const meta = await metaRes.json();
      if (meta.private === false) {
        console.error('[backup] Refusing to push: target repo is public. Flight CSV backups must use a private repository (set GITHUB_BACKUP_REPO).');
        return;
      }
    }

    const apiUrl = `https://api.github.com/repos/${repo}/contents/${filename}`;

    // Check for existing file to get SHA
    const existingRes = await fetch(apiUrl, { headers: { Authorization: `token ${token}`, 'User-Agent': 'gforce-api' } });
    const existing = existingRes.ok ? await existingRes.json() : null;

    const body = {
      message: `Daily backup ${dateStr}`,
      content: Buffer.from(csv).toString('base64'),
      ...(existing?.sha ? { sha: existing.sha } : {})
    };

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'gforce-api' },
      body: JSON.stringify(body)
    });

    if (putRes.ok) console.log(`[backup] ✓ Pushed ${flights.length} flights to ${filename}`);
    else console.error('[backup] Failed:', await putRes.text());
  } catch (e) { console.error('[backup] Error:', e.message); }
}

function scheduleDailyBackup() {
  // Run at 2 AM NZ time each day
  const NZ_TZ = 'Pacific/Auckland';
  const now = new Date();
  const nzNow = new Date(now.toLocaleString('en-US', { timeZone: NZ_TZ }));
  const nzHour = nzNow.getHours();
  let msUntil2am;
  if (nzHour < 2) {
    msUntil2am = (2 - nzHour) * 3600000 - nzNow.getMinutes() * 60000 - nzNow.getSeconds() * 1000;
  } else {
    msUntil2am = (26 - nzHour) * 3600000 - nzNow.getMinutes() * 60000 - nzNow.getSeconds() * 1000;
  }
  console.log(`[backup] Next backup in ${Math.round(msUntil2am / 3600000 * 10) / 10}h`);
  setTimeout(async () => {
    await pushDailyBackup();
    setInterval(pushDailyBackup, 24 * 60 * 60 * 1000); // then every 24h
  }, msUntil2am);
}

// ─── Office Settings ──────────────────────────────────────────────────────────
app.get('/api/office/settings', verifyOffice, async (req, res) => {
  res.json({ push_notifications_enabled: _pushNotificationsEnabled });
});

app.put('/api/office/settings/push-notifications', verifyOffice, async (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    _pushNotificationsEnabled = enabled;
    await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('push_notifications_enabled', ?)", [enabled ? 'true' : 'false']);
    console.log(`[settings] Push notifications ${enabled ? 'enabled' : 'disabled'}`);
    broadcast({ type: 'SETTINGS_UPDATE', push_notifications_enabled: enabled });
    res.json({ ok: true, push_notifications_enabled: enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnostic: list all pilots and their push subscription status (office only)
app.get('/api/office/push-diagnostic', verifyOffice, async (req, res) => {
  try {
    const pilots = await queryAll('SELECT id, name FROM pilots ORDER BY name ASC');
    const rows = await Promise.all(pilots.map(async (p) => {
      const subs = await queryAll('SELECT created_at FROM push_subscriptions WHERE pilot_id = ?', [p.id]);
      return { id: p.id, name: p.name, subscriptions: subs.length, last_subscribed: subs[0]?.created_at || null };
    }));
    res.json({
      push_globally_enabled: _pushNotificationsEnabled,
      vapid_configured: !!process.env.VAPID_PUBLIC_KEY,
      pilots: rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send a test push to a specific pilot (office only)
app.post('/api/office/push-test/:pilotId', verifyOffice, async (req, res) => {
  try {
    const { pilotId } = req.params;
    const pilot = await queryOne('SELECT id, name FROM pilots WHERE id = ?', [pilotId]);
    if (!pilot) return res.status(404).json({ error: 'Pilot not found' });
    if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'VAPID not configured on server' });
    if (!_pushNotificationsEnabled) return res.status(503).json({ error: 'Push notifications are disabled in settings' });
    const subs = await queryAll('SELECT id, subscription FROM push_subscriptions WHERE pilot_id = ?', [pilotId]);
    if (!subs.length) return res.status(404).json({ error: `No push subscription found for ${pilot.name}` });
    let sent = 0, failed = 0;
    await Promise.allSettled(subs.map(async (row) => {
      try {
        await webpush.sendNotification(JSON.parse(row.subscription), JSON.stringify({
          title: '🧪 GForce test notification',
          body: `Push notifications are working for ${pilot.name}!`,
          tag: 'push-test'
        }));
        sent++;
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
          failed++;
        } else {
          console.error('Test push failed:', e.statusCode, e.message);
          failed++;
        }
      }
    }));
    res.json({ ok: true, pilot_name: pilot.name, sent, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Pilot Location Tracker ───────────────────────────────────────────────────

// OwnTracks HTTP receiver — no JWT auth, uses per-pilot owntracks_key in query string
app.post('/api/owntracks', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.json({});
    const pilot = await queryOne('SELECT id, name FROM pilots WHERE owntracks_key = ?', [key]);
    if (!pilot) return res.status(403).json({});
    const { lat, lon, acc, _type } = req.body;
    if (_type && _type !== 'location') return res.json({}); // ignore non-location payloads
    if (lat == null || lon == null) return res.json({});
    // Check pilot has consented to location sharing today
    const today = nzToday();
    const consent = await queryOne(
      'SELECT consented FROM pilot_location_consent WHERE pilot_id = ? AND date = ?',
      [pilot.id, today]
    );
    if (!isTrackerActive()) return res.json({}); // tracker disabled or expired for today
    if (!consent || !consent.consented) return res.json({}); // no consent — discard silently
    const updatedAt = new Date().toISOString();
    await run(
      'INSERT OR REPLACE INTO pilot_locations (pilot_id, pilot_name, lat, lng, accuracy, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [pilot.id, pilot.name, lat, lon, acc ?? null, updatedAt]
    );
    res.json({});
  } catch (e) {
    console.error('[owntracks]', e);
    res.status(500).json({});
  }
});

// ─── Coronet Peak Manifests (server-side storage for pilot live view) ────────
app.put('/api/office/coronet-manifest', verifyOffice, async (req, res) => {
  try {
    const { van, data } = req.body;
    if (van !== 1 && van !== 2) return res.status(400).json({ error: 'invalid van' });
    await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
      ['coronet_manifest_van' + van, JSON.stringify(data)]);
    broadcast({ type: 'CORONET_MANIFEST_UPDATE', van, data });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pilot/coronet-manifests', verifyPilotOrOffice, async (req, res) => {
  try {
    const [r1, r2] = await Promise.all([
      queryOne("SELECT value FROM app_settings WHERE key = 'coronet_manifest_van1'"),
      queryOne("SELECT value FROM app_settings WHERE key = 'coronet_manifest_van2'")
    ]);
    res.json({
      van1: r1 ? JSON.parse(r1.value) : null,
      van2: r2 ? JSON.parse(r2.value) : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Coronet Peak Trip Notifications ────────────────────────────────────────
app.post('/api/office/coronet-notify', verifyOffice, async (req, res) => {
  try {
    const { vanLabel, time, assignments, manifest } = req.body;
    // assignments: [{ pilotName, role ('pilot'|'driver'), rowNum }]
    if (!Array.isArray(assignments) || !assignments.length) {
      return res.json({ ok: true, results: [] });
    }
    const results = [];
    for (const a of assignments) {
      if (!a.pilotName) continue;
      const pilot = await queryOne('SELECT id FROM pilots WHERE name = ?', [a.pilotName]);
      if (!pilot) { results.push({ name: a.pilotName, sent: false, reason: 'pilot not found' }); continue; }
      const body = a.role === 'driver'
        ? `You are driving on the ${time} CP trip (${vanLabel})`
        : `You are pilot #${a.rowNum} on the ${time} CP trip (${vanLabel})`;
      await sendPushToPilot(pilot.id, { title: '🏔 Coronet Peak Trip', body, tag: 'coronet-trip' });
      results.push({ name: a.pilotName, sent: true });
    }
    // Log the trip
    const van = vanLabel === 'CP Gforce 1' ? 1 : 2;
    await run(
      'INSERT INTO coronet_trips (id, van, van_label, date, manifest_json, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), van, vanLabel, nzToday(), JSON.stringify(manifest || {}), new Date().toISOString()]
    );
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/office/coronet-trips', verifyOffice, async (req, res) => {
  try {
    const date = req.query.date || nzToday();
    const rows = await queryAll(
      'SELECT id, van, van_label, manifest_json, sent_at, status, van_left_at, flying_started_at, landed_at FROM coronet_trips WHERE date = ? ORDER BY sent_at ASC',
      [date]
    );
    res.json(rows.map(r => ({ ...r, manifest: JSON.parse(r.manifest_json || '{}') })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/office/coronet-trips/:id/status', verifyPilotOrOffice, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // van_left | all_flying | all_landed | van_returned
    const valid = ['van_left', 'all_flying', 'all_landed', 'van_returned'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'invalid status' });
    const now = new Date().toISOString();
    const existing = await queryOne(
      'SELECT van_left_at, flying_started_at FROM coronet_trips WHERE id = ?', [id]
    );
    if (!existing) return res.status(404).json({ error: 'trip not found' });
    const van_left_at     = status === 'van_left'    ? now : (existing.van_left_at     || null);
    const flying_started_at = status === 'all_flying' ? now : (existing.flying_started_at || null);
    const landed_at       = status === 'all_landed'  ? now : null;
    await run(
      'UPDATE coronet_trips SET status = ?, van_left_at = ?, flying_started_at = ?, landed_at = ? WHERE id = ?',
      [status, van_left_at, flying_started_at, landed_at, id]
    );
    broadcast({ type: 'CORONET_TRIP_STATUS', id, status, van_left_at, flying_started_at, landed_at });
    res.json({ ok: true, id, status, van_left_at, flying_started_at, landed_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tracker master switch — enabled state is per-day (NZ time), auto-resets at midnight
app.get('/api/office/tracker-enabled', verifyOffice, (req, res) => {
  res.json({ enabled: isTrackerActive() });
});

app.put('/api/office/tracker-enabled', verifyOffice, async (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    if (enabled) {
      _trackerEnabledDate = nzToday();
      await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('tracker_enabled', ?)", [_trackerEnabledDate]);
    } else {
      _trackerEnabledDate = null;
      await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('tracker_enabled', 'off')");
    }
    res.json({ ok: true, enabled: isTrackerActive() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pilot daily location consent
app.get('/api/pilot/location-consent', verifyToken, async (req, res) => {
  try {
    const today = nzToday();
    const row = await queryOne(
      'SELECT consented FROM pilot_location_consent WHERE pilot_id = ? AND date = ?',
      [req.pilot.id, today]
    );
    res.json({ date: today, answered: !!row, consented: row ? !!row.consented : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Returns the requesting pilot's own stored location
app.get('/api/pilot/my-location', verifyToken, async (req, res) => {
  try {
    const row = await queryOne(
      'SELECT pilot_id, pilot_name, lat, lng, accuracy, updated_at FROM pilot_locations WHERE pilot_id = ?',
      [req.pilot.id]
    );
    res.json(row || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pilot/location-consent', verifyToken, async (req, res) => {
  try {
    const { consented } = req.body;
    if (typeof consented !== 'boolean') return res.status(400).json({ error: 'consented must be boolean' });
    const today = nzToday();
    await run(
      'INSERT OR REPLACE INTO pilot_location_consent (pilot_id, date, consented, consented_at) VALUES (?, ?, ?, ?)',
      [req.pilot.id, today, consented ? 1 : 0, new Date().toISOString()]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Returns pilot locations — only for pilots active on today's loop board (not done)
app.get('/api/office/pilot-locations', verifyOffice, async (req, res) => {
  try {
    const today = nzToday();
    const locations = await queryAll(
      `SELECT pl.pilot_id, pl.pilot_name, pl.lat, pl.lng, pl.accuracy, pl.updated_at
       FROM pilot_locations pl
       INNER JOIN loop_board_v2 lb
         ON lb.pilot_id = pl.pilot_id
        AND lb.date = ?
        AND COALESCE(lb.done, 0) = 0
       ORDER BY pl.updated_at DESC`,
      [today]
    );
    res.json(locations);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Returns each pilot's OwnTracks URL for setup (office only)
app.get('/api/office/owntracks-setup', verifyOffice, async (req, res) => {
  try {
    const pilots = await queryAll('SELECT id, name, owntracks_key FROM pilots ORDER BY name ASC');
    res.json(pilots.map(p => ({
      id: p.id,
      name: p.name,
      url: `https://gforce-api.fly.dev/api/owntracks?key=${p.owntracks_key}`
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Loop Board ───────────────────────────────────────────────────────────────
app.get('/api/pilot/loop-board', verifyPilotOrOffice, async (req, res) => {
  try {
    const date = nzToday();
    await ensureLoopBoardDate(date);
    const board = await queryAll('SELECT slot, pilot_id, pilot_name, tallies, COALESCE(done,0) as done FROM loop_board_v2 WHERE date = ? ORDER BY slot ASC', [date]);
    const completed = await queryAll('SELECT id, pilot_id, pilot_name, completed_at, slot, tallies FROM loop_board_completed WHERE date = ? ORDER BY completed_at ASC', [date]);
    res.json({ board, completed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/office/loop-board', verifyOffice, async (req, res) => {
  try {
    const date = req.query.date || nzToday();
    await ensureLoopBoardDate(date);
    const board = await queryAll('SELECT slot, pilot_id, pilot_name, tallies, COALESCE(done,0) as done FROM loop_board_v2 WHERE date = ? ORDER BY slot ASC', [date]);
    const completed = await queryAll('SELECT id, pilot_id, pilot_name, completed_at, slot, tallies FROM loop_board_completed WHERE date = ? ORDER BY completed_at ASC', [date]);
    const lockRow = await queryOne("SELECT value FROM app_settings WHERE key = ?", [`loop_board_order_${date}`]);
    const locked_order = lockRow ? JSON.parse(lockRow.value) : null;
    res.json({ board, completed, locked_order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lock the current loop board order for a date
app.post('/api/office/loop-board/lock-order', verifyOffice, async (req, res) => {
  try {
    const { date: reqDate } = req.body || {};
    const date = reqDate || nzToday();
    const board = await queryAll(
      'SELECT pilot_id FROM loop_board_v2 WHERE date = ? AND pilot_id IS NOT NULL ORDER BY slot ASC', [date]
    );
    const order = board.map(r => r.pilot_id);
    await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", [`loop_board_order_${date}`, JSON.stringify(order)]);
    console.log(`[loop-board] Order locked for ${date}: ${order.length} pilots`);
    res.json({ ok: true, locked_order: order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unlock / clear the locked order for a date
app.post('/api/office/loop-board/unlock-order', verifyOffice, async (req, res) => {
  try {
    const { date: reqDate } = req.body || {};
    const date = reqDate || nzToday();
    await run("DELETE FROM app_settings WHERE key = ?", [`loop_board_order_${date}`]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/loop-board/slot', verifyOffice, async (req, res) => {
  try {
    const { slot, pilot_id, pilot_name, date: reqDate } = req.body;
    const date = reqDate || nzToday();
    if (!slot || slot < 1 || slot > 20) return res.status(400).json({ error: 'Invalid slot' });
    await ensureLoopBoardDate(date);
    await run(
      'UPDATE loop_board_v2 SET pilot_id = ?, pilot_name = ?, done = 0 WHERE date = ? AND slot = ?',
      [pilot_id || null, pilot_name || null, date, slot]
    );
    const board = await queryAll('SELECT slot, pilot_id, pilot_name, tallies, COALESCE(done,0) as done FROM loop_board_v2 WHERE date = ? ORDER BY slot ASC', [date]);
    broadcast({ type: 'LOOP_BOARD_UPDATE', board, date });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/loop-board/reset', verifyOffice, async (req, res) => {
  try {
    const { date: reqDate } = req.body || {};
    const date = reqDate || nzToday();
    await run('UPDATE loop_board_v2 SET pilot_id = NULL, pilot_name = NULL, tallies = NULL, done = 0 WHERE date = ?', [date]);
    const board = await queryAll('SELECT slot, pilot_id, pilot_name, tallies, COALESCE(done,0) as done FROM loop_board_v2 WHERE date = ? ORDER BY slot ASC', [date]);
    broadcast({ type: 'LOOP_BOARD_UPDATE', board, date });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/loop-board/tally', verifyOffice, async (req, res) => {
  try {
    const { slot, col, value, date: reqDate } = req.body;
    const date = reqDate || nzToday();
    if (!slot || slot < 1 || slot > 20) return res.status(400).json({ error: 'Invalid slot' });
    if (!col || col < 1 || col > 12) return res.status(400).json({ error: 'Invalid column' });
    const allowed = ['', 'I', 'L', 'IF', 'ML'];
    if (!allowed.includes(value || '')) return res.status(400).json({ error: 'Invalid value' });
    await ensureLoopBoardDate(date);
    const row = await queryOne('SELECT tallies FROM loop_board_v2 WHERE date = ? AND slot = ?', [date, slot]);
    if (!row) return res.status(404).json({ error: 'Slot not found' });
    let tallies = Array(12).fill('');
    try { const t = JSON.parse(row.tallies || '[]'); if (Array.isArray(t)) tallies = t; } catch (_) {}
    while (tallies.length < 12) tallies.push('');
    tallies[col - 1] = value || '';
    await run('UPDATE loop_board_v2 SET tallies = ? WHERE date = ? AND slot = ?', [JSON.stringify(tallies), date, slot]);
    const board = await queryAll('SELECT slot, pilot_id, pilot_name, tallies, COALESCE(done,0) as done FROM loop_board_v2 WHERE date = ? ORDER BY slot ASC', [date]);
    broadcast({ type: 'LOOP_BOARD_UPDATE', board, date });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/loop-board/complete', verifyOffice, async (req, res) => {
  try {
    const { slot, date: reqDate } = req.body;
    const date = reqDate || nzToday();
    if (!slot || slot < 1 || slot > 20) return res.status(400).json({ error: 'Invalid slot' });

    const targetRow = await queryOne('SELECT pilot_id, pilot_name, tallies FROM loop_board_v2 WHERE date = ? AND slot = ?', [date, slot]);
    if (!targetRow || !targetRow.pilot_name) return res.status(404).json({ error: 'No pilot in this slot' });

    // Mark pilot as done in-place — they stay in their slot, just greyed on client
    await run('UPDATE loop_board_v2 SET done = 1 WHERE date = ? AND slot = ?', [date, slot]);

    // Record in completed table as a historical log
    await run(
      'INSERT OR REPLACE INTO loop_board_completed (id, date, pilot_id, pilot_name, completed_at, slot, tallies) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), date, targetRow.pilot_id, targetRow.pilot_name, new Date().toISOString(), slot, targetRow.tallies || null]
    );

    const board = await queryAll('SELECT slot, pilot_id, pilot_name, tallies, COALESCE(done,0) as done FROM loop_board_v2 WHERE date = ? ORDER BY slot ASC', [date]);
    broadcast({ type: 'LOOP_BOARD_UPDATE', board, date });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/loop-board/completed-tally', verifyOffice, async (req, res) => {
  try {
    const { id, col, value, date: reqDate } = req.body;
    const date = reqDate || nzToday();
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!col || col < 1 || col > 12) return res.status(400).json({ error: 'Invalid column' });
    const allowed = ['', 'I', 'L', 'IF', 'ML'];
    if (!allowed.includes(value || '')) return res.status(400).json({ error: 'Invalid value' });

    const row = await queryOne('SELECT tallies FROM loop_board_completed WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Completed record not found' });

    let tallies = Array(12).fill('');
    try { const t = JSON.parse(row.tallies || '[]'); if (Array.isArray(t)) tallies = t; } catch (_) {}
    while (tallies.length < 12) tallies.push('');
    tallies[col - 1] = value || '';
    await run('UPDATE loop_board_completed SET tallies = ? WHERE id = ?', [JSON.stringify(tallies), id]);

    const completed = await queryAll('SELECT id, pilot_id, pilot_name, completed_at, slot, tallies FROM loop_board_completed WHERE date = ? ORDER BY completed_at ASC', [date]);
    broadcast({ type: 'LOOP_COMPLETED_UPDATE', completed, date });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/loop-board/uncomplete', verifyOffice, async (req, res) => {
  try {
    const { slot: slotRaw, date: reqDate } = req.body;
    const date = reqDate || nzToday();
    const slot = parseInt(slotRaw, 10);
    if (!slot || slot < 1 || slot > 20) return res.status(400).json({ error: 'Invalid slot' });

    // Clear done flag — pilot stays in their slot, becomes active again
    await run('UPDATE loop_board_v2 SET done = 0 WHERE date = ? AND slot = ?', [date, slot]);

    // Remove matching completed log entry if one exists
    await run('DELETE FROM loop_board_completed WHERE date = ? AND slot = ?', [date, slot]);

    const board = await queryAll('SELECT slot, pilot_id, pilot_name, tallies, COALESCE(done,0) as done FROM loop_board_v2 WHERE date = ? ORDER BY slot ASC', [date]);
    broadcast({ type: 'LOOP_BOARD_UPDATE', board, date });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

scheduleDailyBackup();
// Also run immediately on startup to ensure we have a current backup
setTimeout(pushDailyBackup, 10000);

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await createTables();
  await seedIfNeeded();
  const pushSetting = await queryOne("SELECT value FROM app_settings WHERE key = 'push_notifications_enabled'");
  _pushNotificationsEnabled = pushSetting?.value === 'true';
  console.log(`Push notifications: ${_pushNotificationsEnabled ? 'ENABLED' : 'DISABLED'}`);
  const trackerSetting = await queryOne("SELECT value FROM app_settings WHERE key = 'tracker_enabled'");
  const storedTracker = trackerSetting?.value;
  // Value is an NZ date string (e.g. '2026-08-20') when enabled for that day, or 'off'/'false'/null otherwise
  _trackerEnabledDate = (storedTracker && storedTracker !== 'off' && storedTracker !== 'false' && storedTracker !== 'true') ? storedTracker : null;
  console.log(`Pilot tracker: ${isTrackerActive() ? 'ENABLED' : 'DISABLED'} (date: ${_trackerEnabledDate || 'none'})`);

  // Load office token version (used to invalidate all sessions on password change)
  const tvRow = await queryOne("SELECT value FROM app_settings WHERE key = 'office_token_version'");
  _officeTv = tvRow ? parseInt(tvRow.value || '0', 10) : 0;

  // Load or seed office refresh secret into DB (so it can be rotated in-app)
  const rsRow = await queryOne("SELECT value FROM app_settings WHERE key = 'office_refresh_secret'");
  if (rsRow && rsRow.value) {
    _officeRefreshSecret = rsRow.value;
  } else {
    _officeRefreshSecret = process.env.OFFICE_REFRESH_SECRET;
    await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('office_refresh_secret', ?)", [_officeRefreshSecret]);
  }

  server.listen(PORT, () => console.log(`🚀 GForce API running on port ${PORT}`));
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
