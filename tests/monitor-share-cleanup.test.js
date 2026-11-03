import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildOrphanSharesQuery, buildRevokeOrphans } = require("../monitor-server/share-links.cjs");
const { revokeOrphanShares } = require("../monitor-server/share-route.cjs");

/**
 * KEPUTUSAN: TIDAK ADA KEDALUWARSA OTOMATIS
 * =========================================
 * Pemilik meminta tautan permanen sampai dicabut. Jadi pertumbuhan data
 * diselesaikan dengan MEMBERESKAN, bukan dengan membunuh tautan diam-diam.
 *
 * BAHAN BAKARNYA BUKAN UMUR, MELAINKAN KEHILANGAN SESI
 * ----------------------------------------------------
 * Umur adalah proksi yang salah. Sesi `idle` hilang dari layar setelah 30
 * menit, tetapi task yang baru selesai kemarin masih berguna untuk dibagikan
 * lagi besok. Yang benar-benar tidak berguna adalah tautan yang baris sesinya
 * SUDAH DIHAPUS - tidak ada lagi yang bisa ditampilkan.
 *
 * Itu juga yang membuat aksi ini aman dijalankan tanpa bertanya: ia tidak
 * pernah mematikan tautan yang masih punya cerita untuk ditampilkan.
 */

test("yatim = baris sesinya hilang, bukan sekadar lama", () => {
  const { sql } = buildOrphanSharesQuery();
  assert.match(sql, /LEFT JOIN sessions/);
  assert.match(sql, /l\.revoked_at IS NULL/);
  // Syaratnya HARUS "sesi tidak ada", bukan "updated_at tua".
  assert.match(sql, /s\.session_key IS NULL/);
  assert.ok(
    !/updated_at\s*</.test(sql),
    "umur tidak boleh jadi syarat: sesi idle masih punya cerita untuk ditampilkan",
  );
});

test("pencabutan massal hanya menyetel revoked_at, tidak menghapus", () => {
  const { sql } = buildRevokeOrphans();
  assert.match(sql, /UPDATE share_links/);
  assert.match(sql, /revoked_at = now\(\)/);
  assert.ok(!/DELETE/i.test(sql), "baris tidak boleh dihapus: kunjungan tetap tersimpan");
  // Subquery-nya harus sama ketatnya dengan daftar yang ditampilkan.
  assert.match(sql, /NOT EXISTS|NOT IN/i);
});

test("handler melaporkan berapa yang dicabut", async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push(String(sql));
    return { rows: [{ count: 3 }], rowCount: 3 };
  };
  const hasil = await revokeOrphanShares({ query });
  assert.equal(hasil.status, 200);
  assert.equal(hasil.body.ok, true);
  assert.equal(hasil.body.revoked, 3);
  assert.equal(calls.length, 1);
});

test("tabel yang belum ada tidak menjatuhkan panel", async () => {
  const query = async () => {
    throw Object.assign(new Error('relation "share_links" does not exist'), { code: "42P01" });
  };
  const hasil = await revokeOrphanShares({ query });
  assert.equal(hasil.status, 503);
  assert.equal(hasil.body.ok, false);
});
