import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");

/**
 * Dashboard diuji dari SUMBERNYA, bukan dengan mengimpornya: mengimpor
 * `dashboard.cjs` langsung menyalakan server dan koneksi Postgres.
 *
 * Yang dijaga di sini adalah kabelnya - modul yang dipakai, guard yang jalan
 * lebih dulu, dan satu jebakan nyata: halaman dashboard adalah template
 * literal, jadi satu `${` di dalamnya akan diinterpolasi server.
 */

test("dashboard memakai modul share, bukan menyalin logikanya", () => {
  assert.match(src, /require\('\.\/share-route\.cjs'\)/);
  assert.match(src, /require\('\.\/share-links\.cjs'\)/);
});

test("tiga metode share terpasang di jalur /api/share", () => {
  assert.match(src, /url\.pathname === '\/api\/share'/);
  assert.match(src, /'POST'/);
  assert.match(src, /'DELETE'/);
  assert.match(src, /shareGuard\(/);
});

test("guard berjalan sebelum handler mana pun", () => {
  const idxGuard = src.indexOf("shareGuard(");
  const idxCreate = src.indexOf("handleCreateShare(");
  assert.ok(idxGuard > 0 && idxCreate > idxGuard, "guard harus dipanggil lebih dulu");
});

test("respons sesi membawa daftar tautan hidup", () => {
  assert.match(src, /shares/);
  assert.match(src, /listLiveShares\(/);
});

test("kegagalan tabel share tidak menjatuhkan dashboard", () => {
  // Query daftar share harus berada di try sendiri, sehingga dashboard tetap
  // menjawab /api/sessions walau share_links belum ada.
  const idx = src.indexOf("listLiveShares(");
  assert.ok(idx > 0, "listLiveShares harus dipanggil di dashboard");
  const sekitar = src.slice(Math.max(0, idx - 600), idx + 200);
  assert.match(sekitar, /catch/);
});

test("kode halaman dashboard tidak memakai template literal di dalam template literal", () => {
  // Halaman ini adalah template literal. Satu `${` di dalamnya akan
  // diinterpolasi server dan merusak skrip klien.
  const mulai = src.indexOf("const PAGE = `");
  const akhir = src.indexOf("</html>`", mulai);
  assert.ok(mulai > 0 && akhir > mulai, "PAGE harus tetap berupa satu template literal");
  const halaman = src.slice(mulai, akhir);
  const terlarang = halaman.match(/\$\{(?!POLL_MS\})/g) || [];
  assert.deepEqual(terlarang, [], "hanya ${POLL_MS} yang boleh diinterpolasi");
});

test("skrip halaman dashboard benar-benar bisa di-parse", () => {
  // Tes sebelumnya menjaga interpolasi; tes ini menjaga SISANYA. Skrip yang
  // rusak tidak terlihat dari Node - server tetap 200 dan halaman kosong -
  // jadi satu-satunya cara mengetahuinya adalah mem-parse hasil akhirnya.
  const mulai = src.indexOf("const PAGE = `");
  const akhir = src.indexOf("</html>`", mulai);
  const halaman = src.slice(mulai + "const PAGE = `".length, akhir).replace(/\$\{POLL_MS\}/g, "3000");
  const skrip = halaman.slice(halaman.indexOf("<script>") + 8, halaman.lastIndexOf("</script>"));
  assert.ok(skrip.length > 500, "skrip halaman tidak boleh kosong");
  assert.doesNotThrow(() => new Function(skrip), "skrip halaman harus valid JavaScript");
});

test("tombol share memakai delegasi, bukan listener per kartu", () => {
  // Kartu digambar ulang tiap 3 detik. Listener yang dipasang saat render
  // hilang bersama elemennya, dan tombolnya berhenti bekerja tanpa pesan.
  assert.match(src, /getElementById\('list'\)\.addEventListener\('click'/);
  assert.match(src, /data-share/);
  assert.match(src, /data-copy/);
  assert.match(src, /data-revoke/);
});

test("tombol share tidak bergantung pada navigator.share saja", () => {
  // Dashboard dibuka lewat http://100.107.65.21:3100 - bukan secure context -
  // jadi navigator.share TIDAK ADA dan clipboard.writeText DITOLAK.
  assert.match(src, /execCommand\('copy'\)/);
  assert.match(src, /'manual'/);
  assert.match(src, /kotakSalinManual/);
});

test("panel tautan memakai endpoint sendiri, bukan hanya data kartu", () => {
  // Kartu sesi hilang setelah 30 menit idle, sedangkan tautan hidup sampai
  // dicabut. Tanpa endpoint ?all=1, tautan itu tidak punya jalan dicabut.
  assert.match(src, /api\/share\?all=1/);
  assert.match(src, /id="tautan"/);
  assert.match(src, /muatTautan/);
  assert.match(src, /handleListAllShares/);
});

test("panel menandai tautan yang sesinya sudah hilang", () => {
  assert.match(src, /sessionGone/);
  assert.match(src, /sesinya sudah tidak tampil/);
});
