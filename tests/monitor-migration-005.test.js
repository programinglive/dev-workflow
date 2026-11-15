import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = readFileSync(
  path.join(ROOT, "monitor-server", "migrations", "005-reaper-owner.sql"),
  "utf8",
);

/**
 * Migration 005 against a real PostgreSQL fixture.
 *
 * The migration is applied to its own schema so it cannot collide with the
 * tables other database tests create. Without PostgreSQL the test is SKIPPED
 * with a visible reason, never silently passed.
 */

const CONNECTION = process.env.TEST_POSTGRES_URL || process.env.DEVWF_TEST_PG || "";
const SCHEMA = "devwf_reaper_migration";

let pool = null;
let ready = false;
let skipReason = "";

const LEGACY_SESSIONS = `
CREATE TABLE IF NOT EXISTS sessions (
  session_key text NOT NULL,
  task_id text NOT NULL DEFAULT '',
  machine text,
  project_name text,
  phase text,
  owner_pid integer,
  updated_at timestamptz,
  PRIMARY KEY (session_key, task_id)
);`;

before(async () => {
  if (!CONNECTION) {
    skipReason = "TEST_POSTGRES_URL is empty - migration test skipped";
    return;
  }
  let Pool;
  try {
    Pool = require("pg").Pool;
  } catch {
    skipReason = "the pg module is unavailable";
    return;
  }
  const candidate = new Pool({
    connectionString: CONNECTION,
    max: 2,
    connectionTimeoutMillis: 5000,
    options: `-c search_path=${SCHEMA},public`,
  });
  try {
    await candidate.query("SELECT 1");
    await candidate.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await candidate.query(`CREATE SCHEMA ${SCHEMA}`);
    await candidate.query(LEGACY_SESSIONS);
    pool = candidate;
    ready = true;
  } catch (error) {
    skipReason = `PostgreSQL is not usable (${error.message})`;
    try {
      await candidate.end();
    } catch {
      // already closed
    }
    pool = null;
  }
});

after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await pool.end().catch(() => {});
});

function skip(t) {
  if (!ready) {
    t.skip(skipReason || "PostgreSQL is not available");
    return true;
  }
  return false;
}

test("migration 005 adds the five reaper columns to a legacy table", async (t) => {
  if (skip(t)) return;

  await pool.query(MIGRATION);

  const { rows } = await pool.query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'sessions'
        AND column_name = ANY($2::text[])
      ORDER BY column_name`,
    [SCHEMA, ["owner_started_at", "owner_executable", "lease_owner", "lease_generation", "lease_fencing_token"]],
  );

  assert.equal(rows.length, 5, "all five columns must exist");
  for (const row of rows) {
    assert.equal(row.is_nullable, "NO", `${row.column_name} must be NOT NULL`);
    assert.ok(row.column_default !== null, `${row.column_name} must have a default`);
  }
});

test("migration 005 is idempotent", async (t) => {
  if (skip(t)) return;
  await pool.query(MIGRATION);
  await pool.query(MIGRATION);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'sessions'
        AND column_name = ANY($2::text[])`,
    [SCHEMA, ["owner_started_at", "owner_executable", "lease_owner", "lease_generation", "lease_fencing_token"]],
  );
  assert.equal(rows[0].total, 5, "re-running must not duplicate or fail");
});

test("existing rows keep working after the migration", async (t) => {
  if (skip(t)) return;
  await pool.query(
    `INSERT INTO sessions (session_key, task_id, machine, project_name, phase, owner_pid, updated_at)
     VALUES ('ses_legacy', 'task-1', 'MMCH', 'demo', 'coding', 123, now())
     ON CONFLICT (session_key, task_id) DO NOTHING`,
  );
  const { rows } = await pool.query(
    `SELECT owner_started_at, owner_executable, lease_owner, lease_generation, lease_fencing_token
       FROM sessions WHERE session_key = 'ses_legacy'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_started_at, "");
  assert.equal(rows[0].owner_executable, "");
  assert.equal(rows[0].lease_owner, "");
  assert.equal(rows[0].lease_generation, 0);
  assert.equal(rows[0].lease_fencing_token, "");
});
