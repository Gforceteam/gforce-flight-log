require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const initSqlJs = require('sql.js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { loadBackup, saveBackup } = require('./backup');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'gforce-secret-change-in-production';
const OFFICE_PASSWORD = process.env.OFFICE_PASSWORD || 'office123';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'gforce.db');

// ─── Database ─────────────────────────────────────────────────────────────────
let db;

async function initDb() {
  const SQL = await initSqlJs();
  db = new SQL.Database();

  // Helper to run SQL
  function execSql(sql, params = []) {
    db.run(sql, params);
  }

  // Create tables
  execSql(`
    CREATE TABLE pilots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      created_at TEXT
    )
  `);
  execSql(`
    CREATE TABLE flights (
      id TEXT PRIMARY KEY,
      pilot_id TEXT,
      client_name TEXT,
      date TEXT,
      flight_num INTEGER,
      weight REAL,
      takeoff TEXT,
      landing TEXT,
      time INTEGER,
      photos REAL,
      notes TEXT,
      landed_at TEXT,
      created_at TEXT
    )
  `);
  execSql(`
    CREATE TABLE office_logs (
      id TEXT PRIMARY KEY,
      pilot_id TEXT,
      event TEXT,
      created_at TEXT
    )
  `);
  execSql(`
    CREATE TABLE active_timers (
      pilot_id TEXT PRIMARY KEY,
      client_name TEXT,
      started_at TEXT,
      expires_at TEXT
    )
  `);

  // Try to restore from GitHub backup
  const backup = await loadBackup();
  if (backup) {
    // Restore pilots (preserve existing IDs)
    if (backup.pilots && backup.pilots.length > 0) {
      backup.pilots.forEach(p => {
        execSql('INSERT OR IGNORE INTO pilots (id, name, pin_hash, created_at) VALUES (?, ?, ?, ?)',
          [p.id, p.name, p.pin_hash, p.created_at]);
      });
      console.log(`✅ Restored ${backup.pilots.length} pilots from backup`);
    }
    // Restore flights
    if (backup.flights && backup.flights.length > 0) {
      backup.flights.forEach(f => {
        execSql(`INSERT OR IGNORE INTO flights
          (id, pilot_id, client_name, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [f.id, f.pilot_id, f.client_name, f.date, f.flight_num, f.weight, f.takeoff, f.landing, f.time, f.photos, f.notes, f.landed_at, f.created_at]);
      });
      console.log(`✅ Restored ${backup.flights.length} flights from backup`);
    }
    // Restore active timers
    if (backup.active_timers && backup.active_timers.length > 0) {
      backup.active_timers.forEach(t => {
        execSql('INSERT OR REPLACE INTO active_timers (pilot_id, client_name, started_at, expires_at) VALUES (?, ?, ?, ?)',
          [t.pilot_id, t.client_name, t.started_at, t.expires_at]);
      });
      console.log(`✅ Restored ${backup.active_timers.length} active timers`);
    }
  } else {
    // Seed pilots only if no backup
    const existing = db.exec('SELECT COUNT(*) as c FROM pilots');
    if (!existing.length || existing[0].values[0][0] === 0) {
      const pinHash = bcrypt.hashSync('1234', 10);
      const pilots = [
        'Brooke', 'Balda', 'Bellett', 'Ben F', 'Blake', 'Casey', 'Cathal',
        'Cima', 'Clem', 'Dom', 'Eddy', 'Gavin', 'Georges', 'Janik', 'Leo',
        'Marika', 'Mike', 'Pete', 'Thomas', 'Todd'
      ];
      pilots.forEach(name => {
        db.run('INSERT INTO pilots (id, name, pin_hash, created_at) VALUES (?, ?, ?, ?)',
          [uuidv4(), name, pinHash, new Date().toISOString()]);
      });
      console.log(`✅ ${pilots.length} pilots seeded with PIN 1234`);
    }
  }

  saveDb();
  console.log('✅ Database initialized');
}

function saveDb() {
  if (!db) return;
  const buf = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(buf));
  // Non-blocking backup to GitHub
  saveBackup(db).catch(() => {});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

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
app.use(cors());
app.use(express.json());

// ─── Public Routes ────────────────────────────────────────────────────────────
app.get('/api/public/pilots', (req, res) => {
  try {
    const pilots = queryAll('SELECT id, name FROM pilots ORDER BY name');
    res.json(pilots);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/pilot', (req, res) => {
  try {
    const { name, pin } = req.body;
    if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });

    const pilot = queryOne('SELECT * FROM pilots WHERE name = ?', [name]);
    if (!pilot || !bcrypt.compareSync(pin, pilot.pin_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: pilot.id, name: pilot.name, type: 'pilot' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, pilot: { id: pilot.id, name: pilot.name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/office', (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    if (password !== OFFICE_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

    const token = jwt.sign({ type: 'office' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Pilot Routes ────────────────────────────────────────────────────────────
app.get('/api/pilots', verifyToken, (req, res) => {
  try {
    const pilots = queryAll('SELECT id, name FROM pilots ORDER BY name');
    const timers = queryAll('SELECT * FROM active_timers');
    const lastLanded = queryAll('SELECT pilot_id, MAX(landed_at) as last_landed FROM flights WHERE landed_at IS NOT NULL GROUP BY pilot_id');

    const pilotsWithStatus = pilots.map(p => {
      const timer = timers.find(t => t.pilot_id === p.id);
      const lastL = lastLanded.find(f => f.pilot_id === p.id);
      return {
        ...p,
        status: timer ? 'airborne' : 'in_office',
        client_name: timer ? timer.client_name : null,
        timer_started_at: timer ? timer.started_at : null,
        timer_expires_at: timer ? timer.expires_at : null,
        last_landed_at: lastL ? lastL.last_landed : null
      };
    });

    res.json(pilotsWithStatus);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// My status (pilot checking own status)
app.get('/api/my-status', verifyToken, (req, res) => {
  try {
    const timer = queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [req.pilot.id]);
    res.json({
      status: timer ? 'airborne' : 'in_office',
      client_name: timer ? timer.client_name : null,
      timer_started_at: timer ? timer.started_at : null,
      timer_expires_at: timer ? timer.expires_at : null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pilot/extend-timer', verifyToken, (req, res) => {
  try {
    const pilotId = req.pilot.id;
    const timer = queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilotId]);
    if (!timer) return res.status(404).json({ error: 'No active timer' });

    const currentExpiry = new Date(timer.expires_at);
    const newExpiry = new Date(currentExpiry.getTime() + 30 * 60 * 1000);

    run('UPDATE active_timers SET expires_at = ? WHERE pilot_id = ?', [newExpiry.toISOString(), pilotId]);
    run('INSERT INTO office_logs (id, pilot_id, event) VALUES (?, ?, ?)', [uuidv4(), pilotId, 'timer_extended_30min']);

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

app.post('/api/flights', verifyToken, (req, res) => {
  try {
    const { date, flight_num, weight, takeoff, landing, time, photos, notes, client_name } = req.body;
    const pilotId = req.pilot.id;

    if (!date || !flight_num || !weight || !takeoff || !landing || !time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get client_name from active timer if not provided
    const timer = queryOne('SELECT client_name FROM active_timers WHERE pilot_id = ?', [pilotId]);
    const resolvedClientName = client_name || (timer ? timer.client_name : null);

    const id = uuidv4();
    const now = new Date().toISOString();

    run(`
      INSERT INTO flights (id, pilot_id, client_name, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, pilotId, resolvedClientName, date, flight_num, weight, takeoff, landing, time, photos || 0, notes || '', now]);

    // Stop any active timer
    const activeTimer = queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilotId]);
    if (activeTimer) {
      run('DELETE FROM active_timers WHERE pilot_id = ?', [pilotId]);
      run('INSERT INTO office_logs (id, pilot_id, event) VALUES (?, ?, ?)', [uuidv4(), pilotId, 'landed']);

      broadcast({
        type: 'LANDED',
        pilot_id: pilotId,
        pilot_name: req.pilot.name,
        landed_at: now,
        flight_id: id
      });
    }

    res.status(201).json({ id, message: 'Flight logged, office notified' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/flights', verifyToken, (req, res) => {
  try {
    const { date_from, date_to, pilot_id } = req.query;

    let query = 'SELECT * FROM flights WHERE pilot_id = ?';
    const params = [pilot_id || req.pilot.id];

    if (date_from) { query += ' AND date >= ?'; params.push(date_from); }
    if (date_to) { query += ' AND date <= ?'; params.push(date_to); }

    query += ' ORDER BY date DESC, flight_num ASC';
    const flights = queryAll(query, params);
    res.json(flights);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/flights/:id', verifyToken, (req, res) => {
  try {
    const { date, flight_num, weight, takeoff, landing, time, photos, notes } = req.body;
    const { id } = req.params;
    const pilotId = req.pilot.id;

    const existing = queryOne('SELECT * FROM flights WHERE id = ? AND pilot_id = ?', [id, pilotId]);
    if (!existing) return res.status(404).json({ error: 'Flight not found' });

    run(`UPDATE flights SET date=?, flight_num=?, weight=?, takeoff=?, landing=?, time=?, photos=?, notes=? WHERE id=? AND pilot_id=?`,
      [date, flight_num, weight, takeoff, landing, time, photos || 0, notes || '', id, pilotId]);

    res.json({ id, message: 'Flight updated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/flights/:id', verifyToken, (req, res) => {
  try {
    const { id } = req.params;
    const pilotId = req.pilot.id;

    const existing = queryOne('SELECT * FROM flights WHERE id = ? AND pilot_id = ?', [id, pilotId]);
    if (!existing) return res.status(404).json({ error: 'Flight not found' });

    run('DELETE FROM flights WHERE id = ? AND pilot_id = ?', [id, pilotId]);
    res.json({ id, message: 'Flight deleted' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Office Routes ────────────────────────────────────────────────────────────
app.post('/api/office/leave', verifyOffice, (req, res) => {
  try {
    const { pilot_id, client_name } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });

    const pilot = queryOne('SELECT * FROM pilots WHERE id = ?', [pilot_id]);
    if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

    const now = new Date();
    const expires = new Date(now.getTime() + 90 * 60 * 1000);

    run('INSERT OR REPLACE INTO active_timers (pilot_id, client_name, started_at, expires_at) VALUES (?, ?, ?, ?)',
      [pilot_id, client_name || null, now.toISOString(), expires.toISOString()]);

    run('INSERT INTO office_logs (id, pilot_id, event) VALUES (?, ?, ?)',
      [uuidv4(), pilot_id, 'left_office']);

    broadcast({
      type: 'LEFT_OFFICE',
      pilot_id,
      pilot_name: pilot.name,
      client_name: client_name || null,
      started_at: now.toISOString(),
      expires_at: expires.toISOString()
    });

    res.json({ message: `Timer started for ${pilot.name}`, expires_at: expires.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/landed-early', verifyOffice, (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });

    const timer = queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    if (!timer) return res.status(404).json({ error: 'No active timer for this pilot' });

    run('DELETE FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    run('INSERT INTO office_logs (id, pilot_id, event) VALUES (?, ?, ?)', [uuidv4(), pilot_id, 'landed_early']);

    const pilot = queryOne('SELECT name FROM pilots WHERE id = ?', [pilot_id]);
    broadcast({ type: 'LANDED_EARLY', pilot_id, pilot_name: pilot.name });

    res.json({ message: 'Timer cancelled' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/office/extend', verifyOffice, (req, res) => {
  try {
    const { pilot_id } = req.body;
    if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });

    const timer = queryOne('SELECT * FROM active_timers WHERE pilot_id = ?', [pilot_id]);
    if (!timer) return res.status(404).json({ error: 'No active timer for this pilot' });

    // Add 30 minutes to the current expiry
    const currentExpiry = new Date(timer.expires_at);
    const newExpiry = new Date(currentExpiry.getTime() + 30 * 60 * 1000);

    run('UPDATE active_timers SET expires_at = ? WHERE pilot_id = ?', [newExpiry.toISOString(), pilot_id]);
    run('INSERT INTO office_logs (id, pilot_id, event) VALUES (?, ?, ?)', [uuidv4(), pilot_id, 'timer_extended_30min']);

    const pilot = queryOne('SELECT name FROM pilots WHERE id = ?', [pilot_id]);
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

app.get('/api/office/flights', verifyOffice, (req, res) => {
  try {
    const flights = queryAll(`
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

// ─── CSV Export ──────────────────────────────────────────────────────────────
app.get('/api/export/flights', verifyOffice, (req, res) => {
  try {
    const { pilot_id } = req.query;

    let flights;
    if (pilot_id) {
      flights = queryAll(`
        SELECT f.*, p.name as pilot_name
        FROM flights f
        JOIN pilots p ON f.pilot_id = p.id
        WHERE f.pilot_id = ?
        ORDER BY f.date, f.flight_num
      `, [pilot_id]);
    } else {
      flights = queryAll(`
        SELECT f.*, p.name as pilot_name
        FROM flights f
        JOIN pilots p ON f.pilot_id = p.id
        ORDER BY p.name, f.date, f.flight_num
      `);
    }

    if (!flights.length) return res.status(404).json({ error: 'No flights found' });

    const header = ['Date', 'Pilot', 'Client Name', 'Flight #', 'Weight (kg)', 'Takeoff', 'Landing', 'Time (min)', 'Photos ($)', 'Notes'];
    const rows = flights.map(f => [
      f.date, f.pilot_name || '', f.client_name || '', f.flight_num, f.weight, f.takeoff, f.landing, f.time, f.photos || 0, f.notes || ''
    ]);

    const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="flights${pilot_id ? '_' + pilot_id : '_all'}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('🔌 WebSocket client connected');
  ws.on('close', () => console.log('🔌 WebSocket client disconnected'));
});

// ─── Timer Expiry Checker ─────────────────────────────────────────────────────
let timerInterval;
function startTimerChecker() {
  timerInterval = setInterval(() => {
    if (!db) return;
    try {
      const now = new Date().toISOString();
      const expired = queryAll('SELECT * FROM active_timers WHERE expires_at <= ?', [now]);

      expired.forEach(timer => {
        run('DELETE FROM active_timers WHERE pilot_id = ?', [timer.pilot_id]);
        run('INSERT INTO office_logs (id, pilot_id, event) VALUES (?, ?, ?)', [uuidv4(), timer.pilot_id, 'timer_expired']);

        const pilot = queryOne('SELECT name FROM pilots WHERE id = ?', [timer.pilot_id]);
        broadcast({
          type: 'TIMER_EXPIRED',
          pilot_id: timer.pilot_id,
          pilot_name: pilot ? pilot.name : 'Unknown',
          started_at: timer.started_at
        });
      });
    } catch (e) {
      console.error('Timer checker error:', e);
    }
  }, 10000);
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: db ? 'ready' : 'loading', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ name: 'Gforce API', status: 'running', time: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await initDb();
  startTimerChecker();
  server.listen(PORT, () => {
    console.log(`🚀 Gforce API running on port ${PORT}`);
    console.log(`📡 WebSocket ready`);
    console.log(`🔐 Office password: ${OFFICE_PASSWORD}`);
  });
}

start().catch(e => {
  console.error('Failed to start:', e);
  process.exit(1);
});
