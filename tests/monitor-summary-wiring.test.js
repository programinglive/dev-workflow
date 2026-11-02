import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildProjectSummaryQuery, formatDuration } = require("../monitor-server/project-summary.cjs");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");
const app = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");

/**
 * Rekap durasi per proyek yang benar tetapi tidak pernah dipanggil atau tidak
 * pernah tampil tidak berguna. Tes ini menjaga rantainya: server menghitung,
 * respons membawa, dan kedua layar menampilkan.
 */

test("server mengirim rekap di respons /api/sessions", () => {
  assert.match(dash, /require\('\.\/project-summary\.cjs'\)/);
  assert.match(dash, /const sq = buildProjectSummaryQuery\(\{ days: SUMMARY_DAYS \}\)/);
  // `shares` menyusul di antara `summary` dan `summary_days`; yang dijaga di
  // sini adalah rekapnya tetap ikut terkirim, bukan urutan kata yang persis.
  assert.match(dash, /history, alerts, summary, shares, summary_days: SUMMARY_DAYS \}\)/);
});

test("durasi rekap diberi label di server, bukan dihitung ulang di layar", () => {
  // Kalau tiap layar menghitung sendiri, web dan tablet bisa berbeda angka.
  assert.match(dash, /total_label: formatDurationSummary\(r\.total_seconds\)/);
});

test("halaman web punya bagian rekap", () => {
  assert.match(dash, /<div id="summary" class="events"><\/div>/);
  assert.match(dash, /document\.getElementById\('summary'\)\.innerHTML = \(data\.summary \|\| \[\]\)/);
  assert.match(dash, /Waktu per proyek/);
});

test("aplikasi punya tab Rekap dan membacanya dari server", () => {
  assert.match(app, /const rekap = \(data && data\.summary\) \|\| \[\];/);
  assert.match(app, /id: "rekap", ikon: "Σ", label: "Rekap"/);
  assert.match(app, /tab === "rekap" &&/);
  assert.match(app, /rekap\.map\(\(r\) =>/);
});

test("label durasi memakai format yang sama dengan riwayat", () => {
  assert.equal(formatDuration(3725), "1j 02m");
  assert.equal(formatDuration(65), "1m 05d");
});
