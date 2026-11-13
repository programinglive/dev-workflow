import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildHealth, DEFAULT_STALE_AFTER_MS } = require("../monitor-server/health.cjs");

/**
 * Masalah yang ditutup: dashboard yang mati tampak IDENTIK dengan dashboard
 * yang memang tidak ada pekerjaan. Diukur 1 November 2026 dengan mematikan
 * service: layar tablet tidak berubah sama sekali.
 *
 * Yang diuji adalah "kapan laporan terakhir masuk", bukan "apakah ada
 * pekerjaan" - karena berhentinya pekerjaan itu normal, berhentinya pelaporan
 * itu kerusakan.
 */

const NOW = new Date("2026-11-01T12:00:00Z");
const menitLalu = (n) => new Date(NOW.getTime() - n * 60 * 1000);

test("laporan baru: tidak basi", () => {
  const h = buildHealth({ lastReportAt: menitLalu(2), now: NOW });
  assert.equal(h.stale, false);
  assert.equal(h.never, false);
  assert.equal(h.ageMs, 2 * 60 * 1000);
});

test("laporan tua melewati batas: basi", () => {
  const h = buildHealth({ lastReportAt: menitLalu(30), now: NOW });
  assert.equal(h.stale, true);
  assert.equal(h.never, false);
});

test("belum pernah ada laporan: basi dan ditandai never", () => {
  for (const value of [null, undefined, ""]) {
    const h = buildHealth({ lastReportAt: value, now: NOW });
    assert.equal(h.stale, true, `nilai ${String(value)} harus dianggap basi`);
    assert.equal(h.never, true);
    assert.equal(h.lastReportAt, null);
  }
});

test("batas bisa diatur, dan tepat di batas belum dianggap basi", () => {
  const tepat = buildHealth({ lastReportAt: menitLalu(10), now: NOW, staleAfterMs: 10 * 60 * 1000 });
  assert.equal(tepat.stale, false, "tepat di batas belum basi");
  const lewat = buildHealth({ lastReportAt: menitLalu(10.1), now: NOW, staleAfterMs: 10 * 60 * 1000 });
  assert.equal(lewat.stale, true);
  // Nilai bawaan 10 menit.
  assert.equal(DEFAULT_STALE_AFTER_MS, 10 * 60 * 1000);
});

test("umur tidak pernah negatif walau jam mesin bergeser", () => {
  // Laporan bertanggal masa depan (jam pengirim lebih maju) tidak boleh
  // menghasilkan umur negatif yang membuat tampilan aneh.
  const h = buildHealth({ lastReportAt: new Date(NOW.getTime() + 60_000), now: NOW });
  assert.equal(h.ageMs, 0);
  assert.equal(h.stale, false);
});

test("tanggal berbentuk string dari Postgres tetap dipahami", () => {
  const h = buildHealth({ lastReportAt: "2026-11-01 11:30:00+00", now: NOW });
  assert.equal(h.stale, true);
  assert.ok(h.lastReportAt.startsWith("2026-11-01T11:30:00"));
});
