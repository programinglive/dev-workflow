import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildMachinesQuery, DEFAULT_OFFLINE_AFTER_MINUTES } = require(
  "../monitor-server/machines-query.cjs",
);

/**
 * Pemilik bertanya "saya ngga lihat task dari MMCH dan Mac". Kedua mesin itu
 * sehat, hanya belum dipakai - dan sesi tanpa task memang disembunyikan.
 *
 * Akibatnya "tidak ada pekerjaan" dan "mesin tidak pernah terhubung" tampak
 * sama: dua-duanya tidak menampilkan apa pun. Daftar mesin memisahkan keduanya.
 */
test("query mengelompokkan per mesin dan menghitung online dari umur laporan", () => {
  const { sql, params } = buildMachinesQuery({});
  assert.match(sql, /GROUP BY machine/);
  assert.match(sql, /max\(updated_at\) AS last_seen/);
  assert.match(sql, /::interval\) AS online/);
  assert.equal(params[0], String(DEFAULT_OFFLINE_AFTER_MINUTES));
});

test("mesin offline TETAP muncul - itu justru gunanya", () => {
  const { sql } = buildMachinesQuery({});
  // Tidak boleh ada saringan yang membuang mesin tua; statusnya saja yang beda.
  const setelahWhere = sql.slice(sql.indexOf("WHERE"), sql.indexOf("GROUP BY"));
  assert.ok(!/updated_at >/.test(setelahWhere), "jangan menyaring mesin berdasarkan umur");
  assert.match(setelahWhere, /machine <> ''/);
});

test("ikut membawa konteks terakhir supaya mesin bisa dikenali", () => {
  const { sql } = buildMachinesQuery({});
  for (const kolom of ["last_phase", "last_task", "last_project", "last_title"]) {
    assert.ok(sql.includes(kolom), `harus menyertakan ${kolom}`);
  }
});

test("batas offline bisa diatur dan nilai aneh jatuh ke bawaan", () => {
  assert.equal(buildMachinesQuery({ offlineAfterMinutes: 5 }).params[0], "5");
  assert.equal(buildMachinesQuery({ offlineAfterMinutes: 0 }).params[0], String(DEFAULT_OFFLINE_AFTER_MINUTES));
  assert.equal(buildMachinesQuery({ offlineAfterMinutes: "abc" }).params[0], String(DEFAULT_OFFLINE_AFTER_MINUTES));
});
