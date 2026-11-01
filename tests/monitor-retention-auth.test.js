import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildPruneEventsQuery,
  buildPruneSessionsQuery,
  isWriteAuthorized,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SESSION_RETENTION_DAYS,
} = require("../monitor-server/retention.cjs");

/**
 * Dua celah yang ditutup di sini, keduanya ditemukan lewat audit 1 November
 * 2026 pada server yang sudah berjalan:
 *
 *   1. tidak ada satu pun DELETE, jadi `events` tumbuh selamanya;
 *   2. tidak ada pemeriksaan `authorization`, jadi perangkat mana pun di
 *      tailnet bisa menyuntik sesi palsu ke layar tablet.
 */

test("pembersihan event memakai parameter, bukan angka yang ditempel", () => {
  const { sql, params } = buildPruneEventsQuery({ retentionDays: 14 });
  assert.match(sql, /DELETE FROM events/);
  assert.match(sql, /\$1/);
  assert.equal(params[0], "14");
  assert.ok(!sql.includes("14"), "angka retensi tidak boleh masuk teks SQL");
});

test("pembersihan sesi hanya menyentuh idle", () => {
  const { sql } = buildPruneSessionsQuery({ sessionRetentionDays: 3 });
  assert.match(sql, /phase = 'idle'/);
  // Sesi yang masih bekerja tidak boleh dihapus: baris itulah yang tampil.
  assert.ok(!/phase = 'coding'/.test(sql));
});

test("nilai retensi kosong jatuh ke bawaan", () => {
  assert.equal(buildPruneEventsQuery({}).params[0], String(DEFAULT_RETENTION_DAYS));
  assert.equal(buildPruneEventsQuery({ retentionDays: "" }).params[0], String(DEFAULT_RETENTION_DAYS));
  assert.equal(
    buildPruneSessionsQuery({}).params[0],
    String(DEFAULT_SESSION_RETENTION_DAYS),
  );
});

test("token benar diterima, token salah ditolak", () => {
  const expectedToken = "rahasia-panjang-123";
  assert.equal(isWriteAuthorized({ header: `Bearer ${expectedToken}`, expectedToken }), true);
  // Huruf besar/kecil pada skema tidak penting.
  assert.equal(isWriteAuthorized({ header: `bearer ${expectedToken}`, expectedToken }), true);
  assert.equal(isWriteAuthorized({ header: "Bearer salah", expectedToken }), false);
  assert.equal(isWriteAuthorized({ header: "", expectedToken }), false);
  assert.equal(isWriteAuthorized({ header: undefined, expectedToken }), false);
  // Token yang hanya berbeda di ujung harus ditolak.
  assert.equal(
    isWriteAuthorized({ header: `Bearer ${expectedToken}x`, expectedToken }),
    false,
  );
});

test("server tanpa token menolak semua penulisan, bukan menerima", () => {
  // Pilihan sadar: monitor yang lupa dikonfigurasi lebih baik berhenti
  // menerima laporan daripada diam-diam menerima dari siapa saja.
  assert.equal(isWriteAuthorized({ header: "Bearer apa-saja", expectedToken: "" }), false);
  assert.equal(isWriteAuthorized({ header: "Bearer ", expectedToken: "" }), false);
  assert.equal(isWriteAuthorized({ header: undefined, expectedToken: undefined }), false);
});

test("token kosong di header tidak lolos walau server punya token", () => {
  assert.equal(isWriteAuthorized({ header: "Bearer ", expectedToken: "abc" }), false);
  assert.equal(isWriteAuthorized({ header: "Bearer    ", expectedToken: "abc" }), false);
});
