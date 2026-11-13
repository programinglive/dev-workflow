import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { clientKey, isValidIp } = require("../monitor-server/client-key.cjs");

/**
 * BUG NYATA (3 November 2026, terukur di produksi)
 * ================================================
 * 130 permintaan berurutan ke tautan share → 119 dilayani, 11 dijawab 429.
 *
 * Penyebabnya `req.socket.remoteAddress`. Di balik Cloudflare Tunnel, koneksi
 * ke share-server SELALU datang dari 127.0.0.1 - itu cloudflared, bukan
 * pembaca. Jadi pembatas laju menganggap SEMUA pembaca sebagai satu orang,
 * dan siapa pun yang membuka tautan 120 kali dalam semenit memblokir semua
 * orang lain - termasuk pemiliknya sendiri.
 *
 * Ibarat gedung yang punya satu tiket masuk untuk seluruh dunia: orang
 * pertama yang datang dua kali menutup pintu bagi semua orang.
 */

test("di balik proxy loopback, kunci diambil dari CF-Connecting-IP", () => {
  assert.equal(
    clientKey({ remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": "203.0.113.7" } }),
    "203.0.113.7",
  );
  assert.equal(
    clientKey({ remoteAddress: "::1", headers: { "cf-connecting-ip": "203.0.113.9" } }),
    "203.0.113.9",
  );
});

test("dua puluh pembaca berbeda TIDAK berbagi kunci", () => {
  const kunci = new Set();
  for (let i = 1; i <= 20; i += 1) {
    kunci.add(clientKey({ remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": "10.0.0." + i } }));
  }
  assert.equal(kunci.size, 20, "kalau kurang, satu pembaca memblokir yang lain");
});

test("header dari koneksi NON-loopback diabaikan: tidak bisa dipalsukan", () => {
  // Kalau header dipercaya dari mana saja, siapa pun yang bisa menjangkau
  // port 3200 langsung dapat kuota tak terbatas hanya dengan mengganti header.
  assert.equal(
    clientKey({ remoteAddress: "198.51.100.5", headers: { "cf-connecting-ip": "1.2.3.4" } }),
    "198.51.100.5",
  );
});

test("tanpa header, jatuh ke alamat soket", () => {
  assert.equal(clientKey({ remoteAddress: "127.0.0.1", headers: {} }), "127.0.0.1");
  assert.equal(clientKey({ remoteAddress: "198.51.100.5", headers: {} }), "198.51.100.5");
  assert.equal(clientKey({}), "unknown");
});

test("nilai header yang bukan IP ditolak, supaya peta tidak ditumbuhi sampah", () => {
  assert.equal(isValidIp("203.0.113.7"), true);
  assert.equal(isValidIp("2001:db8::1"), true);
  assert.equal(isValidIp("bukan-ip"), false);
  assert.equal(isValidIp("999.999.999.999"), false);
  assert.equal(isValidIp(""), false);
  assert.equal(isValidIp(null), false);

  // Header berisi sampah tidak boleh menjadi kunci.
  assert.equal(
    clientKey({ remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": "x".repeat(500) } }),
    "127.0.0.1",
  );
  assert.equal(
    clientKey({ remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": "bukan-ip" } }),
    "127.0.0.1",
  );
});

test("header berbentuk daftar mengambil elemen pertama yang sah", () => {
  // Cloudflare kadang mengirim daftar; ambil yang pertama, bukan menolak semua.
  assert.equal(
    clientKey({ remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": "203.0.113.7, 127.0.0.1" } }),
    "203.0.113.7",
  );
});
