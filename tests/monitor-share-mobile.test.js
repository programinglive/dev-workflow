import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");

/**
 * Tombol Bagikan di aplikasi tablet.
 *
 * Dua hal yang dijaga di sini adalah dua kesalahan yang sudah pernah terjadi
 * atau hampir terjadi di repo ini:
 *
 *   1. React Native TIDAK mengirim header `Origin`. Bila guard server
 *      mewajibkannya, tombol ini selalu 403 di tablet sementara dashboard
 *      browser tampak normal.
 *   2. Hook React harus dipanggil sebelum `return null`. Kalau tidak, jumlah
 *      hook berubah antara render dengan dan tanpa sesi, dan React melempar
 *      "Rendered fewer hooks than expected" - seluruh layar tablet mati.
 */

test("aplikasi mengimpor Share dari react-native, bukan dependensi baru", () => {
  assert.match(app, /^\s*Share,/m);
  assert.match(app, /from "react-native"/);
  // Menambah expo-clipboard berarti membangun ulang APK untuk satu tombol.
  assert.ok(!/expo-clipboard/.test(app), "jangan menambah dependensi native baru");
});

test("permintaan share mengirim header penanda, tanpa mengandalkan Origin", () => {
  assert.match(app, /"x-devwf-share": "1"/);
  assert.match(app, /MONITOR_URL \+ "\/api\/share"/);
  assert.match(app, /method: "POST"/);
});

test("sheet bagikan dipanggil dengan tautan yang benar", () => {
  assert.match(app, /Share\.share\(/);
  assert.match(app, /url: body\.url/);
  // Pesan harus memuat tautannya: sebagian aplikasi hanya membaca message.
  assert.match(app, /message: body\.url/);
});

test("hook dipanggil sebelum return null", () => {
  const awal = app.indexOf("function DetailSesi(");
  const isi = app.slice(awal, awal + 1600);
  const idxHook = isi.indexOf("useState(false)");
  const idxReturnNull = isi.indexOf("if (!s) return null;");
  assert.ok(idxHook > 0, "state Bagikan harus ada di DetailSesi");
  assert.ok(idxReturnNull > 0, "DetailSesi tetap menangani sesi kosong");
  assert.ok(
    idxHook < idxReturnNull,
    "useState harus dipanggil SEBELUM 'if (!s) return null' atau jumlah hook berubah antar render",
  );
});

test("kegagalan ditampilkan, bukan ditelan", () => {
  assert.match(app, /setGalatBagikan\(/);
  assert.match(app, /galatBagikan/);
});

test("tautan ditampilkan agar bisa disalin manual", () => {
  assert.match(app, /selectable/);
  assert.match(app, /tautanTeks/);
});
