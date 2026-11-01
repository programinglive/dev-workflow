import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");

/**
 * Permintaan pemilik (2 November 2026): "setiap task mesti ada counter timenya
 * biar tau berapa lama task itu selesai, dan ada nama project yang di kerjakan".
 */

test("kartu menampilkan timer durasi", () => {
  assert.match(app, /function durasi\(mulaiIso, nowMs\)/);
  assert.match(app, /durasi\(s\.started_at, jamServer\)/);
  // Timer harus memakai jam server juga, bukan jam perangkat.
  assert.match(app, /gaya\.timerTeks/);
});

test("durasi berbentuk jam:menit:detik dan tidak negatif", () => {
  // Ambil fungsinya langsung dari berkas lalu jalankan.
  const mulai = app.indexOf("function durasi(");
  const akhir = app.indexOf("export default function App()");
  assert.ok(mulai > 0 && akhir > mulai, "fungsi durasi harus ditemukan utuh");
  const sumber = app.slice(mulai, akhir);
  const fn = new Function(sumber + "; return durasi;")();
  const now = Date.parse("2026-11-02T10:00:00Z");

  assert.equal(fn(new Date(now - 5000).toISOString(), now), "0:05");
  assert.equal(fn(new Date(now - 65 * 1000).toISOString(), now), "1:05");
  assert.equal(fn(new Date(now - 3725 * 1000).toISOString(), now), "1:02:05");
  // Jam perangkat yang lebih maju tidak boleh menghasilkan durasi negatif.
  assert.equal(fn(new Date(now + 60_000).toISOString(), now), "0:00");
  assert.equal(fn(null, now), null);
  assert.equal(fn("bukan tanggal", now), null);
});

test("nama proyek ditampilkan menonjol di kartu", () => {
  assert.match(app, /gaya\.proyek/, "harus ada gaya khusus nama proyek");
  assert.match(app, /proyek: \{ color: WARNA\.biruMuda/, "gaya proyek harus didefinisikan");
  // Kartu memakai s.project_name, bukan hanya menyelipkannya di baris meta.
  const kartu = app.slice(app.indexOf("function Kartu("), app.indexOf("function DetailSesi("));
  assert.match(kartu, /s\.project_name/);
});

test("detail juga menampilkan timer dan proyek", () => {
  const modal = app.slice(app.indexOf("function DetailSesi("));
  assert.match(modal, /durasi\(s\.started_at, jamServer\)/);
  assert.match(modal, /s\.project_name/);
});
