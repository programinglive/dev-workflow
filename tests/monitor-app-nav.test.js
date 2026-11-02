import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");

/**
 * Permintaan pemilik (2 November 2026): "buat bottom navigasi untuk masuk ke
 * history dan beri filter sesuai statusnya".
 *
 * Yang dijaga: tab benar-benar ada, filternya mencakup status yang memang
 * disimpan, dan "selesai" memakai phase idle - bukan status turunan, sebab
 * sesi yang baru berhenti melapor juga berstatus `ended` padahal tasknya belum
 * tentu ditutup.
 */

test("ada bottom navigation dengan empat tab", () => {
  assert.match(app, /tabBar:/);
  for (const tab of ["aktif", "riwayat", "mesin", "info"]) {
    assert.ok(app.includes(`id: "${tab}"`), `tab ${tab} harus ada`);
  }
});

test("tab riwayat punya filter status", () => {
  assert.match(app, /const FILTER = \[/);
  for (const f of ["semua", "selesai", "berjalan", "macet", "berakhir"]) {
    assert.ok(app.includes(`id: "${f}"`), `filter ${f} harus ada`);
  }
});

test("selesai memakai phase idle, bukan status turunan", () => {
  // `ended` juga berarti "berhenti melapor", bukan "task ditutup". Menyamakan
  // keduanya akan salah.
  assert.match(app, /filter === "selesai"\) return h\.phase === "idle"/);
});

test("filter menghitung jumlah supaya tombol kosong tidak jadi hiasan", () => {
  assert.match(app, /hitung: \(h\) => h\.filter\(/);
});

test("baris riwayat bisa diketuk untuk membuka detail", () => {
  assert.match(app, /onPress=\{\(\) => setDipilih\(h\.session_key\)\}/);
  // Detail harus mencari di sesi AKTIF maupun riwayat.
  assert.match(app, /const semua = useMemo\(\(\) => \[\.\.\.sesi, \.\.\.riwayat\]/);
});

test("tab menggantikan bagian yang dipilih, bukan menumpuk", () => {
  assert.match(app, /tab === "aktif" &&/);
  assert.match(app, /tab === "riwayat" &&/);
  assert.match(app, /tab === "mesin" &&/);
  assert.match(app, /tab === "info" &&/);
});
