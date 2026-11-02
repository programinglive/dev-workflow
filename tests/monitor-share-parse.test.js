import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "monitor-server", "dashboard.cjs");

/**
 * BUG NYATA (2 November 2026, tertangkap saat deploy)
 * ===================================================
 * Halaman dashboard adalah satu template literal `PAGE`. Saya menulis
 * komentar JSDoc yang memuat backtick untuk menandai nama API:
 *
 *     `navigator.share` tidak ada sama sekali
 *
 * Backtick pertama menutup template literal itu. Berkasnya tetap lolos tes
 * saya saat itu karena tes memeriksa potongan `<script>` saja, dan Node baru
 * menolaknya ketika service dijalankan di server:
 *
 *     SyntaxError: Unexpected identifier 'navigator'
 *
 * Artinya dashboard MATI TOTAL di produksi sementara seluruh suite hijau.
 * Karena itu pemeriksaan di sini bukan pencocokan pola, melainkan benar-benar
 * meminta Node mem-parse berkasnya - satu-satunya pemeriksaan yang tidak bisa
 * dibodohi oleh kesalahan tanda baca.
 */

test("dashboard.cjs benar-benar bisa di-parse Node", () => {
  assert.doesNotThrow(
    () => execFileSync(process.execPath, ["--check", FILE], { stdio: "pipe" }),
    "berkas ini adalah titik masuk service: kalau Node menolaknya, dashboard mati di produksi",
  );
});

test("setiap modul monitor-server bisa di-parse Node", () => {
  const berkas = [
    "share-links.cjs",
    "share-page.cjs",
    "share-route.cjs",
    "share-server.cjs",
    "sessions-query.cjs",
    "history-query.cjs",
    "session-upsert.cjs",
    "status.cjs",
  ];
  for (const nama of berkas) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ["--check", path.join(ROOT, "monitor-server", nama)], { stdio: "pipe" }),
      nama + " tidak bisa di-parse",
    );
  }
});

test("dashboard.cjs tidak memuat backtick di dalam template literal halaman", () => {
  // Pemeriksaan kedua, lebih sempit tetapi dengan pesan yang menunjuk sebabnya:
  // `node --check` di atas memberi tahu ADA yang salah, tes ini memberi tahu
  // APA. Tanpa yang pertama, tes ini bisa lolos sambil berkasnya tetap rusak
  // karena sebab lain.
  const src = readFileSync(FILE, "utf8");  const mulai = src.indexOf("const PAGE = `");
  assert.ok(mulai > 0, "PAGE harus tetap ada");
  const awalIsi = mulai + "const PAGE = `".length;
  const akhir = src.indexOf("</html>`", awalIsi);
  assert.ok(akhir > awalIsi, "template literal halaman harus ditutup oleh </html> + backtick");
  const halaman = src.slice(awalIsi, akhir);
  const backtick = halaman.indexOf("`");
  assert.equal(
    backtick,
    -1,
    "backtick di dalam halaman akan menutup template lebih awal; pakai tanda kutip biasa di komentar. " +
      "Konteks: " + (backtick >= 0 ? JSON.stringify(halaman.slice(Math.max(0, backtick - 60), backtick + 20)) : ""),
  );
});
