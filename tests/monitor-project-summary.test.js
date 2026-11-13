import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildProjectSummaryQuery,
  formatDuration,
  DEFAULT_SUMMARY_DAYS,
} = require("../monitor-server/project-summary.cjs");

/**
 * Timer sudah terkumpul sejak awal, tetapi angkanya tidak pernah dijumlahkan.
 * Pemilik hanya melihat "⏱ 45:26" per sesi dan tidak pernah tahu ke mana
 * waktunya pergi. Rekap ini menjawab pertanyaan yang sebenarnya: proyek mana
 * yang menghabiskan waktu paling banyak minggu ini.
 *
 * CATATAN PENTING: rekap ini hanya mungkin karena `project_name` tidak lagi
 * terhapus saat task ditutup. Sebelum perbaikan itu, 5 dari 9 sesi kehilangan
 * nama proyeknya tepat ketika selesai - jadi rekap akan tampil kosong.
 */

test("durasi dijumlahkan per proyek, dihitung database", () => {
  const { sql } = buildProjectSummaryQuery({});
  assert.match(sql, /project_name AS project/);
  assert.match(sql, /GROUP BY 1/);
  assert.match(sql, /SUM\(/);
});

test("sesi tanpa nama proyek atau tanpa task ditolak dari rekap (tidak ada lagi '(tanpa proyek)')", () => {
  const { sql } = buildProjectSummaryQuery({});
  assert.doesNotMatch(sql, /\(tanpa proyek\)/);
  assert.match(sql.toLowerCase(), /nullif\(btrim\(project_name\),\s*''\)\s+is not null/);
  assert.match(sql.toLowerCase(), /nullif\(btrim\(task\),\s*''\)\s+is not null/);
  assert.ok(!/COALESCE\(project_name, session_title\)/.test(sql), "jangan menebak dari judul");
});

test("sesi yang belum selesai tidak dihitung sebagai durasi final", () => {
  // Durasi sesi berjalan masih bertambah; memasukkannya membuat rekap berubah
  // setiap 3 detik dan tidak bisa dibandingkan antar hari.
  const { sql } = buildProjectSummaryQuery({});
  assert.match(sql, /started_at IS NOT NULL/);
  // Sesi yang ditutup manual (closed) dan sesi selesai (done) juga final:
  // mengabaikannya membuat rekap kehilangan pekerjaan yang benar-benar selesai.
  assert.match(sql, /phase IN \('idle', 'closed', 'done', 'cancelled'\)/);
});

test("batas hari bisa diatur dan nilai aneh jatuh ke bawaan", () => {
  assert.equal(buildProjectSummaryQuery({}).params[0], String(DEFAULT_SUMMARY_DAYS));
  assert.equal(buildProjectSummaryQuery({ days: 30 }).params[0], "30");
  assert.equal(buildProjectSummaryQuery({ days: "abc" }).params[0], String(DEFAULT_SUMMARY_DAYS));
});

test("jumlah proyek dibatasi supaya layar tidak dibanjiri", () => {
  assert.equal(buildProjectSummaryQuery({ limit: 5 }).params[1], 5);
  assert.equal(buildProjectSummaryQuery({ limit: 9999 }).params[1], 50);
});

test("format durasi rekap terbaca manusia", () => {
  assert.equal(formatDuration(45), "45d");
  assert.equal(formatDuration(3725), "1j 02m");
  assert.equal(formatDuration(0), "0d");
  assert.equal(formatDuration(null), null);
});

test("rekap juga membawa jumlah sesi dan jumlah yang macet", () => {
  const { sql } = buildProjectSummaryQuery({});
  assert.match(sql, /count\(\*\)/);
});