'use strict';

/**
 * Applies monitor migration 004 (toolchain column) safely.
 *
 * The monitor host has no psql and the database is remote, so this uses the
 * same `pg` client the monitor already depends on. Three things happen in one
 * transaction: a copy of `sessions` is kept, the migration runs, and the result
 * is read back. If any step fails nothing is committed.
 *
 * Usage: node scripts/apply-monitor-migration.cjs monitor-server/migrations/004-toolchain.sql
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const file = process.argv[2];
  if (!file) throw new Error('migration file is required');
  const migration = fs.readFileSync(file, 'utf8');

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const backup = `sessions_backup_${stamp}`;

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE ${backup} AS SELECT * FROM sessions`);
    const before = await client.query(`SELECT count(*)::int AS n FROM ${backup}`);
    await client.query(migration);
    const columns = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name = 'toolchain_json'`
    );
    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'sessions' AND indexname = 'sessions_machine_updated_idx'`
    );
    await client.query('COMMIT');

    console.log(JSON.stringify({
      backup_table: backup,
      rows_backed_up: before.rows[0].n,
      toolchain_column: columns.rows[0] || null,
      parity_index: indexes.rows[0] || null,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('MIGRATION FAILED:', error.message);
  process.exit(1);
});
