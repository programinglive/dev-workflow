import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buatPembatas, createShareServer } = require("../monitor-server/share-server.cjs");

/**
 * BUG NYATA (3 November 2026, terukur di server)
 * ==============================================
 * 200 permintaan berurutan dari SATU IP → SEMUA 200 dijawab 429, termasuk
 * yang pertama. Jendela pembatas menyimpan sisa hitungan dari percobaan
 * sebelumnya, dan pembaca yang belum pernah membuka apa pun ikut tertolak.
 *
 * Bagi pembaca, 429 berulang berarti "tautannya rusak". Ia tidak akan tahu
 * bahwa ia hanya perlu menunggu semenit, dan tidak akan kembali.
 *
 * DUA HAL YANG DIPERBAIKI DI SINI
 * -------------------------------
 * 1. Ambangnya naik: 120 permintaan/menit terlalu rendah untuk satu tautan
 *    yang dibagikan ke grup. Satu orang yang menyegarkan halaman cepat sudah
 *    bisa memakannya, dan preview WhatsApp menambahnya.
 * 2. 429 menyebut kapan boleh mencoba lagi, dan halaman itu MEMBERI TAHU
 *    pembaca, bukan hanya membalas teks polos.
 */

const TOKEN = "T".repeat(43);

test("ambang bawaan cukup untuk satu tautan yang dibagikan ke grup", () => {
  const b = buatPembatas();
  let ditolak = 0;
  for (let i = 0; i < 300; i += 1) {
    if (!b("198.51.100.1")) ditolak += 1;
  }
  assert.ok(ditolak <= 180, "300 permintaan berturut-turut tidak boleh langsung menolak semuanya");
});

test("pembaca BARU tidak terpengaruh hitungan pembaca lain", () => {
  const b = buatPembatas();
  for (let i = 0; i < 300; i += 1) b("198.51.100.1");
  assert.equal(b("203.0.113.9"), true, "pembaca baru harus selalu boleh membuka pertama kali");
});

test("jendela benar-benar direset sesudah 60 detik", () => {
  let jam = 1_000_000;
  const b = buatPembatas({ perMenit: 2, sekarang: () => jam });
  assert.equal(b("1.1.1.1"), true);
  assert.equal(b("1.1.1.1"), true);
  assert.equal(b("1.1.1.1"), false, "batas tercapai");
  jam += 61_000;
  assert.equal(b("1.1.1.1"), true, "sesudah jendela lewat, boleh lagi");
});

test("429 memuat Retry-After dan halaman yang menjelaskan", async () => {
  const query = async (sql) => {
    const teks = String(sql);
    if (/FROM share_links l/.test(teks)) {
      return { rows: [{ token: TOKEN, revoked_at: null, live_session_key: "s", task: "x", views: 0, updated_at: new Date().toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const s = createShareServer({ query, rateLimitPerMinute: 1 });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const base = "http://127.0.0.1:" + s.address().port;
    const h = { headers: { "cf-connecting-ip": "198.51.100.77" } };
    assert.equal((await fetch(base + "/s/" + TOKEN, h)).status, 200);
    const r = await fetch(base + "/s/" + TOKEN, h);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "60");
    const html = await r.text();
    // Pembaca harus tahu ini sementara, bukan tautan yang rusak.
    assert.match(html, /60 detik|sebentar lagi|terlalu sering/i);
  } finally {
    await new Promise((r) => s.close(r));
  }
});
