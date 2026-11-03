import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSessionsQuery, DEFAULT_IDLE_TTL, DEFAULT_EMPTY_IDLE_TTL } = require(
  "../monitor-server/sessions-query.cjs",
);

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
  // started_at WAJIB ikut di SELECT: tanpa itu nilainya tersimpan di database
  // tetapi tidak pernah dibaca, dan counter durasi tidak pernah muncul.
  assert.match(sql.slice(0, sql.indexOf("FROM")), /started_at/);

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

/**
 * Kartu "IDLE (tanpa task)" tidak memberi informasi apa pun, tetapi menempati
 * satu slot penuh di layar tablet. Diukur 1 November 2026: kedua tablet hanya
 * menampilkan satu kartu seperti itu sementara dashboard penuh sesi nyata di
 * mesin lain. Karena itu idle kosong punya batas umur sendiri yang jauh lebih
 * pendek.
 */
test("idle tanpa task dibuang lebih cepat daripada idle bertask", () => {
  const { sql, params } = buildSessionsQuery({});
  assert.equal(DEFAULT_EMPTY_IDLE_TTL, "1 minute");
  assert.match(sql, /task = ''/);
  assert.match(sql, /updated_at < now\(\) - \$3::interval/);
  assert.equal(params[2], DEFAULT_EMPTY_IDLE_TTL);

  const menit = (s) => Number(String(s).split(" ")[0]);
  assert.ok(
    menit(DEFAULT_EMPTY_IDLE_TTL) < menit(DEFAULT_IDLE_TTL),
    `idle kosong (${DEFAULT_EMPTY_IDLE_TTL}) harus lebih pendek dari idle bertask (${DEFAULT_IDLE_TTL})`,
  );
});

test("emptyIdleTtl bisa diatur dan punya nilai bawaan", () => {
  assert.equal(buildSessionsQuery({ emptyIdleTtl: "1 minute" }).params[2], "1 minute");
  assert.equal(buildSessionsQuery({ emptyIdleTtl: "" }).params[2], DEFAULT_EMPTY_IDLE_TTL);
});

test("limit diteruskan sebagai parameter, bukan disisipkan ke SQL", () => {
  const { sql, params } = buildSessionsQuery({ limit: 7 });
  assert.equal(params[0], 7);
  assert.match(sql, /LIMIT \$1/);
  assert.ok(!sql.includes("7"), "angka limit tidak boleh masuk teks SQL");
});
