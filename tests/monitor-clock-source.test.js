import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Label umur ("4m lalu") tidak boleh bergantung pada jam perangkat.
 *
 * MASALAH NYATA (2 November 2026): aplikasi Android menampilkan "14d lalu" untuk
 * sesi yang baru 4 menit. Server sudah benar - hanya klien yang memakai
 * `Date.now()` milik perangkat, sementara emulator MuMu punya tanggal bergeser.
 * Pemiliknya melihat angka aneh tanpa cara mengetahui sebabnya.
 *
 * Perbaikannya: server mengirim `now`, klien memakainya. Tes ini mengunci
 * keduanya supaya tidak kembali ke jam perangkat.
 */

const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");
const app = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");

test("server mengirim waktu acuannya sendiri", () => {
  assert.match(dash, /const serverNow = new Date\(\)\.toISOString\(\)/);
  // `now` harus ikut di respons /api/sessions, bukan hanya health.
  assert.match(dash, /JSON\.stringify\(\{ now: serverNow, sessions:/);
});

test("halaman web memakai jam server untuk label", () => {
  assert.match(dash, /function ago\(iso, nowMs\)/, "ago() web harus menerima acuan waktu");
  assert.ok(
    !/const d = \(Date\.now\(\) - new Date\(iso\)/.test(dash),
    "web tidak boleh lagi memakai Date.now() telanjang",
  );
  assert.match(dash, /ago\(s\.updated_at, jNow\)|ago\(s\.updated_at, jamServer\)|ago\(s\.updated_at, nowMs\)/);
});

test("aplikasi Android memakai jam server, bukan jam perangkat", () => {
  assert.match(app, /function ago\(iso, nowMs\)/);
  assert.match(app, /const jamServer = data && data\.now/);
  // Setiap pemakaian ago() di App.js harus menyertakan jamServer.
  const panggilan = app.match(/ago\([^)]*\)/g) || [];
  const definisi = panggilan.filter((p) => p.startsWith("ago(iso, nowMs"));
  const pakai = panggilan.filter((p) => !p.startsWith("ago(iso"));
  assert.ok(pakai.length > 0, "harus ada pemakaian ago()");
  for (const p of pakai) {
    assert.ok(p.includes("jamServer"), `panggilan ${p} harus memakai jamServer`);
  }
  assert.equal(definisi.length, 1);
});

test("Kartu menerima jamServer dari induknya", () => {
  assert.match(app, /function Kartu\(\{ s, jamServer \}\)/);
  assert.match(app, /<Kartu key=\{s\.session_key\} s=\{s\} jamServer=\{jamServer\} \/>/);
});
