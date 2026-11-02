import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildMachinesQuery, DEFAULT_STALE_AFTER_DAYS } = require(
  "../monitor-server/machines-query.cjs",
);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");
const app = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");

/**
 * MASALAH NYATA (2 November 2026): Mac dan MMCH tampil "offline" padahal
 * komputernya nyala. Ambangnya 30 menit, sementara mesin hanya melapor saat
 * ada tool dev-workflow dipanggil - jadi mesin yang nyala tetapi tidak sedang
 * dipakai dicap mati.
 *
 * Itu kebohongan dengan bentuk yang sama seperti yang sudah diperbaiki di
 * dashboard ("mati" tampak sama dengan "tidak ada pekerjaan"). Kali ini saya
 * mengulanginya sendiri, jadi tes ini mengunci artinya.
 */

test("ambangnya hari, bukan menit", () => {
  const { sql, params } = buildMachinesQuery({});
  assert.match(sql, /' days'\)::interval/);
  assert.ok(!/minutes/.test(sql), "jangan memakai menit untuk batas mesin");
  assert.equal(params[0], String(DEFAULT_STALE_AFTER_DAYS));
  assert.ok(Number(DEFAULT_STALE_AFTER_DAYS) >= 1, "ambang minimal satu hari");
});

test("istilahnya 'sudah lama tidak melapor', bukan online/offline", () => {
  assert.match(sql_placeholder(), /stale/);
  assert.ok(!/AS online/.test(sql_placeholder()), "kolom online harus hilang");
  // Halaman web dan aplikasi tidak boleh lagi menyebut online/offline.
  assert.ok(!/online' : 'offline|'online' : 'offline/.test(dash), "web masih memakai online/offline");
  assert.ok(!/"online" : "offline"/.test(app), "aplikasi masih memakai online/offline");
  assert.match(dash, /terakhir melapor/);
  assert.match(app, /terakhir melapor/);
});

test("mesin offline TETAP muncul - itu justru gunanya", () => {
  const { sql } = buildMachinesQuery({});
  const setelahWhere = sql.slice(sql.indexOf("WHERE"), sql.indexOf("GROUP BY"));
  assert.ok(!/updated_at >/.test(setelahWhere), "jangan menyaring mesin berdasarkan umur");
});

function sql_placeholder() {
  return buildMachinesQuery({}).sql;
}
