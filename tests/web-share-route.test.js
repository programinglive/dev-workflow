import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function config() {
  const raw = await readFile(path.join(ROOT, "web", "netlify.toml"), "utf8");
  return raw.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n");
}

/**
 * Tautan share dilayani proses lain, tetapi yang DIBAGIKAN pemilik adalah
 * domain utama. Karena itu Netlify harus mem-proxy `/s/*` ke tunnel.
 *
 * Dua jebakan yang dijaga di sini:
 *
 *   1. Urutan. Netlify memakai aturan pertama yang cocok, jadi catch-all
 *      `/*` -> 404 harus tetap di BAWAH. Kalau terbalik, SETIAP tautan share
 *      menjawab 404 dan gejalanya tampak seperti "server share mati".
 *   2. `force = true`. Tanpa itu, berkas statis menang atas rewrite.
 */

test("tautan /s/* diteruskan ke server share", async () => {
  const c = await config();
  assert.match(c, /from\s*=\s*"\/s\/\*"/);
  assert.match(c, /to\s*=\s*"https:\/\/devwfshare\.programinglive\.com\/s\/:splat"/);
  assert.match(c, /status\s*=\s*200/);
  assert.match(c, /force\s*=\s*true/);
});

test("rewrite share berada SEBELUM catch-all 404", async () => {
  const c = await config();
  const iShare = c.indexOf("/s/*");
  const iCatch = c.indexOf("/*");
  assert.ok(iShare > 0, "rewrite /s/* harus ada");
  assert.ok(iCatch > iShare, "catch-all harus di bawah, atau semua tautan share jadi 404");
  assert.match(c.slice(iCatch), /to\s*=\s*"\/404\.html"/);
});

test("halaman penjelasan ada di /share, bukan /s", async () => {
  const page = await readFile(path.join(ROOT, "web", "app", "share", "page.tsx"), "utf8");
  assert.ok(page.length > 200);
  // Halaman statis tidak boleh mengklaim data sesi apa pun.
  assert.ok(!/session_key|\bmachine\b|project_path/.test(page));
});

test("halaman penjelasan tidak menjanjikan sesuatu yang bisa basi", async () => {
  const page = await readFile(path.join(ROOT, "web", "app", "share", "page.tsx"), "utf8");
  // Halaman statis tidak bisa tahu kondisi server. Kalimat seperti "server
  // sedang aktif" akan berbohong begitu prosesnya mati - persis kegagalan
  // halaman /login lama.
  assert.ok(!/sedang aktif|is running|online now/i.test(page));
});

test("halaman penjelasan menyebut apa yang TIDAK dibagikan", async () => {
  const page = await readFile(path.join(ROOT, "web", "app", "share", "page.tsx"), "utf8");
  assert.match(page, /tidak/i);
  assert.match(page, /mesin|machine/i);
  assert.match(page, /path/i);
});

test("web eslint mengabaikan artefak build Netlify", async () => {
  // Tanpa ini `npm run lint --prefix web` merah lokal di 12 error
  // no-this-alias dari bundel minified, sementara CI hijau karena checkout
  // bersih. Lint yang merah karena artefak build akan diabaikan orang.
  const cfg = await readFile(path.join(ROOT, "web", "eslint.config.mjs"), "utf8");
  assert.match(cfg, /"\.netlify\/\*\*"/);
  assert.match(cfg, /"\.next\/\*\*"/, "ignore bawaan tidak boleh hilang");
  assert.match(cfg, /"out\/\*\*"/);
});

test("contoh env menyebut bahwa origin allowlist butuh restart", async () => {
  // Nilai ini dibaca sekali saat proses start. Tanpa catatan ini, operator
  // mengubah env, melihat origin baru tetap 403, dan tidak tahu sebabnya.
  const env = await readFile(path.join(ROOT, "monitor-server", "devwf-monitor.env.example"), "utf8");
  assert.match(env, /DEVWF_SHARE_ORIGINS/);
  assert.match(env, /RESTART|restart/);
});

test("skrip pembersihan hanya menyentuh token yang dicatat eksplisit", async () => {
  // Prinsipnya: pembersihan otomatis TIDAK BOLEH mencabut tautan yang tidak
  // dikenali skrip. Kalau skrip ini suatu saat "mencabut semua yang yatim",
  // tautan pemilik yang sesinya kebetulan sudah dibersihkan ikut mati.
  const skrip = await readFile(path.join(ROOT, "scripts", "cleanup-probe-shares.sh"), "utf8");
  assert.match(skrip, /TOKENS=\(/);
  assert.match(skrip, /revoked_at=now\(\)/);
  assert.ok(!/DELETE FROM share_links/.test(skrip), "baris tidak boleh dihapus");
  assert.ok(!/revoke-orphans/.test(skrip), "jangan menyapu semua yatim dari skrip bersih-bersih");
});

test("skrip verifikasi akhir mencakup guard, jalur tulis publik, dan sisa data uji", async () => {  const skrip = await readFile(path.join(ROOT, "scripts", "verify-share-final.sh"), "utf8");
  // Skrip ini satu-satunya bukti yang bisa dijalankan ulang terhadap server
  // sungguhan; kalau pemeriksaannya dihapus, "sudah diverifikasi" jadi klaim
  // kosong.
  assert.match(skrip, /systemctl is-active/);
  assert.match(skrip, /revoke-orphans|api\/share/);
  assert.match(skrip, /405/);
  assert.match(skrip, /ses_uji/);
  assert.match(skrip, /SEMUA LULUS/);
});
