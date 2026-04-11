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

async function migrate() {
  console.log('📦 Fetching backup.json from GitHub...');
  const backup = await fetchBackup();
  console.log(`📦 Found ${backup.pilots?.length || 0} pilots, ${backup.flights?.length || 0} flights`);

  // Pilots
  if (backup.pilots?.length) {
    const batches = [];
    for (let i = 0; i < backup.pilots.length; i += 50) {
      batches.push(backup.pilots.slice(i, i + 50));
    }
    for (const batch of batches) {
      await db.batch(batch.map(p => ({
        sql: 'INSERT OR IGNORE INTO pilots (id, name, pin_hash, created_at, current_wing) VALUES (?, ?, ?, ?, ?)',
        args: [p.id, p.name, p.pin_hash, p.created_at, p.current_wing || null]
      })), 'write');
    }
    console.log(`✅ ${backup.pilots.length} pilots migrated`);
  }

  // Flights — batch in groups of 50 to stay within limits
  if (backup.flights?.length) {
    const batches = [];
    for (let i = 0; i < backup.flights.length; i += 50) {
      batches.push(backup.flights.slice(i, i + 50));
    }
    for (const batch of batches) {
      await db.batch(batch.map(f => ({
        sql: `INSERT OR IGNORE INTO flights
          (id, pilot_id, client_name, date, flight_num, weight, takeoff, landing, time, photos, notes, landed_at, created_at, wing_reg)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [f.id, f.pilot_id, f.client_name, f.date, f.flight_num, f.weight,
               f.takeoff, f.landing, f.time, f.photos, f.notes, f.landed_at, f.created_at, f.wing_reg || null]
      })), 'write');
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
