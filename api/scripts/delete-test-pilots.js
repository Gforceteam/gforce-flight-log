#!/usr/bin/env node
/**
 * One-off: delete pilots named 'Test', 'Test 2', 'Test 3' and all their data.
 *
 * From the api/ directory (with TURSO_URL and TURSO_AUTH_TOKEN in .env):
 *   node scripts/delete-test-pilots.js
 *
 * Turso shell equivalent:
 *   DELETE FROM pilots WHERE name IN ('Test', 'Test 2', 'Test 3');
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');

const TEST_NAMES = ['Test', 'Test 2', 'Test 3'];

async function main() {
  const url = process.env.TURSO_URL || 'file:local.db';
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const db = createClient({ url, authToken });

  const placeholders = TEST_NAMES.map(() => '?').join(', ');
  const sel = await db.execute({
    sql: `SELECT id, name FROM pilots WHERE name IN (${placeholders})`,
    args: TEST_NAMES
  });

  if (!sel.rows.length) {
    console.log('No test pilots found — nothing to delete.');
    return;
  }

  for (const row of sel.rows) {
    const [id, name] = row;
    await db.execute({ sql: 'DELETE FROM flights WHERE pilot_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM active_timers WHERE pilot_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM duty_sheet_overrides WHERE pilot_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM loop_board WHERE pilot_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM pilots WHERE id = ?', args: [id] });
    console.log(`Deleted pilot "${name}" (id=${id}) and all associated data.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
