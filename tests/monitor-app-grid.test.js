import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");

/**
 * Permintaan pemilik (2 November 2026): "bisa ngga di buat 6/6 jadi ada
 * 2 card" dan "bisa di click untuk detailnya".
 *
 * Dua hal yang dijaga di sini:
 *   1. kartu benar-benar disusun dua kolom, dan tetap satu kolom di layar sempit
 *   2. setiap kartu bisa ditekan dan membuka detail
 */

test("kartu disusun dua kolom dengan lebar setengah", () => {
  assert.match(app, /flexDirection: "row", flexWrap: "wrap"/);
  assert.match(app, /sel: \{ width: "49%"/);
  // Layar sempit harus turun jadi satu kolom, bukan dua kolom yang sempit.
  assert.match(app, /MIN_WIDTH_FOR_TWO_COLUMNS/);
  assert.match(app, /const duaKolom = width >= MIN_WIDTH_FOR_TWO_COLUMNS/);
  assert.match(app, /gridSatu: \{ flexDirection: "column" \}/);
});

test("kartu bisa ditekan untuk membuka detail", () => {
  assert.match(app, /<Pressable/);
  assert.match(app, /onPress=\{onPress\}/);
  assert.match(app, /onPress=\{\(\) => setDipilih\(s\.session_key\)\}/);
  assert.match(app, /<DetailSesi/);
  assert.match(app, /<Modal visible transparent/);
});

test("detail memuat rencana dan DoD, bukan hanya ringkasan", () => {
  // Isi modal harus benar-benar memuat daftar rencana dan bagian DoD.
  const modal = app.slice(app.indexOf("function DetailSesi"));
  assert.match(modal, /rencana\.map\(/);
  assert.match(modal, /Definition of Done/);
  assert.match(modal, /Sesi/);
});

test("detail mengikuti data terbaru, bukan salinan beku", () => {
  // Kalau sesi diperbarui saat modal terbuka, isinya harus ikut segar.
  assert.match(app, /const sesiDipilih = useMemo\(/);
  assert.match(app, /sesi\.find\(\(s\) => s\.session_key === dipilih\)/);
});

test("setiap pemakaian ago() tetap memakai jam server", () => {
  const pakai = (app.match(/ago\([^)]*\)/g) || []).filter((p) => !p.startsWith("ago(iso"));
  assert.ok(pakai.length > 0);
  for (const p of pakai) {
    assert.ok(p.includes("jamServer"), `panggilan ${p} harus memakai jamServer`);
  }
});
