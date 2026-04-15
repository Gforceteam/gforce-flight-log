#!/usr/bin/env node
/**
 * One-off: delete all flights for the pilot named "Casey".
 *
 * From the api/ directory (with TURSO_URL and TURSO_AUTH_TOKEN in .env, same as the server):
 *   node scripts/delete-casey-flights.js
 *
 * Turso shell equivalent:
 *   DELETE FROM flights WHERE pilot_id = (SELECT id FROM pilots WHERE name = 'Casey');
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');

async function main() {
  const url = process.env.TURSO_URL || 'file:local.db';
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const db = createClient({ url, authToken });

  const sel = await db.execute({
    sql: 'SELECT id, name FROM pilots WHERE name = ?',
    args: ['Casey']
  });
  if (!sel.rows.length) {
    console.error('No pilot named Casey found.');
    process.exit(1);
  }
  const pilotId = sel.rows[0][0];
  const del = await db.execute({
    sql: 'DELETE FROM flights WHERE pilot_id = ?',
    args: [pilotId]
  });
  const n = typeof del.rowsAffected === 'number' ? del.rowsAffected : (del.changes ?? 'unknown');
  console.log(`Deleted flights for Casey (pilot_id=${pilotId}). rowsAffected=${n}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
