import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildHistoryQuery, formatDuration, DEFAULT_HISTORY_DAYS } = require(
  "../monitor-server/history-query.cjs",
);

/**
 * Pemilik meminta counter waktu "biar tau berapa lama task itu selesai", dan
 * kemudian tab riwayat dengan filter status.
 *
 * Karena ada filter status, riwayat TIDAK boleh hanya berisi sesi idle -
 * filter "berjalan" dan "macet" akan selalu kosong dan tombolnya jadi hiasan.
 * Statusnya diturunkan dengan aturan yang sama seperti kartu aktif.
 */

test("riwayat memuat semua status, bukan hanya idle", () => {
  const { sql } = buildHistoryQuery({});
  // Filter phase akan membuat filter status di layar sia-sia.
  assert.ok(!/phase = 'idle'/.test(sql), "jangan menyaring hanya idle");
  assert.match(sql, /phase,/);
});

test("syaratnya bukan task", () => {
  const { sql } = buildHistoryQuery({});
  // `task` DIKOSONGKAN saat task ditutup, jadi tidak boleh jadi syarat.
  assert.ok(!/task <> ''/.test(sql), "jangan menyaring pakai task");
  assert.match(sql, /machine <> ''/);
});

test("sesi tanpa started_at TETAP masuk riwayat", () => {
  // BUG NYATA (2 November 2026): 3 dari 9 sesi hilang dari tab Riwayat karena
  // saya menjadikan `started_at IS NOT NULL` sebagai syarat. Sesi itu jelas
  // terlihat di tab Aktif, lalu tidak ditemukan saat dicari di Riwayat.
  // `started_at` hanya dipakai untuk MENGHITUNG durasi, bukan untuk menyaring.
  const { sql } = buildHistoryQuery({});
  const syarat = sql.slice(sql.indexOf("WHERE"), sql.indexOf("ORDER BY"));
  assert.ok(
    !/started_at IS NOT NULL/.test(syarat),
    "started_at tidak boleh menjadi syarat masuk riwayat",
  );
  assert.match(syarat, /updated_at > now\(\)/, "acuan batas hari adalah updated_at");
});

test("durasi kosong berarti tidak tercatat, bukan nol detik", () => {
  // CASE WHEN started_at IS NULL THEN NULL: kalau diisi 0, layar berbohong
  // seolah task selesai dalam 0 detik.
  const { sql } = buildHistoryQuery({});
  assert.match(sql, /CASE WHEN started_at IS NULL THEN NULL/);
});

test("durasi dihitung database, bukan aplikasi", () => {
  const { sql } = buildHistoryQuery({});
  assert.match(sql, /EXTRACT\(EPOCH FROM \(updated_at - started_at\)\)/);
});

test("batas hari bisa diatur dan nilai aneh jatuh ke bawaan", () => {
  assert.equal(buildHistoryQuery({}).params[0], String(DEFAULT_HISTORY_DAYS));
  assert.equal(buildHistoryQuery({ historyDays: 3 }).params[0], "3");
  assert.equal(buildHistoryQuery({ historyDays: "abc" }).params[0], String(DEFAULT_HISTORY_DAYS));
  assert.equal(buildHistoryQuery({ historyDays: -1 }).params[0], String(DEFAULT_HISTORY_DAYS));
});

test("jumlah dibatasi supaya satu layar tidak dibanjiri", () => {
  assert.equal(buildHistoryQuery({ limit: 5 }).params[1], 5);
  assert.equal(buildHistoryQuery({ limit: 999 }).params[1], 200, "maksimum 200");
  assert.equal(buildHistoryQuery({ limit: 0 }).params[1], 60, "nol jatuh ke bawaan");
});

test("format durasi terbaca manusia", () => {
  assert.equal(formatDuration(45), "45d");
  assert.equal(formatDuration(65), "1m 05d");
  assert.equal(formatDuration(3725), "1j 02m");
  assert.equal(formatDuration(0), "0d");
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(undefined), null);
  assert.equal(formatDuration("bukan angka"), null);
  assert.equal(formatDuration(-100), "0d");
});
