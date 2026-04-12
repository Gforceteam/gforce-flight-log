require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@libsql/client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const webpush = require('web-push');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const OFFICE_PASSWORD = process.env.OFFICE_PASSWORD;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var not set. Set it with: fly secrets set JWT_SECRET=<long-random-string>');
  process.exit(1);
}
if (!OFFICE_PASSWORD) {
  console.error('FATAL: OFFICE_PASSWORD env var not set. Set it with: fly secrets set OFFICE_PASSWORD=<password>');
  process.exit(1);
}

// ─── Security helpers ─────────────────────────────────────────────────────────
// Constant-time string comparison (prevents timing attacks)
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still do a comparison to avoid timing leak on length
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// In-memory rate limiter — 5 failed attempts per IP per 15 minutes on auth routes
const _loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const WINDOW = 15 * 60 * 1000; // 15 min
  const MAX = 5;
  let entry = _loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW };
  }
  entry.count++;
  _loginAttempts.set(ip, entry);
  if (entry.count > MAX) {
    return { blocked: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { blocked: false };
}
function clearRateLimit(ip) { _loginAttempts.delete(ip); }
// Clean up old entries every 30 min to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _loginAttempts) { if (now > e.resetAt) _loginAttempts.delete(ip); }
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
      const remainingMins = remainingMs / 60000;

      // 10-minute warning — send once when remaining is between 5 and 11 minutes
      if (remainingMins > 5 && remainingMins <= 11 && !Number(timer.notif_10min)) {
        const r = await db.execute({
          sql: 'UPDATE active_timers SET notif_10min = 1 WHERE pilot_id = ? AND notif_10min = 0',
          args: [timer.pilot_id]
        });
        if (r.rowsAffected > 0) {
          await sendPushToPilot(timer.pilot_id, {
            title: '⏱ 10 minutes left',
            body: `Start heading back — ${Math.ceil(remainingMins)} min remaining on your timer.`,
            tag: 'timer-10min'
          });
          console.log(`⏱ 10-min push → ${timer.pilot_name}`);
        }
      }

      // 5-minute warning — send once when remaining is between 0 and 5.5 minutes
      if (remainingMins > 0 && remainingMins <= 5.5 && !Number(timer.notif_5min)) {
        const r = await db.execute({
          sql: 'UPDATE active_timers SET notif_5min = 1 WHERE pilot_id = ? AND notif_5min = 0',
          args: [timer.pilot_id]
        });
        if (r.rowsAffected > 0) {
          await sendPushToPilot(timer.pilot_id, {
            title: '🚨 5 minutes left!',
            body: 'Land now — timer almost up.',
            tag: 'timer-5min',
            requireInteraction: true
          });
          console.log(`🚨 5-min push → ${timer.pilot_name}`);
        }
      }

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
    created_at TEXT, last_seen TEXT, current_wing TEXT, available INTEGER DEFAULT 0)`);
  // Add available column to existing DBs that predate this column
  try { await db.execute('ALTER TABLE pilots ADD COLUMN available INTEGER DEFAULT 0'); } catch (_) {}
  await db.execute(`CREATE TABLE IF NOT EXISTS flights (
    id TEXT PRIMARY KEY, pilot_id TEXT, client_name TEXT, date TEXT,
    flight_num INTEGER, weight REAL, takeoff TEXT, landing TEXT,
    time INTEGER, photos REAL, notes TEXT, landed_at TEXT,
    created_at TEXT, wing_reg TEXT, hours_worked REAL)`);
  // Add hours_worked column to existing DBs that predate this column
  try { await db.execute('ALTER TABLE flights ADD COLUMN hours_worked REAL'); } catch (_) {}
  // Add sent_away_at column to existing DBs
  try { await db.execute('ALTER TABLE flights ADD COLUMN sent_away_at TEXT'); } catch (_) {}
  await db.execute(`CREATE TABLE IF NOT EXISTS office_logs (
    id TEXT PRIMARY KEY, pilot_id TEXT, event TEXT, created_at TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS active_timers (
    pilot_id TEXT PRIMARY KEY, client_name TEXT, started_at TEXT, expires_at TEXT, group_id TEXT,
    notif_10min INTEGER DEFAULT 0, notif_5min INTEGER DEFAULT 0, notif_expired INTEGER DEFAULT 0)`);
  // Add notification flag columns to existing DBs
  try { await db.execute('ALTER TABLE active_timers ADD COLUMN notif_10min INTEGER DEFAULT 0'); } catch (_) {}
  try { await db.execute('ALTER TABLE active_timers ADD COLUMN notif_5min INTEGER DEFAULT 0'); } catch (_) {}
  try { await db.execute('ALTER TABLE active_timers ADD COLUMN notif_expired INTEGER DEFAULT 0'); } catch (_) {}
  await db.execute(`CREATE TABLE IF NOT EXISTS drives (
    id TEXT PRIMARY KEY, pilot_id TEXT, date TEXT, notes TEXT, group_id TEXT, created_at TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY, pilot_id TEXT NOT NULL, subscription TEXT NOT NULL, created_at TEXT)`);
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

// ─── Helpers ─────────────────────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    req.pilot = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function verifyOffice(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const office = jwt.verify(auth.slice(7), JWT_SECRET);
    if (office.type !== 'office') return res.status(403).json({ error: 'Not office staff' });
    req.office = office;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ─── Middleware ────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://brookewhatnall.github.io',
  'http://localhost:3000',
  'http://localhost:8080',
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (native apps, curl, Postman)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`Origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '100kb' }));

// ─── Public Routes ────────────────────────────────────────────────────────────
app.get('/api/public/pilots', async (req, res) => {
  try {
    const pilots = await queryAll('SELECT id, name FROM pilots ORDER BY name');
    res.json(pilots);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
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
    if (!pilot || !bcrypt.compareSync(credential, pilot.pin_hash)) {
      return res.status(401).json({ error: 'Invalid name or password' });
    }
    clearRateLimit(ip); // reset on successful login
    const token = jwt.sign({ id: pilot.id, name: pilot.name, type: 'pilot' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, pilot: { id: pilot.id, name: pilot.name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
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
    if (!safeCompare(password, OFFICE_PASSWORD)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    clearRateLimit(ip);
    const token = jwt.sign({ type: 'office' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── Pilot Routes ─────────────────────────────────────────────────────────────
app.get('/api/pilots', verifyToken, async (req, res) => {
  try {
    const pilots = await queryAll('SELECT id, name, last_seen, current_wing, available FROM pilots ORDER BY name');
    const timers = await queryAll('SELECT * FROM active_timers');
    const lastLanded = await queryAll('SELECT pilot_id, MAX(landed_at) as last_landed FROM flights WHERE landed_at IS NOT NULL GROUP BY pilot_id');

    const pilotsWithStatus = pilots.map(p => {
      const timer = timers.find(t => t.pilot_id === p.id);
      const lastL = lastLanded.find(f => f.pilot_id === p.id);
      return {
        ...p,
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
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/my-status', verifyToken, async (req, res) => {
  try {
    await run('UPDATE pilots SET last_seen = ? WHERE id = ?', [new Date().toISOString(), req.pilot.id]);
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [req.pilot.id]);
    const pilot = await queryOne('SELECT current_wing, available FROM pilots WHERE id = ?', [req.pilot.id]);
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
      groupPilots = otherTimers.map(t => t.name);
    }
    res.json({
      status: timer ? 'airborne' : 'in_office',
      client_name: timer ? timer.client_name : null,
      timer_started_at: timer ? timer.started_at : null,
      timer_expires_at: timer ? timer.expires_at : null,
      current_wing: pilot ? pilot.current_wing : null,
      available: pilot ? (Number(pilot.available) === 1) : false,
      group_name: groupName,
      group_pilots: groupPilots,
      group_id: groupId
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pilot/extend-timer', verifyToken, async (req, res) => {
  try {
    const pilotId = req.pilot.id;
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilotId]);
    if (!timer) return res.status(404).json({ error: 'No active timer' });

    const newExpiry = new Date(new Date(timer.expires_at).getTime() + 30 * 60 * 1000);
    await run('UPDATE active_timers SET expires_at = ?, notif_10min = 0, notif_5min = 0, notif_expired = 0 WHERE pilot_id = ?', [newExpiry.toISOString(), pilotId]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pilotId, 'timer_extended_30min', new Date().toISOString()]);

    broadcast({
      type: 'TIMER_EXTENDED',
      pilot_id: pilotId,
      pilot_name: req.pilot.name,
      client_name: timer.client_name,
      started_at: timer.started_at,
      expires_at: newExpiry.toISOString()
    });

    res.json({ message: 'Timer extended', expires_at: newExpiry.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
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
    // Basic date format check
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });

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
      broadcast({ type: 'LANDED', pilot_id: pilotId, pilot_name: req.pilot.name, landed_at: now, flight_id: id });
    }

    res.status(201).json({ id, message: 'Flight logged, office notified' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/flights', verifyToken, async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    // Always use the authenticated pilot's own ID — never allow cross-pilot reads
    let sql = 'SELECT * FROM flights WHERE pilot_id = ?';
    const params = [req.pilot.id];
    if (date_from) { sql += ' AND date >= ?'; params.push(date_from); }
    if (date_to) { sql += ' AND date <= ?'; params.push(date_to); }
    sql += ' ORDER BY date DESC, flight_num ASC';
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
      [date, flight_num, weight, takeoff, landing, time, photos || 0, notes || '', wing_reg || null, id, pilotId]
    );
    res.json({ id, message: 'Flight updated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

// ─── Wing Registration ────────────────────────────────────────────────────────
app.put('/api/pilot/wing', verifyToken, async (req, res) => {
  try {
    const { wing_reg } = req.body;
    await run('UPDATE pilots SET current_wing = ? WHERE id = ?', [wing_reg || null, req.pilot.id]);
    res.json({ message: 'Wing updated', wing_reg: wing_reg || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Push Notifications ──────────────────────────────────────────────────────
async function sendPushToPilot(pilotId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const subs = await queryAll('SELECT id, subscription FROM push_subscriptions WHERE pilot_id = ?', [pilotId]);
  for (const row of subs) {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription), JSON.stringify(payload));
    } catch (e) {
      // 410 Gone / 404 = subscription expired, clean it up
      if (e.statusCode === 410 || e.statusCode === 404) {
        await run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
      } else {
        console.error('Push send failed:', e.statusCode, e.message);
      }
    }
  }
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
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/pilot/push-subscription', verifyToken, async (req, res) => {
  try {
    await run('DELETE FROM push_subscriptions WHERE pilot_id = ?', [req.pilot.id]);
    res.json({ message: 'Push subscription removed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

// ─── Pilot Availability ──────────────────────────────────────────────────────
app.put('/api/pilot/available', verifyToken, async (req, res) => {
  try {
    const { available } = req.body;
    await run('UPDATE pilots SET available = ? WHERE id = ?', [available ? 1 : 0, req.pilot.id]);
    res.json({ message: 'Availability updated', available: !!available });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
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
    if (!pilot || !bcrypt.compareSync(current_password, pilot.pin_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    clearRateLimit(ip);
    const newHash = bcrypt.hashSync(new_password, 10);
    await run('UPDATE pilots SET pin_hash = ? WHERE id = ?', [newHash, req.pilot.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Password change failed' });
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
    const newHash = bcrypt.hashSync(new_password, 10);
    await run('UPDATE pilots SET pin_hash = ? WHERE id = ?', [newHash, pilot_id]);
    res.json({ message: `Password reset for ${pilot.name}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Password reset failed' });
  }
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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

    const flightMap = {};
    flightCounts.forEach(row => {
      if (!flightMap[row.pilot_id]) flightMap[row.pilot_id] = {};
      flightMap[row.pilot_id][row.date] = Number(row.cnt);
    });

    const result = pilots.map(p => {
      const dayCounts = {};
      let daysWorked = 0;
      dates.forEach(d => {
        const cnt = (flightMap[p.id] && flightMap[p.id][d]) || 0;
        if (cnt > 0) { dayCounts[d] = cnt; daysWorked++; }
      });
      return { id: p.id, name: p.name, dayCounts, daysWorked };
    });

    res.json({ dates, pilots: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
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
      client_name: client_name || null,
      started_at: now.toISOString(),
      expires_at: expires.toISOString()
    });

    // Push notification to pilot's device (works even when app is closed)
    await sendPushToPilot(pilot_id, {
      title: '🪂 GForce — YOU\'RE AWAY!',
      body: client_name ? `Client: ${client_name}. Timer started — 60 minutes.` : 'Office has started your timer. Have a great flight!',
      tag: 'pilot-sent-away'
    });

    res.json({ message: `Timer started for ${pilot.name}`, expires_at: expires.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/group-leave', verifyOffice, async (req, res) => {
  try {
    const { group_name, pilot_ids, is_peak_trip } = req.body;
    if (!group_name) return res.status(400).json({ error: 'group_name required' });
    if (!pilot_ids || !pilot_ids.length) return res.status(400).json({ error: 'pilot_ids required' });

    const now = new Date();
    const duration = is_peak_trip ? 120 : 60; // peak trips get 2 hours, standard 1 hour
    const expires = new Date(now.getTime() + duration * 60 * 1000);
    const groupId = uuidv4();

    const pilotNames = [];
    const pilotMap = []; // { id, name } for push after all names known
    for (const pid of pilot_ids) {
      const pilot = await queryOne('SELECT * FROM pilots WHERE id = ?', [pid]);
      if (!pilot) continue;
      await run('INSERT OR REPLACE INTO active_timers (pilot_id, client_name, started_at, expires_at, group_id) VALUES (?, ?, ?, ?, ?)',
        [pid, group_name, now.toISOString(), expires.toISOString(), groupId]);
      await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pid, 'group_left_office', new Date().toISOString()]);
      pilotNames.push(pilot.name);
      pilotMap.push({ id: pid, name: pilot.name });
    }
    // Push notification to each pilot — tells them who else is in the group
    for (const p of pilotMap) {
      const others = pilotNames.filter(n => n !== p.name);
      const body = others.length
        ? `Flying with ${others.join(', ')} — ${duration} min timer started.`
        : `Timer started — ${duration} minutes.`;
      await sendPushToPilot(p.id, {
        title: `🪂 GForce — YOU'RE AWAY!`,
        body,
        tag: 'pilot-sent-away'
      });
    }

    broadcast({
      type: 'GROUP_LEFT_OFFICE',
      group_id: groupId,
      group_name,
      pilot_ids,
      pilot_names: pilotNames,
      started_at: now.toISOString(),
      expires_at: expires.toISOString(),
      is_peak_trip: !!is_peak_trip
    });

    res.json({ message: `Group "${group_name}" sent away — ${pilotNames.join(', ')}`, group_id: groupId, expires_at: expires.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/landed-early', verifyOffice, async (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    const timer = await queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    if (!timer) return res.status(404).json({ error: 'No active timer for this pilot' });

    await run('DELETE FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pilot_id, 'landed_early', new Date().toISOString()]);

    const pilot = await queryOne('SELECT name FROM pilots WHERE id = ?', [pilot_id]);
    broadcast({ type: 'LANDED_EARLY', pilot_id, pilot_name: pilot.name });

    res.json({ message: 'Timer cancelled' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
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
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/pilot-signout', verifyOffice, async (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    await run('UPDATE pilots SET available = 0 WHERE id = ?', [pilot_id]);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'PILOT_SIGNED_OUT', pilot_id })); });
    res.json({ message: 'Pilot signed out' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/office/pilot-signin', verifyOffice, async (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });
    await run('UPDATE pilots SET available = 1 WHERE id = ?', [pilot_id]);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'PILOT_SIGNED_IN', pilot_id })); });
    res.json({ message: 'Pilot signed in' });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      [date, flight_num, weight, takeoff, landing, time, notes || '', client_name || null, wing_reg || null, id]
    );
    res.json({ id, message: 'Flight updated by office' });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/office/flights/:id', verifyOffice, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await queryOne('SELECT * FROM flights WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Flight not found' });
    await run('DELETE FROM flights WHERE id = ?', [id]);
    res.json({ id, message: 'Flight deleted by office' });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ name: 'GForce API', status: 'running', time: new Date().toISOString() }));

// ─── Civil Twilight Notification ────────────────────────────────────────────
function eveningCivilTwilightUTC(dateStr) {
  // Returns UTC ms for evening civil twilight in Queenstown, NZ
  // Lat: -45.0312, Lng: 168.6626
  const lat = -45.0312 * Math.PI / 180;
  const date = new Date(dateStr + 'T12:00:00Z');
  const JD = date.getTime() / 86400000 + 2440587.5;
  const n = Math.floor(JD - 2451545 + 0.5);
  const M = ((357.5291 + 0.98560028 * n) % 360 + 360) % 360;
  const Mrad = M * Math.PI / 180;
  const C = 1.9148 * Math.sin(Mrad) + 0.02 * Math.sin(2 * Mrad) + 0.0003 * Math.sin(3 * Mrad);
  const lam = ((M + C + 180 + 102.9372) % 360 + 360) % 360;
  const lamRad = lam * Math.PI / 180;
  const Jtransit = 2451545 + 0.0009 + (168.6626) / 360 + n + 0.0053 * Math.sin(Mrad) - 0.0069 * Math.sin(2 * lamRad);
  const sinDec = Math.sin(lamRad) * Math.sin(23.4397 * Math.PI / 180);
  const dec = Math.asin(sinDec);
  const cosOmega = (Math.sin(-6 * Math.PI / 180) - Math.sin(lat) * sinDec) / (Math.cos(lat) * Math.cos(dec));
  if (cosOmega < -1 || cosOmega > 1) return null;
  const omega = Math.acos(cosOmega) * 180 / Math.PI;
  const Jset = Jtransit + omega / 360;
  return (Jset - 2440587.5) * 86400 * 1000;
}

async function scheduleCivilTwilightAlert() {
  const NZ_TZ = 'Pacific/Auckland';
  const todayNZ = new Date().toLocaleDateString('en-CA', { timeZone: NZ_TZ });
  const twilightMs = eveningCivilTwilightUTC(todayNZ);
  if (!twilightMs) return;
  const delay = twilightMs - Date.now();
  if (delay < -60000) {
    // Already passed today — schedule for tomorrow
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: NZ_TZ });
    const tomorrowMs = eveningCivilTwilightUTC(tomorrow);
    if (tomorrowMs) setTimeout(() => sendCivilTwilightAlerts(), tomorrowMs - Date.now());
    return;
  }
  console.log(`[twilight] Alert scheduled for ${new Date(twilightMs).toISOString()} NZ civil twilight`);
  setTimeout(async () => {
    await sendCivilTwilightAlerts();
    // Reschedule for next day
    setTimeout(() => scheduleCivilTwilightAlert(), 2 * 60 * 1000); // 2min after to reschedule next day
  }, Math.max(0, delay));
}

async function sendCivilTwilightAlerts() {
  try {
    const availablePilots = await queryAll(
      `SELECT p.id FROM pilots p WHERE p.available = 1 AND p.id NOT IN (SELECT pilot_id FROM active_timers)`
    );
    console.log(`[twilight] Sending sign-out reminder to ${availablePilots.length} available pilots`);
    for (const p of availablePilots) {
      await sendPushToPilot(p.id, {
        title: '🌆 End of day reminder',
        body: "You're still signed in. Don't forget to sign out before you head home!",
        tag: 'civil-twilight'
      });
    }
  } catch (e) { console.error('[twilight] Error:', e.message); }
}

// Start civil twilight scheduler
scheduleCivilTwilightAlert();

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

    const repo = 'brookewhatnall/gforce-flight-log';
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

scheduleDailyBackup();
// Also run immediately on startup to ensure we have a current backup
setTimeout(pushDailyBackup, 10000);

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await createTables();
  await seedIfNeeded();
  server.listen(PORT, () => console.log(`🚀 GForce API running on port ${PORT}`));
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
