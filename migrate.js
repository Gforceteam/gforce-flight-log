// One-time migration: loads backup.json from GitHub → inserts into Turso
// Run once: node migrate.js
require('dotenv').config();
const https = require('https');
const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

function fetchBackup() {
  return new Promise((resolve, reject) => {
    const url = 'https://raw.githubusercontent.com/brookewhatnall/gforce-api/main/data/backup.json';
    https.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
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
    pilot_id TEXT PRIMARY KEY, client_name TEXT, started_at TEXT, expires_at TEXT)`);
  console.log('✅ Tables created');
}

async function migrate() {
  await createTables();
  console.log('📦 Fetching backup.json from GitHub...');
  const backup = await fetchBackup();
  console.log(`📦 Found ${backup.pilots?.length || 0} pilots, ${backup.flights?.length || 0} flights`);

  // Pilots
  if (backup.pilots?.length) {
    for (const p of backup.pilots) {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO pilots (id, name, pin_hash, created_at, current_wing) VALUES (?, ?, ?, ?, ?)',
        args: [p.id, p.name, p.pin_hash, p.created_at, p.current_wing || null]
      });
    }
    console.log(`✅ ${backup.pilots.length} pilots migrated`);
  }

  if (backup.flights?.length) {
    for (const f of backup.flights) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO flights
          (id, pilot_id, client_name, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at, created_at, wing_reg)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [f.id, f.pilot_id, f.client_name, f.date, f.flight_num, f.weight,
               f.takeoff, f.landing, f.time, f.photos, f.notes, f.landed_at, f.created_at, f.wing_reg || null]
      });
    }
    console.log(`✅ ${backup.flights.length} flights migrated`);
  }

  console.log('🎉 Migration complete');
  process.exit(0);
}

migrate().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
