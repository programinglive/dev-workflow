import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createShareServer } = require("../monitor-server/share-server.cjs");

/**
 * TEMUAN REVIEW yang ditunda, lalu dibuktikan nyata (3 November 2026)
 * ===================================================================
 * Peta pembatas laju hanya dibersihkan ketika kunci BARU masuk DAN ukurannya
 * sudah lebih dari 1000. Pembersihan itu hanya membuang entri yang jendelanya
 * sudah lewat.
 *
 * Penyerang yang memutar IP (atau crawler dengan IP banyak) membuat SEMUA
 * entri masih segar, sehingga tidak satu pun dibuang: peta tumbuh mengikuti
 * jumlah permintaan, tanpa batas. Pada proses yang hidup berhari-hari itu
 * kebocoran memori, dan kebocoran memori adalah cara termudah menjatuhkan
 * server yang menghadap internet.
 */

/** Membaca jumlah kunci di peta tanpa mengeksposnya ke produksi. */
function buatPembatasUntukUji() {
  const mod = require("../monitor-server/share-server.cjs");
  assert.equal(typeof mod.buatPembatas, "function", "pembatas harus bisa diuji langsung");
  return mod.buatPembatas({ perMenit: 10 });
}

test("pembatas mengekspos jumlah kunci untuk diuji", () => {
  const b = buatPembatasUntukUji();
  assert.equal(typeof b.ukuran, "function");
  assert.equal(b.ukuran(), 0);
});

test("peta TIDAK tumbuh tanpa batas saat IP diputar terus-menerus", () => {
  const b = buatPembatasUntukUji();
  // 20.000 IP berbeda dalam satu jendela waktu: semuanya segar, jadi
  // pembersihan berbasis kedaluwarsa tidak membuang apa pun.
  for (let i = 0; i < 20000; i += 1) {
    b("10." + Math.floor(i / 65536) + "." + (Math.floor(i / 256) % 256) + "." + (i % 256));
  }
  const n = b.ukuran();
  assert.ok(n <= 10000, "peta harus punya batas keras, sekarang " + n);
  assert.ok(n > 0, "batas bukan berarti kosong");
});

test("membatasi peta tidak membuat pembaca sah terblokir", () => {
  const b = buatPembatasUntukUji();
  for (let i = 0; i < 20000; i += 1) b("10.0." + Math.floor(i / 256) + "." + (i % 256));
  // Setelah peta dibersihkan paksa, pembaca baru tetap dilayani.
  assert.equal(b("203.0.113.55"), true);
});

test("satu pembaca tetap dibatasi walau peta pernah penuh", () => {
  const b = buatPembatasUntukUji();
  for (let i = 0; i < 20000; i += 1) b("10.1." + Math.floor(i / 256) + "." + (i % 256));
  for (let i = 0; i < 10; i += 1) b("198.51.100.77");
  assert.equal(b("198.51.100.77"), false, "batas per pembaca harus tetap berlaku");
});
