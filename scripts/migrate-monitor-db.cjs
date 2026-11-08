#!/usr/bin/env node
'use strict';

/**
 * Apply monitor database migrations.
 *
 * The monitor schema is owned outside this repository, so this script is the
 * only place that changes it. It is idempotent: every statement guards itself,
 * which means running it twice is a no-op rather than an error.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate-monitor-db.cjs
 *   node scripts/migrate-monitor-db.cjs --dry-run
 *
 * It prints the primary key it finds afterwards, so the operator can see that
 * the composite card identity is really in place.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'monitor-server', 'migrations');

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

async function primaryKeyOf(client) {
  const result = await client.query(
    `SELECT pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'sessions' AND con.contype = 'p'
      LIMIT 1`,
  );
  return result.rows.length ? result.rows[0].definition : null;
}

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const url = process.env.DATABASE_URL || '';
  const migrations = listMigrations();

  if (!migrations.length) {
    console.error('No migration files found in ' + MIGRATIONS_DIR);
    return 1;
  }

  if (!url) {
    console.error('DATABASE_URL is required');
    return 1;
  }

  if (dryRun) {
    for (const name of migrations) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      console.log(`--- ${name} (${sql.length} bytes, not applied)`);
    }
    return 0;
  }

  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch {
    console.error('The pg package is not installed; run npm install first');
    return 1;
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of migrations) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      await client.query(sql);
      console.log(`applied ${name}`);
    }
    const pk = await primaryKeyOf(client);
    await client.query('COMMIT');
    console.log(`sessions primary key: ${pk || '(none)'}`);
    return 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`migration failed, rolled back: ${error.message}`);
    return 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error && error.message ? error.message : String(error));
      process.exit(1);
    });
}

module.exports = { listMigrations, main };
