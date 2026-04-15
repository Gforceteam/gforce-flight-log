#!/usr/bin/env node
/**
 * One-off: delete all flights for a pilot by exact name (as stored in pilots.name).
 *
 * Usage (from api/ with TURSO_URL and TURSO_AUTH_TOKEN in .env):
 *   node scripts/delete-pilot-flights-by-name.js "Dom"
 *
 * Turso shell equivalent:
 *   DELETE FROM flights WHERE pilot_id = (SELECT id FROM pilots WHERE name = 'Dom');
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');

async function main() {
  const name = (process.argv[2] || '').trim();
  if (!name) {
    console.error('Usage: node scripts/delete-pilot-flights-by-name.js <PilotName>');
    process.exit(1);
  }
  const url = process.env.TURSO_URL || 'file:local.db';
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const db = createClient({ url, authToken });

  const sel = await db.execute({
    sql: 'SELECT id, name FROM pilots WHERE name = ?',
    args: [name]
  });
  if (!sel.rows.length) {
    console.error(`No pilot named "${name}" found.`);
    process.exit(1);
  }
  const pilotId = sel.rows[0][0];
  const del = await db.execute({
    sql: 'DELETE FROM flights WHERE pilot_id = ?',
    args: [pilotId]
  });
  const n = typeof del.rowsAffected === 'number' ? del.rowsAffected : (del.changes ?? 'unknown');
  console.log(`Deleted flights for ${name} (pilot_id=${pilotId}). rowsAffected=${n}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
