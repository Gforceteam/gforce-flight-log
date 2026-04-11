require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@libsql/client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'gforce-secret-change-in-production';
const OFFICE_PASSWORD = process.env.OFFICE_PASSWORD || 'office123';

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
    created_at TEXT, last_seen TEXT, current_wing TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS flights (
    id TEXT PRIMARY KEY, pilot_id TEXT, client_name TEXT, date TEXT,
    flight_num INTEGER, weight REAL, takeoff TEXT, landing TEXT,
    time INTEGER, photos REAL, notes TEXT, landed_at TEXT,
    created_at TEXT, wing_reg TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS office_logs (
    id TEXT PRIMARY KEY, pilot_id TEXT, event TEXT, created_at TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS active_timers (
    pilot_id TEXT PRIMARY KEY, client_name TEXT, started_at TEXT, expires_at TEXT, group_id TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS drives (
    id TEXT PRIMARY KEY, pilot_id TEXT, date TEXT, notes TEXT, group_id TEXT, created_at TEXT)`);
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
app.use(cors());
app.use(express.json());

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
  try {
    const { name, pin } = req.body;
    if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });
    const pilot = await queryOne('SELECT * FROM pilots WHERE name = ?', [name]);
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

app.post('/api/auth/office', async (req, res) => {
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

// ─── Pilot Routes ─────────────────────────────────────────────────────────────
app.get('/api/pilots', verifyToken, async (req, res) => {
  try {
    const pilots = await queryAll('SELECT id, name, last_seen, current_wing FROM pilots ORDER BY name');
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
    const pilot = await queryOne('SELECT current_wing FROM pilots WHERE id = ?', [req.pilot.id]);
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
    await run('UPDATE active_timers SET expires_at = ? WHERE pilot_id = ?', [newExpiry.toISOString(), pilotId]);
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

    const timer = await queryOne('SELECT client_name FROM active_timers WHERE pilot_id = ?', [pilotId]);
    const resolvedClientName = client_name || (timer ? timer.client_name : null);
    const id = uuidv4();
    const now = new Date().toISOString();

    if (wing_reg) {
      await run('UPDATE pilots SET current_wing = ? WHERE id = ?', [wing_reg, pilotId]);
    }

    await run(
      `INSERT INTO flights (id, pilot_id, client_name, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at, wing_reg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, pilotId, resolvedClientName, date, flight_num, weight, takeoff, landing, time, photos || 0, notes || '', now, wing_reg || null]
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
    const { date_from, date_to, pilot_id } = req.query;
    let sql = 'SELECT * FROM flights WHERE pilot_id = ?';
    const params = [pilot_id || req.pilot.id];
    if (date_from) { sql += ' AND date >= ?'; params.push(date_from); }
    if (date_to) { sql += ' AND date <= ?'; params.push(date_to); }
    sql += ' ORDER BY date DESC, flight_num ASC';
    const flights = await queryAll(sql, params);
    res.json(flights);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
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

    await run('INSERT OR REPLACE INTO active_timers (pilot_id, client_name, started_at, expires_at) VALUES (?, ?, ?, ?)',
      [pilot_id, client_name || null, now.toISOString(), expires.toISOString()]);
    await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pilot_id, 'left_office', new Date().toISOString()]);

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
    for (const pid of pilot_ids) {
      const pilot = await queryOne('SELECT * FROM pilots WHERE id = ?', [pid]);
      if (!pilot) continue;
      await run('INSERT OR REPLACE INTO active_timers (pilot_id, client_name, started_at, expires_at, group_id) VALUES (?, ?, ?, ?, ?)',
        [pid, group_name, now.toISOString(), expires.toISOString(), groupId]);
      await run('INSERT INTO office_logs (id, pilot_id, event, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), pid, 'group_left_office', new Date().toISOString()]);
      pilotNames.push(pilot.name);
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

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ name: 'GForce API', status: 'running', time: new Date().toISOString() }));

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
