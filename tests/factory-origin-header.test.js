import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const klien = readFileSync(path.join(ROOT, "factory-client.js"), "utf8");

/**
 * MASALAH NYATA (2 November 2026): board Factory berhenti menerima task sejak
 * 31 Oktober. Penyebabnya BUKAN password, melainkan header `Origin` yang tidak
 * pernah dikirim - server menjawab 403 "Asal permintaan tidak diizinkan", dan
 * galat itu mudah disalahartikan sebagai kredensial salah.
 *
 * Diukur saat itu: login langsung hanya berhasil (200) setelah Origin
 * ditambahkan.
 */

test("login PocketBase mengirim Origin", () => {
  const login = klien.slice(
    klien.indexOf("auth-with-password"),
    klien.indexOf("auth-with-password") + 500,
  );
  assert.match(login, /Origin: config\.url/);
});

test("setiap permintaan API mengirim Origin", () => {
  const req = klien.slice(klien.indexOf("async function request("), klien.indexOf("async function request(") + 900);
  assert.match(req, /Origin: config\.url/);
  // Tidak boleh hanya Authorization.
  assert.match(req, /Authorization: `Bearer \$\{token\}`/);
});

test("alasan Origin dicatat supaya tidak dihapus orang lain", () => {
  assert.match(klien, /Asal permintaan tidak diizinkan/);
});
