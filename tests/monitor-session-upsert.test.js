import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSessionUpsert } = require("../monitor-server/session-upsert.cjs");

/**
 * BUG NYATA (2 November 2026): 5 dari 9 sesi tidak punya `project_name`, dan
 * yang kehilangan justru sesi yang SUDAH SELESAI.
 *
 * Sebabnya: `project_name=EXCLUDED.project_name` menimpa nilai lama dengan
 * string kosong. Saat `complete_task`, pelapor tidak mengirim `projectPath`,
 * jadi nama proyek terhapus tepat ketika pekerjaan itu selesai - yaitu saat
 * catatannya paling berguna.
 *
 * `session_title` sudah dijaga dengan COALESCE(NULLIF(...)) sejak awal.
 * `project_name` terlewat. Bentuk bug ini sama dengan yang berulang kali saya
 * buat: nilai yang belum dikirim dianggap sama dengan "hapus".
 */

const SESI = {
  sessionKey: "ses_uji",
  machine: "HELLOWORLD",
  projectPath: "D:\\code\\dev-workflow-mcp-server",
  projectName: "dev-workflow-mcp-server",
  task: "Kerjakan sesuatu",
  taskType: "bugfix",
  phase: "coding",
};

/**
 * PENTING: berkas ini menguji SUSUNAN SQL dan nilai parameter. Itu perlu,
 * tetapi TIDAK CUKUP.
 *
 * Versi pertama perbaikan `agent_tool` lulus seluruh berkas ini sambil tetap
 * salah, karena 'unknown' bukan string kosong sehingga NULLIF tidak
 * menangkapnya. Perilaku sesungguhnya diuji dengan PostgreSQL sungguhan di
 * tests/monitor-upsert-behavior.test.js.
 */

test("kiriman project_name kosong tidak menghapus nama yang sudah ada", () => {
  const { sql } = buildSessionUpsert(SESI);
  assert.match(
    sql,
    /project_name=COALESCE\(NULLIF\(EXCLUDED\.project_name, ''\), sessions\.project_name\)/,
  );
});

test("kiriman project_path kosong juga tidak menghapus jalur lama", () => {
  const { sql } = buildSessionUpsert(SESI);
  assert.match(
    sql,
    /project_path=COALESCE\(NULLIF\(EXCLUDED\.project_path, ''\), sessions\.project_path\)/,
  );
});

test("nama proyek yang BARU tetap boleh menggantikan yang lama", () => {
  // Kalau sesi pindah proyek, nilai baru harus menang. COALESCE hanya
  // melindungi dari string kosong, bukan dari perubahan yang sah.
  const { sql } = buildSessionUpsert(SESI);
  assert.ok(
    !/project_name=sessions\.project_name\b/.test(sql),
    "jangan mengunci nama lama secara mutlak",
  );
});

test("task juga tidak boleh dihapus oleh kiriman kosong saat task ditutup", () => {
  // Ketika complete_task dipanggil, state di-reset sehingga laporan penutupan
  // mengirim task="". Kalau task ditimpa string kosong, kartu di Riwayat dan
  // kartu idle 30 menit berubah menjadi "(tanpa task)" atau hanya judul chat.
  const { sql } = buildSessionUpsert(SESI);
  assert.match(
    sql,
    /task=COALESCE\(NULLIF\(EXCLUDED\.task, ''\), sessions\.task\)/,
  );
});

test("parameter dikirim berurutan dan berisi nilai yang diberikan", () => {
  const { params } = buildSessionUpsert(SESI);
  assert.equal(params[0], "ses_uji");
  assert.equal(params[1], "HELLOWORLD");
  assert.equal(params[3], "dev-workflow-mcp-server");
});

test("sessionKey kosong ditolak, bukan disimpan sebagai baris tanpa kunci", () => {
  assert.throws(() => buildSessionUpsert({ ...SESI, sessionKey: "" }), /sessionKey/);
});

test("'unknown' bukan string kosong - itu yang membuat label tertimpa", () => {
  // KESALAHAN SAYA: versi pertama hanya memasang COALESCE(NULLIF(...)) dan
  // dianggap selesai, lalu tes ini MEMERIKSA TEKS SQL-NYA dan LULUS.
  // Padahal 'unknown' bukan '', jadi ia lolos NULLIF dan tetap menimpa 'codex'.
  // Terbukti di produksi: codex -> unknown.
  //
  // Karena itu di sini yang diuji adalah NILAI yang dikirim ke database, dan
  // perilaku penyimpanannya diuji sungguhan di
  // tests/monitor-upsert-behavior.test.js (menjalankan SQL ke PostgreSQL).
  const { params } = buildSessionUpsert({ ...SESI, agentTool: "unknown" });
  assert.equal(params[16], "unknown", "'unknown' tetap dikirim apa adanya");
  const { params: kosong } = buildSessionUpsert({ ...SESI, agentTool: "" });
  assert.equal(kosong[16], "unknown", "tanpa info tetap dicatat unknown, bukan string kosong");
});

test("SQL menyatakan aturan 'unknown tidak menimpa' secara eksplisit", () => {
  const { sql } = buildSessionUpsert(SESI);
  assert.match(sql, /WHEN lower\(EXCLUDED\.agent_tool\) = 'unknown'/);
  assert.match(sql, /COALESCE\(NULLIF\(sessions\.agent_tool, ''\), 'unknown'\)/);
});

test("nama tool dinormalkan ke huruf kecil", () => {
  const { params } = buildSessionUpsert({ ...SESI, agentTool: "Codex" });
  assert.equal(params[16], "codex");
});