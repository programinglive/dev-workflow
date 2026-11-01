import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSessionsQuery, DEFAULT_IDLE_TTL } = require("../monitor-server/sessions-query.cjs");

/**
 * Sesi mati tidak boleh memenuhi layar tablet.
 *
 * Proses MCP mati bersama sesi OpenCode-nya, jadi baris `idle` tinggal
 * selamanya. Filter umur hanya boleh menyentuh `idle`: sesi yang masih bekerja
 * tidak punya batas, karena satu tugas panjang yang jarang menyimpan state
 * tetap pekerjaan nyata.
 */
test("query menyaring idle yang basi, bukan yang sedang bekerja", () => {
  const { sql } = buildSessionsQuery({});
  const where = sql.slice(sql.indexOf("WHERE"));

  assert.match(where, /phase = 'idle'/);
  assert.match(where, /updated_at < now\(\) - \$2::interval/);
  // Bentuk filter harus "NOT (...)", bukan saringan phase biasa: kalau salah,
  // sesi coding ikut hilang dari dashboard.
  assert.match(where, /NOT \(/);
});

test("idleTtl bisa diatur dan punya nilai bawaan", () => {
  assert.equal(buildSessionsQuery({}).params[1], DEFAULT_IDLE_TTL);
  assert.equal(buildSessionsQuery({ idleTtl: "5 minutes" }).params[1], "5 minutes");
  // Nilai kosong jatuh ke bawaan, bukan menghasilkan interval tidak valid.
  assert.equal(buildSessionsQuery({ idleTtl: "" }).params[1], DEFAULT_IDLE_TTL);
});

test("limit diteruskan sebagai parameter, bukan disisipkan ke SQL", () => {
  const { sql, params } = buildSessionsQuery({ limit: 7 });
  assert.equal(params[0], 7);
  assert.match(sql, /LIMIT \$1/);
  assert.ok(!sql.includes("7"), "angka limit tidak boleh masuk teks SQL");
});
