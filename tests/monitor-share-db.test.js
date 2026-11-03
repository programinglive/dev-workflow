import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ensureTableSql, generateToken, buildInsertLink, buildLiveLinkQuery,
  buildRevokeLink, buildTokenLookup, buildTouchView, buildRevokeOrphans, classifyShareLookup,
} = require("../monitor-server/share-links.cjs");

/**
 * TES PERILAKU TERHADAP POSTGRES SUNGGUHAN
 * ========================================
 * Repo ini sudah pernah meloloskan bug nyata karena tesnya hanya memeriksa
 * TEKS SQL: `COALESCE(NULLIF(...))` terlihat benar di berkas, tetapi artinya
 * tidak sesuai harapan, dan datanya hilang di produksi.
 *
 * Aturan yang hanya bisa dibuktikan oleh database diuji di sini:
 *
 *   1. indeks unik parsial benar-benar mencegah dua tautan hidup per sesi;
 *   2. `ON CONFLICT ... DO NOTHING` benar-benar tidak mengganti token lama;
 *   3. sesi yang dicabut bisa dibuat ulang tanpa melanggar indeks itu;
 *   4. LEFT JOIN benar-benar membedakan "sesi hilang" dari "token tidak ada".
 *
 * Butuh PostgreSQL. Bila tidak tersedia, tes DILEWATI dengan alasan yang
 * terlihat - bukan lulus diam-diam.
 */

const KONEKSI = process.env.TEST_POSTGRES_URL || process.env.DEVWF_TEST_PG || "";

let pool = null;
let siap = false;
let alasanLewat = "";

const DDL_SESI = `
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
  if (!KONEKSI) {
    alasanLewat = "TEST_POSTGRES_URL kosong - tes perilaku database dilewati";
    return;
  }
  try {
    pool = require("pg").Pool;
  } catch {
    alasanLewat = "modul pg tidak tersedia";
    return;
  }
  const p = new pool({ connectionString: KONEKSI, max: 2, connectionTimeoutMillis: 5000 });
  try {
    await p.query("SELECT 1");
    await p.query(DDL_SESI);
    await p.query(ensureTableSql);
    pool = p;
    siap = true;
  } catch (e) {
    alasanLewat = `PostgreSQL tidak bisa dipakai (${e.message})`;
    try { await p.end(); } catch { /* sudah tutup */ }
    pool = null;
  }
});

after(async () => {
  if (pool) {
    await pool.query("DELETE FROM share_links WHERE session_key LIKE 'ses_share_uji%'").catch(() => {});
    await pool.query("DELETE FROM sessions WHERE session_key LIKE 'ses_share_uji%'").catch(() => {});
    await pool.end().catch(() => {});
  }
});

function lewati(t) {
  if (!siap) {
    t.skip(alasanLewat || "PostgreSQL tidak tersedia");
    return true;
  }
  return false;
}

const KUNCI = "ses_share_uji_1";

async function siapkanSesi(kunci = KUNCI) {
  await pool.query(
    `INSERT INTO sessions (session_key, machine, project_name, task, task_type, phase,
                           plan_json, plan_done, plan_total, dod_done, dod_total, dod_waived,
                           started_at, updated_at)
     VALUES ($1,'MESIN_RAHASIA','PROYEK_RAHASIA','kerja','feature','coding',
             '[]'::jsonb, 0, 0, 1, 2, 0, now() - interval '5 minutes', now())
     ON CONFLICT (session_key) DO NOTHING`,
    [kunci],
  );
}

async function bersihkan() {
  await pool.query("DELETE FROM share_links WHERE session_key LIKE 'ses_share_uji%'");
  await pool.query("DELETE FROM sessions WHERE session_key LIKE 'ses_share_uji%'");
}

test("DDL bisa dijalankan dua kali tanpa gagal", async (t) => {
  if (lewati(t)) return;
  await assert.doesNotReject(() => pool.query(ensureTableSql));
});

test("dua tautan hidup untuk sesi yang sama ditolak indeks, bukan hanya SQL", async (t) => {
  if (lewati(t)) return;
  await bersihkan();
  await siapkanSesi();

  const pertama = buildInsertLink({ token: generateToken(), sessionKey: KUNCI });
  const a = await pool.query(pertama.sql, pertama.params);
  assert.equal(a.rowCount, 1, "tautan pertama harus masuk");

  const kedua = buildInsertLink({ token: generateToken(), sessionKey: KUNCI });
  const b = await pool.query(kedua.sql, kedua.params);
  assert.equal(b.rowCount, 0, "tautan kedua DIAMINKAN, bukan mengganti yang lama");

  const q = buildLiveLinkQuery({ sessionKey: KUNCI });
  const live = await pool.query(q.sql, q.params);
  assert.equal(live.rowCount, 1, "tetap satu tautan hidup");
  assert.equal(live.rows[0].token, a.rows[0].token, "token lama tidak boleh berubah");
});

test("sesudah dicabut, sesi yang sama boleh punya tautan baru", async (t) => {
  if (lewati(t)) return;
  await bersihkan();
  await siapkanSesi();

  const lama = buildInsertLink({ token: generateToken(), sessionKey: KUNCI });
  const a = await pool.query(lama.sql, lama.params);

  const cabut = buildRevokeLink({ token: a.rows[0].token });
  const c = await pool.query(cabut.sql, cabut.params);
  assert.equal(c.rowCount, 1, "pencabutan harus mengubah satu baris");

  const baru = buildInsertLink({ token: generateToken(), sessionKey: KUNCI });
  const b = await pool.query(baru.sql, baru.params);
  assert.equal(b.rowCount, 1, "indeks parsial mengizinkan tautan baru sesudah yang lama dicabut");
  assert.notEqual(b.rows[0].token, a.rows[0].token);

  // Yang lama tetap ada di tabel, hanya berstatus dicabut.
  const semua = await pool.query("SELECT count(*)::int AS n FROM share_links WHERE session_key = $1", [KUNCI]);
  assert.equal(semua.rows[0].n, 2, "baris lama tidak dihapus");
});

test("pencabutan kedua tidak mengubah apa pun", async (t) => {
  if (lewati(t)) return;
  await bersihkan();
  await siapkanSesi();

  const ins = buildInsertLink({ token: generateToken(), sessionKey: KUNCI });
  const a = await pool.query(ins.sql, ins.params);
  const cabut = buildRevokeLink({ token: a.rows[0].token });

  assert.equal((await pool.query(cabut.sql, cabut.params)).rowCount, 1);
  assert.equal((await pool.query(cabut.sql, cabut.params)).rowCount, 0, "mencabut dua kali = 0 baris");
});

test("token yang ada tapi sesinya sudah dibersihkan terbaca sebagai session_gone", async (t) => {
  if (lewati(t)) return;
  await bersihkan();
  await siapkanSesi();

  const ins = buildInsertLink({ token: generateToken(), sessionKey: KUNCI });
  const a = await pool.query(ins.sql, ins.params);

  // Retensi membuang sesi; tautan sengaja TIDAK ikut dihapus.
  await pool.query("DELETE FROM sessions WHERE session_key = $1", [KUNCI]);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM share_links WHERE session_key = $1", [KUNCI])).rows[0].n,
    1,
    "menghapus sesi tidak boleh menghapus tautannya",
  );

  const q = buildTokenLookup({ token: a.rows[0].token });
  const hasil = await pool.query(q.sql, q.params);
  assert.equal(hasil.rowCount, 1, "LEFT JOIN harus tetap mengembalikan baris tautan");
  assert.equal(hasil.rows[0].live_session_key, null);
  assert.deepEqual(classifyShareLookup(hasil.rows[0]), { status: 404, reason: "session_gone" });
});

test("token karangan tidak menghasilkan baris", async (t) => {
  if (lewati(t)) return;
  const q = buildTokenLookup({ token: generateToken() });
  const hasil = await pool.query(q.sql, q.params);
  assert.equal(hasil.rowCount, 0);
  assert.deepEqual(classifyShareLookup(undefined), { status: 404, reason: "unknown" });
});

test("kunjungan menambah views dan tidak menyentuh isi sesi", async (t) => {
  if (lewati(t)) return;
  await bersihkan();
  await siapkanSesi();

  const ins = buildInsertLink({ token: generateToken(), sessionKey: KUNCI });
  const a = await pool.query(ins.sql, ins.params);
  const token = a.rows[0].token;

  const sebelum = await pool.query("SELECT task, machine FROM sessions WHERE session_key = $1", [KUNCI]);
  const sentuh = buildTouchView({ token });
  await pool.query(sentuh.sql, sentuh.params);
  await pool.query(sentuh.sql, sentuh.params);

  const sesudah = await pool.query(
    "SELECT views, last_view_at FROM share_links WHERE token = $1",
    [token],
  );
  assert.equal(sesudah.rows[0].views, 2);
  assert.ok(sesudah.rows[0].last_view_at, "waktu kunjungan terakhir dicatat");

  const sesi = await pool.query("SELECT task, machine FROM sessions WHERE session_key = $1", [KUNCI]);
  assert.deepEqual(sesi.rows[0], sebelum.rows[0], "membaca tautan tidak boleh mengubah sesi");
});

test("tautan yang sesinya masih ada TIDAK ikut dicabut massal, walau sudah lama idle", async (t) => {
  if (lewati(t)) return;
  await bersihkan();
  await siapkanSesi();

  const ins = buildInsertLink({ token: generateToken(), sessionKey: KUNCI });
  const a = await pool.query(ins.sql, ins.params);
  const tokenHidup = a.rows[0].token;

  // Sesi dibuat 3 jam lalu dan `idle` - pada dasarnya invisible di dashboard,
  // tetapi barisnya MASIH ADA dan tautannya masih punya isi untuk ditampilkan.
  await siapkanSesi("ses_share_uji_idle");
  await pool.query(
    "UPDATE sessions SET phase='idle', updated_at = now() - interval '3 hours' WHERE session_key='ses_share_uji_idle'",
  );
  const ins2 = buildInsertLink({ token: generateToken(), sessionKey: "ses_share_uji_idle" });
  const b = await pool.query(ins2.sql, ins2.params);

  // Satu tautan yatim: sesinya benar-benar tidak ada.
  const ins3 = buildInsertLink({ token: generateToken(), sessionKey: "ses_share_uji_hantu" });
  await pool.query(ins3.sql, ins3.params);

  const hapus = buildRevokeOrphans();
  const hasil = await pool.query(hapus.sql, hapus.params);
  assert.equal(hasil.rowCount, 1, "hanya tautan yatim yang dicabut");

  const cek = await pool.query(
    "SELECT session_key, revoked_at FROM share_links WHERE session_key LIKE 'ses_share_uji%'",
  );
  const peta = Object.fromEntries(cek.rows.map((r) => [r.session_key, r.revoked_at]));
  assert.equal(peta[KUNCI], null, "sesi aktif tetap bisa dibagikan");
  assert.equal(peta["ses_share_uji_idle"], null, "sesi idle 3 jam BUKAN yatim: jangan dicabut");
  assert.ok(peta["ses_share_uji_hantu"], "hanya yang sesinya hilang yang dicabut");

  // Barisnya tidak dihapus, hanya dicabut.
  const total = await pool.query("SELECT count(*)::int AS n FROM share_links WHERE session_key LIKE 'ses_share_uji%'");
  assert.equal(total.rows[0].n, 3, "tidak ada baris yang hilang");
  assert.ok(tokenHidup && b.rows[0].token);
});

test("pencabutan massal kedua tidak mengubah apa pun", async (t) => {
  if (lewati(t)) return;
  const { sql, params } = buildRevokeOrphans();
  const kedua = await pool.query(sql, params);
  assert.equal(kedua.rowCount, 0, "idempoten: tidak ada yatim tersisa");
});

test("tidak ada baris uji yang tertinggal", async (t) => {
  if (lewati(t)) return;
  await bersihkan();
  const r = await pool.query("SELECT count(*)::int AS n FROM share_links WHERE session_key LIKE 'ses_share_uji%'");
  assert.equal(r.rows[0].n, 0);
});
