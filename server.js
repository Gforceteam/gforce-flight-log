require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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
function initDb() {
  db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pilots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS flights (
      id TEXT PRIMARY KEY,
      pilot_id TEXT NOT NULL,
      date TEXT NOT NULL,
      flight_num INTEGER NOT NULL,
      weight REAL NOT NULL,
      takeoff TEXT NOT NULL,
      landing TEXT NOT NULL,
      time INTEGER NOT NULL,
      photos REAL DEFAULT 0,
      notes TEXT,
      landed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pilot_id) REFERENCES pilots(id)
    );

    CREATE TABLE IF NOT EXISTS office_logs (
      id TEXT PRIMARY KEY,
      pilot_id TEXT NOT NULL,
      event TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pilot_id) REFERENCES pilots(id)
    );

    CREATE TABLE IF NOT EXISTS active_timers (
      pilot_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (pilot_id) REFERENCES pilots(id)
    );
  `);

  // Seed demo pilot if none exist
  const count = db.prepare('SELECT COUNT(*) as c FROM pilots').get();
  if (count.c === 0) {
    const pinHash = bcrypt.hashSync('1234', 10);
    db.prepare('INSERT INTO pilots (id, name, pin_hash) VALUES (?, ?, ?)').run(uuidv4(), 'Brooke', pinHash);
    console.log('✅ Demo pilot seeded: Brooke, PIN 1234');
  }

  console.log('✅ Database initialized at', DB_PATH);
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

// ─── Public Routes ───────────────────────────────────────────────────────────
app.get('/api/public/pilots', (req, res) => {
  const pilots = db.prepare('SELECT id, name FROM pilots ORDER BY name').all();
  res.json(pilots);
});

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/auth/pilot', (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });

  const pilot = db.prepare('SELECT * FROM pilots WHERE name = ?').get(name);
  if (!pilot || !bcrypt.compareSync(pin, pilot.pin_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: pilot.id, name: pilot.name, type: 'pilot' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, pilot: { id: pilot.id, name: pilot.name } });
});

app.post('/api/auth/office', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password !== OFFICE_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

  const token = jwt.sign({ type: 'office' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// ─── Pilot Routes ────────────────────────────────────────────────────────────
app.get('/api/pilots', verifyToken, (req, res) => {
  const pilots = db.prepare('SELECT id, name FROM pilots ORDER BY name').all();
  const timers = db.prepare('SELECT * FROM active_timers').all();
  const flights = db.prepare('SELECT pilot_id, MAX(landed_at) as last_landed FROM flights WHERE landed_at IS NOT NULL GROUP BY pilot_id').all();

  const pilotsWithStatus = pilots.map(p => {
    const timer = timers.find(t => t.pilot_id === p.id);
    const lastLanded = flights.find(f => f.pilot_id === p.id);
    return {
      ...p,
      status: timer ? 'airborne' : 'in_office',
      timer_started_at: timer ? timer.started_at : null,
      timer_expires_at: timer ? timer.expires_at : null,
      last_landed_at: lastLanded ? lastLanded.last_landed : null
    };
  });

  res.json(pilotsWithStatus);
});

app.post('/api/flights', verifyToken, (req, res) => {
  const { date, flight_num, weight, takeoff, landing, time, photos, notes } = req.body;
  const pilotId = req.pilot.id;

  if (!date || !flight_num || !weight || !takeoff || !landing || !time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO flights (id, pilot_id, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, pilotId, date, flight_num, weight, takeoff, landing, time, photos || 0, notes || '', now);

  // Stop any active timer for this pilot
  const timer = db.prepare('SELECT * FROM active_timers WHERE pilot_id = ?').get(pilotId);
  if (timer) {
    db.prepare('DELETE FROM active_timers WHERE pilot_id = ?').run(pilotId);
    db.prepare('INSERT INTO office_logs (id, pilot_id, event) VALUES (?, ?, ?)').run(uuidv4(), pilotId, 'landed');

    // Broadcast to all connected clients
    broadcast({
      type: 'LANDED',
      pilot_id: pilotId,
      pilot_name: req.pilot.name,
      landed_at: now,
      flight_id: id
    });
  }

  res.status(201).json({ id, message: 'Flight logged, office notified' });
});

app.get('/api/flights', verifyToken, (req, res) => {
  const { date_from, date_to, pilot_id } = req.query;
  let query = 'SELECT * FROM flights WHERE 1=1';
  const params = [];

  if (pilot_id) { query += ' AND pilot_id = ?'; params.push(pilot_id); }
  else { query += ' AND pilot_id = ?'; params.push(req.pilot.id); }
  if (date_from) { query += ' AND date >= ?'; params.push(date_from); }
  if (date_to) { query += ' AND date <= ?'; params.push(date_to); }

  query += ' ORDER BY date DESC, flight_num ASC';
  const flights = db.prepare(query).all(...params);
  res.json(flights);
});

// ─── Office Routes ────────────────────────────────────────────────────────────
app.post('/api/office/leave', verifyOffice, (req, res) => {
  const { pilot_id } = req.body;
  if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });

  const pilot = db.prepare('SELECT * FROM pilots WHERE id = ?').get(pilot_id);
  if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

  const now = new Date();
  const expires = new Date(now.getTime() + 90 * 60 * 1000); // 90 minutes

  db.prepare('INSERT OR REPLACE INTO active_timers (pilot_id, started_at, expires_at) VALUES (?, ?, ?)')
    .run(pilot_id, now.toISOString(), expires.toISOString());

  db.prepare('INSERT INTO office_logs (id, pilot_id, event) VALUES (?, ?, ?)')
    .run(uuidv4(), pilot_id, 'left_office');

  broadcast({
    type: 'LEFT_OFFICE',
    pilot_id,
    pilot_name: pilot.name,
    started_at: now.toISOString(),
    expires_at: expires.toISOString()
  });

  res.json({ message: `Timer started for ${pilot.name}`, expires_at: expires.toISOString() });
});

app.post('/api/office/landed-early', verifyOffice, (req, res) => {
  const { pilot_id } = req.body;
  if (!pilot_id) return res.status(400).json({ error: 'pilot_id required' });

  const timer = db.prepare('SELECT * FROM active_timers WHERE pilot_id = ?').get(pilot_id);
  if (!timer) return res.status(404).json({ error: 'No active timer for this pilot' });

  db.prepare('DELETE FROM active_timers WHERE pilot_id = ?').run(pilot_id);
  db.prepare('INSERT INTO office_logs (id, pilot_id, event) VALUES (?, ?, ?)')
    .run(uuidv4(), pilot_id, 'landed_early');

  const pilot = db.prepare('SELECT name FROM pilots WHERE id = ?').get(pilot_id);
  broadcast({
    type: 'LANDED_EARLY',
    pilot_id,
    pilot_name: pilot.name
  });

  res.json({ message: 'Timer cancelled' });
});

// ─── CSV Export ──────────────────────────────────────────────────────────────
app.get('/api/export/flights', verifyOffice, (req, res) => {
  const { pilot_id, combined } = req.query;
  const duty = JSON.parse(localStorage.getItem('gforce_duty') || '{}'); // Staff dashboard has its own duty tracking

  let flights;
  if (pilot_id) {
    flights = db.prepare('SELECT * FROM flights WHERE pilot_id = ? ORDER BY date, flight_num').all(pilot_id);
  } else {
    flights = db.prepare('SELECT f.*, p.name as pilot_name FROM flights f JOIN pilots p ON f.pilot_id = p.id ORDER BY p.name, f.date, f.flight_num').all();
  }

  if (flights.length === 0) return res.status(404).json({ error: 'No flights found' });

  const header = ['Date', 'Pilot', 'Flight #', 'Weight (kg)', 'Takeoff', 'Landing', 'Time (min)', 'Photos ($)', 'Notes'];
  const rows = flights.map(f => [
    f.date, f.pilot_name || '', f.flight_num, f.weight, f.takeoff, f.landing, f.time, f.photos || 0, f.notes || ''
  ]);

  const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="flights${pilot_id ? '_' + pilot_id : '_all'}.csv"`);
  res.send(csv);
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('🔌 WebSocket client connected');
  ws.on('close', () => console.log('🔌 WebSocket client disconnected'));
});

// ─── Timer Expiry Checker ─────────────────────────────────────────────────────
setInterval(() => {
  const now = new Date().toISOString();
  const expired = db.prepare('SELECT * FROM active_timers WHERE expires_at <= ?').all(now);

  expired.forEach(timer => {
    db.prepare('DELETE FROM active_timers WHERE pilot_id = ?').run(timer.pilot_id);
    db.prepare('INSERT INTO office_logs (id, pilot_id, event) VALUES (?, ?, ?)')
      .run(uuidv4(), timer.pilot_id, 'timer_expired');

    const pilot = db.prepare('SELECT name FROM pilots WHERE id = ?').get(timer.pilot_id);
    broadcast({
      type: 'TIMER_EXPIRED',
      pilot_id: timer.pilot_id,
      pilot_name: pilot ? pilot.name : 'Unknown',
      started_at: timer.started_at
    });
  });
}, 10000); // Check every 10 seconds

// ─── Static files (for health check) ────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── Start ────────────────────────────────────────────────────────────────────
initDb();
server.listen(PORT, () => {
  console.log(`🚀 Gforce API running on port ${PORT}`);
  console.log(`📡 WebSocket ready`);
  console.log(`🔐 Office password: ${OFFICE_PASSWORD}`);
});
