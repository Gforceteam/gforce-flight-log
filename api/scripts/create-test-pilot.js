#!/usr/bin/env node
/**
 * One-off: create a pilot named "Test" with password "test1234".
 *
 * From the api/ directory (with TURSO_URL and TURSO_AUTH_TOKEN in .env):
 *   node scripts/create-test-pilot.js
 *
 * To remove the pilot later:
 *   DELETE FROM pilots WHERE name = 'Test';
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

async function main() {
  const url = process.env.TURSO_URL || 'file:local.db';
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const db = createClient({ url, authToken });

  const existing = await db.execute({ sql: 'SELECT id FROM pilots WHERE name = ?', args: ['Test'] });
  if (existing.rows.length) {
    console.log('Pilot "Test" already exists — nothing to do.');
    return;
  }

  const pinHash = await bcrypt.hash('test1234', 10);
  const id = uuidv4();
  await db.execute({
    sql: 'INSERT INTO pilots (id, name, pin_hash, created_at, presence) VALUES (?, ?, ?, ?, ?)',
    args: [id, 'Test', pinHash, new Date().toISOString(), 1]
  });

  console.log(`✅ Created pilot "Test" (id=${id})`);
  console.log('   Login: name = Test, password = test1234');
}

main().catch((e) => { console.error(e); process.exit(1); });
