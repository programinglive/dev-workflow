import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSessionUpsert, buildParentHandoff } = require("../monitor-server/session-upsert.cjs");

/**
 * Behavior test for Zettelkasten card chaining. It runs the real SQL against
 * PostgreSQL because the chaining guarantee is a database fact: two tasks of
 * one session must be two rows, and the parent row must stop being active.
 *
 * Skipped with a visible reason when PostgreSQL is not reachable.
 */

const KONEKSI =
  process.env.TEST_POSTGRES_URL ||
  process.env.DEVWF_TEST_PG ||
  "postgresql://postgres@127.0.0.1:5599/postgres";

// Setiap berkas tes database memakai skema sendiri. Tanpa itu `sessions` milik
// satu tes (PK tunggal) bertabrakan dengan `sessions` milik tes lain (PK
// komposit), dan kegagalannya muncul di berkas yang tidak diubah.
const SKEMA = "devwf_chain";

const PREFIX = "ses_uji_chain_";

let pg = null;
let pool = null;
let siap = false;
let alasanLewat = "";

async function terapkanMigrasi() {
  const sql = readFileSync(new URL("../monitor-server/migrations/001-card-chaining.sql", import.meta.url), "utf8");
  await pool.query(sql);
}

before(async () => {
  try {
    pg = require("pg");
  } catch {
    alasanLewat = "modul pg tidak tersedia";
    return;
  }
  try {
    pool = new pg.Pool({
      connectionString: KONEKSI,
      max: 2,
      connectionTimeoutMillis: 3000,
      options: `-c search_path=${SKEMA},public`,
    });
    await pool.query("SELECT 1");
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SKEMA}`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key text PRIMARY KEY,
        machine text, project_path text, project_name text,
        task text, task_type text, phase text,
        plan_json jsonb, plan_done integer, plan_total integer,
        dod_done integer, dod_total integer, dod_waived integer,
        owner_pid integer, started_at timestamptz, updated_at timestamptz,
        session_title text, agent_tool text
      )`);
    await terapkanMigrasi();
    siap = true;
  } catch (e) {
    alasanLewat = `PostgreSQL tidak bisa dihubungi (${KONEKSI}): ${e.message}`;
  }
});

after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM sessions WHERE session_key LIKE '${PREFIX}%'`).catch(() => {});
  await pool.end().catch(() => {});
});

function lewati(t) {
  if (!siap) {
    t.skip(alasanLewat || "PostgreSQL tidak tersedia");
    return true;
  }
  return false;
}

async function simpan(body) {
  const { sql, params } = buildSessionUpsert(body);
  await pool.query(sql, params);
  const handoff = buildParentHandoff(body);
  if (handoff) await pool.query(handoff.sql, handoff.params);
}

async function kartu(sessionKey) {
  const r = await pool.query(
    `SELECT task_id, task, phase, parent_task_id, parent_task_title
       FROM sessions WHERE session_key = $1 ORDER BY started_at ASC`,
    [sessionKey],
  );
  return r.rows;
}

test("two tasks of one session stay as two cards and the parent is handed off", async (t) => {
  if (lewati(t)) return;
  const sessionKey = PREFIX + "two";

  await simpan({
    sessionKey,
    taskId: "task-a",
    machine: "HELLOWORLD",
    projectName: "proyek",
    task: "first topic",
    taskType: "feature",
    phase: "coding",
    startedAt: "2026-11-08T01:00:00.000Z",
  });
  await simpan({
    sessionKey,
    taskId: "task-b",
    machine: "HELLOWORLD",
    projectName: "proyek",
    task: "second topic",
    taskType: "bugfix",
    phase: "coding",
    startedAt: "2026-11-08T02:00:00.000Z",
    parentTask: { taskId: "task-a", title: "first topic", startedAt: "2026-11-08T01:00:00.000Z" },
  });

  const rows = await kartu(sessionKey);
  assert.equal(rows.length, 2, "the first card must survive the second start_task");
  assert.deepEqual(rows.map((r) => r.task_id), ["task-a", "task-b"]);
  assert.equal(rows[0].phase, "handed-off");
  assert.equal(rows[1].phase, "coding");
  assert.equal(rows[1].parent_task_id, "task-a");
  assert.equal(rows[1].parent_task_title, "first topic");
});

test("a later heartbeat of the same card updates it instead of adding a row", async (t) => {
  if (lewati(t)) return;
  const sessionKey = PREFIX + "update";

  await simpan({ sessionKey, taskId: "task-a", machine: "HELLOWORLD", projectName: "proyek", task: "solo", phase: "coding" });
  await simpan({ sessionKey, taskId: "task-a", machine: "HELLOWORLD", projectName: "proyek", task: "solo", phase: "testing" });

  const rows = await kartu(sessionKey);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phase, "testing");
});

test("a snapshot without a task id keeps the old single-card behaviour", async (t) => {
  if (lewati(t)) return;
  const sessionKey = PREFIX + "legacy";

  await simpan({ sessionKey, machine: "HELLOWORLD", projectName: "proyek", task: "legacy", phase: "coding" });
  await simpan({ sessionKey, machine: "HELLOWORLD", projectName: "proyek", task: "legacy", phase: "testing" });

  const rows = await kartu(sessionKey);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, "");
});

test("the migration can run twice without failing", async (t) => {
  if (lewati(t)) return;
  await terapkanMigrasi();
  await terapkanMigrasi();
  const r = await pool.query(
    `SELECT pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE rel.relname = 'sessions' AND nsp.nspname = current_schema() AND con.contype = 'p'`,
  );
  assert.equal(r.rows[0].definition, "PRIMARY KEY (session_key, task_id)");
});
