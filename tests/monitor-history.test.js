import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildHistoryQuery, formatDuration, DEFAULT_HISTORY_DAYS } = require(
  "../monitor-server/history-query.cjs",
);

/**
 * Pemilik meminta counter waktu "biar tau berapa lama task itu selesai".
 * Tetapi sesi idle disembunyikan, sehingga durasi akhir HILANG justru saat
 * task selesai. Riwayat menutup itu tanpa menghapus apa pun.
 */

test("riwayat memakai waktu mulai sebagai syarat, bukan task", () => {
  const { sql } = buildHistoryQuery({});
  assert.match(sql, /phase = 'idle'/);
  // `task` DIKOSONGKAN saat task ditutup, jadi tidak boleh jadi syarat -
  // filter seperti itu membuat riwayat SELALU kosong.
  assert.ok(!/task <> ''/.test(sql), "jangan menyaring pakai task");
  // Tanpa waktu mulai, durasi tidak bisa dihitung.
  assert.match(sql, /started_at IS NOT NULL/);
  assert.match(sql, /\$1::text \|\| ' days'/);
  assert.equal(buildHistoryQuery({}).params[0], String(DEFAULT_HISTORY_DAYS));
});

test("durasi dihitung database, bukan aplikasi", () => {
  const { sql } = buildHistoryQuery({});
  // Memakai jam database membuat durasi sama di semua perangkat.
  assert.match(sql, /EXTRACT\(EPOCH FROM \(updated_at - started_at\)\)/);
  // Bila started_at tidak ada, durasi TIDAK dikarang.
  assert.match(sql, /CASE WHEN started_at IS NULL THEN NULL/);
});

test("batas jumlah dibatasi supaya satu layar tidak dibanjiri", () => {
  assert.equal(buildHistoryQuery({ limit: 5 }).params[1], 5);
  assert.equal(buildHistoryQuery({ limit: 999 }).params[1], 50, "maksimum 50");
  assert.equal(buildHistoryQuery({ limit: 0 }).params[1], 12, "nol jatuh ke bawaan");
});

test("nilai aneh jatuh ke bawaan, bukan menghasilkan SQL rusak", () => {
  assert.equal(buildHistoryQuery({ historyDays: "abc" }).params[0], String(DEFAULT_HISTORY_DAYS));
  assert.equal(buildHistoryQuery({ historyDays: -3 }).params[0], String(DEFAULT_HISTORY_DAYS));
});

test("format durasi terbaca manusia", () => {
  assert.equal(formatDuration(45), "45d");
  assert.equal(formatDuration(65), "1m 05d");
  assert.equal(formatDuration(3725), "1j 02m");
  assert.equal(formatDuration(0), "0d");
  // Tidak ada data: jangan mengarang angka.
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(undefined), null);
  assert.equal(formatDuration("bukan angka"), null);
  // Jam perangkat yang bergeser tidak boleh menghasilkan durasi negatif.
  assert.equal(formatDuration(-100), "0d");
});
