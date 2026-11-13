import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dedupeSessions, isSessionKey } = require("../monitor-server/dedupe-sessions.cjs");

/**
 * Diukur 2 November 2026: dua kartu "Perbaiki tampilan kartu di Mac" tampil
 * berdampingan di tablet - satu berkunci `ses_` dan berjudul, satu berkunci
 * `pid-99880` tanpa judul. Keduanya sesi yang sama.
 *
 * Penyebabnya: proses MCP yang tidak menerima ID sesi OpenCode memakai PID
 * sebagai kunci. Karena identitas di database dibiarkan apa adanya,
 * penggabungan dilakukan saat membaca.
 */

const sesi = (key, machine, task, title = "") => ({
  session_key: key,
  machine,
  task,
  session_title: title,
});

test("kunci ses_ dikenali, kunci pid- bukan", () => {
  assert.equal(isSessionKey("ses_e67f59f2"), true);
  assert.equal(isSessionKey("ses-abc"), true);
  assert.equal(isSessionKey("pid-99880"), false);
  assert.equal(isSessionKey(""), false);
});

test("kembar: pid- dibuang, ses_ dipertahankan karena bisa dicari judulnya", () => {
  const hasil = dedupeSessions([
    sesi("ses_e67f59f2", "Mac", "Perbaiki tampilan kartu di Mac", "List GitHub repositories"),
    sesi("pid-99880", "Mac", "Perbaiki tampilan kartu di Mac"),
  ]);
  assert.equal(hasil.length, 1);
  assert.equal(hasil[0].session_key, "ses_e67f59f2");
  assert.equal(hasil[0].session_title, "List GitHub repositories");
});

test("urutan asli dipertahankan", () => {
  const hasil = dedupeSessions([
    sesi("pid-111", "Mac", "Sama"),
    sesi("ses_bbb", "Mac", "Sama"),
    sesi("ses_ccc", "Mac", "Beda"),
  ]);
  assert.deepEqual(
    hasil.map((s) => s.session_key),
    ["ses_bbb", "ses_ccc"],
  );
});

test("mesin berbeda dengan task sama BUKAN duplikat", () => {
  const hasil = dedupeSessions([
    sesi("ses_a", "MMCH", "Kerjakan modul"),
    sesi("ses_b", "Mac", "Kerjakan modul"),
  ]);
  assert.equal(hasil.length, 2);
});

test("sesi tanpa task tidak pernah digabung", () => {
  const hasil = dedupeSessions([
    sesi("pid-111", "Mac", ""),
    sesi("pid-222", "Mac", ""),
    sesi("ses_x", "Mac", "   "),
  ]);
  assert.equal(hasil.length, 3, "tiga sesi menganggur bukan duplikat");
});

test("dua kunci pid- dengan task sama: satu yang tersisa", () => {
  const hasil = dedupeSessions([
    sesi("pid-111", "Mac", "Sama"),
    sesi("pid-222", "Mac", "Sama"),
  ]);
  assert.equal(hasil.length, 1);
});

test("input bukan array tidak melempar", () => {
  assert.deepEqual(dedupeSessions(null), []);
  assert.deepEqual(dedupeSessions(undefined), []);
});
