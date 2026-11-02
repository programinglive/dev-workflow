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

test("task tetap boleh dikosongkan - itu memang cara menutup task", () => {
  // Berbeda dengan project_name: `task=''` adalah sinyal sah bahwa task
  // ditutup, jadi jangan "dilindungi" dengan cara yang sama.
  const { sql } = buildSessionUpsert(SESI);
  assert.match(sql, /(^|[\s,])task=EXCLUDED\.task/);
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

test("nilai bawaan 'unknown' tidak boleh menimpa label tool yang asli", () => {
  // Perangkap halus: kalau agent_tool diisi 'unknown' sebagai bawaan, maka
  // COALESCE(NULLIF(EXCLUDED.agent_tool,''), ...) tetap MENGISI nilai itu -
  // 'unknown' bukan string kosong. Akibatnya label 'codex' yang sudah benar
  // tertimpa 'unknown' pada laporan berikutnya.
  const { sql } = buildSessionUpsert({ ...SESI, agentTool: "" });
  assert.match(
    sql,
    /agent_tool=COALESCE\(NULLIF\(EXCLUDED\.agent_tool, ''\), sessions\.agent_tool, 'unknown'\)/,
    "bawaan 'unknown' harus jadi pilihan TERAKHIR, setelah nilai lama",
  );
});