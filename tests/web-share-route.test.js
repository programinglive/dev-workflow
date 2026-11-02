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
