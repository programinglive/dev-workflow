import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { labelSesi, listLiveShares, handleListAllShares } = require("../monitor-server/share-route.cjs");

const TOKEN = "T".repeat(43);

function fakeQuery(rows) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows, rowCount: rows.length };
  };
  query.calls = calls;
  return query;
}

/**
 * Panel "Tautan berbagi" ada supaya tautan yang sesinya sudah hilang tetap
 * bisa dicabut. Nama yang ditampilkan harus bisa dibedakan satu sama lain:
 * lima baris "(tanpa nama)" tidak memberi tahu mana yang harus dicabut.
 */

test("nama sesi diambil dari task, lalu judul, lalu kunci", () => {
  assert.equal(labelSesi({ task: "Perbaiki login" }), "Perbaiki login");
  assert.equal(labelSesi({ task: "  ", session_title: "Judul sesi" }), "Judul sesi");
  assert.equal(labelSesi({ task: "", session_title: "", session_key: "ses_abcdefghijklmnopqrstuvwx" }), "ses_abcdefghijklmnopqrst");
  assert.equal(labelSesi({}), "(tanpa nama)");
  assert.equal(labelSesi(null), "(tanpa nama)");
});

test("dua tautan tanpa task tetap bisa dibedakan", () => {
  const a = labelSesi({ session_key: "ses_aaaaaaaaaaaaaaaaaaaaaaaa" });
  const b = labelSesi({ session_key: "ses_bbbbbbbbbbbbbbbbbbbbbbbb" });
  assert.notEqual(a, b, "kalau sama, pemilik tidak tahu mana yang dicabut");
});

test("tautan yang sesinya hilang ditandai, bukan disembunyikan", async () => {
  const rows = await listLiveShares({
    query: fakeQuery([
      { session_key: "ses_hidup", token: TOKEN, views: 2, live_session_key: "ses_hidup", task: "Kerjakan", phase: "coding" },
      { session_key: "ses_hilang", token: "U".repeat(43), views: 9, live_session_key: null, task: null, phase: null },
    ]),
  });
  assert.equal(rows.length, 2, "yang sesinya hilang tetap masuk daftar");
  assert.equal(rows[0].sessionGone, false);
  assert.equal(rows[1].sessionGone, true);
  assert.equal(rows[1].views, 9);
  // Tokennya harus tetap ada, karena itulah yang dipakai untuk mencabut.
  assert.equal(rows[1].token, "U".repeat(43));
});

test("panel mengembalikan 200 dengan daftar, dan tetap 200 saat tabel belum ada", async () => {
  const ok = await handleListAllShares({ query: fakeQuery([{ session_key: "s", token: TOKEN, views: 0, live_session_key: "s" }]) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.shares.length, 1);

  const gagal = await handleListAllShares({
    query: async () => { throw Object.assign(new Error('relation "share_links" does not exist'), { code: "42P01" }); },
  });
  assert.equal(gagal.status, 200, "dashboard tidak boleh rusak karena tabel belum ada");
  assert.deepEqual(gagal.body.shares, []);
});
