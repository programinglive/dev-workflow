import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildLiveSharesQuery } = require("../monitor-server/share-links.cjs");

/**
 * CELAH YANG DITUTUP (3 November 2026)
 * ====================================
 * Tautan hidup sampai dicabut, tetapi tombol Cabut hanya ada di kartu sesi.
 * Sesi `idle` hilang dari layar setelah 30 menit, jadi tautan yang sudah
 * tersebar ke WhatsApp bisa tetap hidup TANPA jalan mencabutnya.
 *
 * Daftar tautan harus tetap memuat tautan yang sesinya sudah tidak ada -
 * itu justru kasus yang paling perlu diselamatkan - jadi JOIN-nya LEFT.
 */

test("daftar tautan membawa nama sesi untuk ditampilkan", () => {
  const { sql } = buildLiveSharesQuery();
  assert.match(sql, /LEFT JOIN sessions/);
  assert.match(sql, /task/);
  assert.match(sql, /session_title/);
});

test("tautan yang sesinya sudah hilang TETAP masuk daftar", () => {
  const { sql } = buildLiveSharesQuery();
  // INNER JOIN akan membuang baris itu - dan baris itulah yang perlu dicabut.
  assert.ok(!/JOIN sessions[^;]*WHERE[^;]*s\.session_key IS NOT NULL/i.test(sql));
  assert.match(sql, /WHERE l\.revoked_at IS NULL/);
});

test("daftar tetap dibatasi dan hanya yang hidup", () => {
  const { sql, params } = buildLiveSharesQuery();
  assert.match(sql, /LIMIT \$1/);
  assert.match(sql, /revoked_at IS NULL/);
  assert.deepEqual(params, [200]);
});
