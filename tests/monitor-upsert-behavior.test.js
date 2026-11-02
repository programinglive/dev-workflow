import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSessionUpsert } = require("../monitor-server/session-upsert.cjs");

/**
 * TES PERILAKU, BUKAN TES BENTUK SQL
 * ==================================
 * Versi pertama perbaikan `agent_tool` LULUS semua tes sambil tetap salah.
 * Tesnya memeriksa TEKS SQL ("apakah ada COALESCE(NULLIF(...))"), dan teks itu
 * memang ada - tetapi artinya tidak sesuai harapan: 'unknown' bukan string
 * kosong, jadi NULLIF tidak menangkapnya dan label 'codex' tetap tertimpa.
 *
 * Diuji di produksi 2 November 2026:
 *   laporan dengan agentTool=codex   -> tersimpan codex
 *   laporan berikutnya unknown       -> tersimpan unknown   <- codex HILANG
 *
 * Karena itu tes ini menjalankan SQL SUNGGUHAN ke PostgreSQL dan memeriksa ISI
 * TABEL sesudahnya. Tes yang tidak pernah menyentuh database tidak akan bisa
 * menangkap kelas kesalahan ini lagi.
 *
 * Butuh PostgreSQL. Bila tidak tersedia, tes DILEWATI dengan alasan yang
 * terlihat - bukan lulus diam-diam.
 */

/**
 * Koneksi diambil dari variabel yang SAMA dengan tes database lain.
 *
 * Versi pertama hanya membaca DEVWF_TEST_PG, sementara db-adapters.test.js
 * membaca TEST_POSTGRES_URL. Akibatnya menyetel variabel yang "benar" menurut
 * dokumentasi membuat tes ini tetap terlewat - dan tes yang terlewat diam-diam
 * pada akhirnya sama saja dengan tidak ada.
 */
const KONEKSI =
  process.env.TEST_POSTGRES_URL ||
  process.env.DEVWF_TEST_PG ||
  "postgresql://postgres@127.0.0.1:5599/postgres";

let pg = null;
let pool = null;
let siap = false;
let alasanLewat = "";

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_key text PRIMARY KEY,
  machine text, project_path text, project_name text,
  task text, task_type text, phase text,
  plan_json jsonb, plan_done integer, plan_total integer,
  dod_done integer, dod_total integer, dod_waived integer,
  owner_pid integer, started_at timestamptz, updated_at timestamptz,
  session_title text, agent_tool text
);`;

before(async () => {
  try {
    pg = require("pg");
  } catch {
    alasanLewat = "modul pg tidak tersedia";
    return;
  }
  try {
    pool = new pg.Pool({ connectionString: KONEKSI, max: 2, connectionTimeoutMillis: 3000 });
    await pool.query("SELECT 1");
    await pool.query(DDL);
    siap = true;
  } catch (e) {
    alasanLewat = `PostgreSQL tidak bisa dihubungi (${KONEKSI}): ${e.message}`;
  }
});

after(async () => {
  if (pool) await pool.end().catch(() => {});
});

async function simpan(body) {
  const { sql, params } = buildSessionUpsert(body);
  await pool.query(sql, params);
}

async function baca(kunci) {
  const r = await pool.query(
    `SELECT project_name, project_path, task, session_title, agent_tool, started_at
       FROM sessions WHERE session_key = $1`,
    [kunci],
  );
  return r.rows[0];
}

async function bersihkan() {
  await pool.query("DELETE FROM sessions WHERE session_key LIKE 'ses_uji_%'");
}

function lewati(t) {
  if (!siap) {
    t.skip(alasanLewat || "PostgreSQL tidak tersedia");
    return true;
  }
  return false;
}

const DASAR = {
  sessionKey: "ses_uji_agent",
  machine: "HELLOWORLD",
  projectPath: "/code/proyek",
  projectName: "proyek",
  task: "kerja",
  taskType: "bugfix",
  phase: "coding",
  agentTool: "codex",
};

test("label codex TIDAK tertimpa unknown pada laporan berikutnya", async (t) => {
  if (lewati(t)) return;
  await bersihkan();

  await simpan(DASAR);
  assert.equal((await baca(DASAR.sessionKey)).agent_tool, "codex");

  // Laporan berikutnya: detectTool gagal mengenali dan mengirim 'unknown'.
  await simpan({ ...DASAR, task: "", phase: "idle", agentTool: "unknown" });

  assert.equal(
    (await baca(DASAR.sessionKey)).agent_tool,
    "codex",
    "'unknown' berarti TIDAK TAHU, bukan informasi baru; label lama harus bertahan",
  );
});

test("tool lain yang benar-benar baru tetap boleh menggantikan", async (t) => {
  if (lewati(t)) return;
  await bersihkan();

  await simpan(DASAR);
  await simpan({ ...DASAR, agentTool: "opencode" });
  assert.equal((await baca(DASAR.sessionKey)).agent_tool, "opencode");
});

test("sesi baru tanpa info tool tetap tercatat sebagai unknown", async (t) => {
  if (lewati(t)) return;
  await bersihkan();

  await simpan({ ...DASAR, sessionKey: "ses_uji_baru", agentTool: "unknown" });
  assert.equal((await baca("ses_uji_baru")).agent_tool, "unknown");
});

test("project_name dan project_path bertahan saat task ditutup", async (t) => {
  if (lewati(t)) return;
  await bersihkan();

  await simpan(DASAR);
  await simpan({ ...DASAR, task: "", phase: "idle", projectName: "", projectPath: "", agentTool: "unknown" });

  const row = await baca(DASAR.sessionKey);
  assert.equal(row.project_name, "proyek");
  assert.equal(row.project_path, "/code/proyek");
  assert.equal(row.task, "", "task tetap boleh dikosongkan");
});

test("started_at tidak hilang oleh laporan tanpa waktu mulai", async (t) => {
  if (lewati(t)) return;
  await bersihkan();

  const mulai = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  await simpan({ ...DASAR, startedAt: mulai });
  await simpan({ ...DASAR, startedAt: "" });

  assert.ok((await baca(DASAR.sessionKey)).started_at, "started_at tidak boleh hilang");
});

test("pembersihan: tidak ada baris uji yang tertinggal", async (t) => {
  if (lewati(t)) return;
  await bersihkan();
  const r = await pool.query("SELECT count(*)::int AS n FROM sessions WHERE session_key LIKE 'ses_uji_%'");
  assert.equal(r.rows[0].n, 0);
});