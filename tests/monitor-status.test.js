import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  classifySession,
  LABELS,
  DEFAULT_LIVE_MS,
  DEFAULT_STUCK_MS,
} = require("../monitor-server/status.cjs");

/**
 * Diukur 1 November 2026: task yang sudah selesai (commit, rilis, deploy)
 * masih tampil sebagai kartu CODING 52 menit kemudian. Dashboard mengaku ada
 * pekerjaan hidup padahal tidak ada — kebohongan ke arah yang paling
 * berbahaya, karena pemiliknya akan menunggu sesuatu yang tidak akan datang.
 */

const NOW = new Date("2026-11-01T12:00:00Z");
const menitLalu = (n) => new Date(NOW.getTime() - n * 60 * 1000);

test("melapor belum lama: aktif", () => {
  const s = classifySession({ phase: "coding", updatedAt: menitLalu(5), now: NOW });
  assert.equal(s.status, "live");
  assert.equal(s.ageMs, 5 * 60 * 1000);
});

test("fase idle selalu idle, walau baru saja melapor", () => {
  const s = classifySession({ phase: "idle", updatedAt: menitLalu(1), now: NOW });
  assert.equal(s.status, "idle");
});

test("lama tidak melapor tapi belum terlalu lama: mungkin macet", () => {
  const s = classifySession({ phase: "coding", updatedAt: menitLalu(60), now: NOW });
  assert.equal(s.status, "possibly_stuck");
});

test("sangat lama: berakhir, bukan diklaim masih bekerja", () => {
  // Kasus nyata: task selesai tapi phase tidak pernah diubah ke idle.
  const s = classifySession({ phase: "coding", updatedAt: menitLalu(52), now: NOW });
  assert.equal(s.status, "possibly_stuck", "52 menit masih 'mungkin macet'");

  const s3 = classifySession({ phase: "coding", updatedAt: menitLalu(180), now: NOW });
  assert.equal(s3.status, "ended");
});

test("perbatasan: tepat di batas masih termasuk kelompok sebelumnya", () => {
  assert.equal(
    classifySession({ phase: "coding", updatedAt: menitLalu(15), now: NOW }).status,
    "live",
  );
  assert.equal(
    classifySession({ phase: "coding", updatedAt: menitLalu(15.1), now: NOW }).status,
    "possibly_stuck",
  );
  assert.equal(
    classifySession({ phase: "coding", updatedAt: menitLalu(120), now: NOW }).status,
    "possibly_stuck",
  );
  assert.equal(
    classifySession({ phase: "coding", updatedAt: menitLalu(120.1), now: NOW }).status,
    "ended",
  );
});

test("batas bisa diatur", () => {
  const s = classifySession({
    phase: "coding",
    updatedAt: menitLalu(30),
    now: NOW,
    liveMs: 45 * 60 * 1000,
    stuckMs: 60 * 60 * 1000,
  });
  assert.equal(s.status, "live");
  assert.equal(DEFAULT_LIVE_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_STUCK_MS, 2 * 60 * 60 * 1000);
});

test("tanpa waktu laporan yang sah, tidak diklaim hidup", () => {
  for (const value of [null, undefined, "", "bukan tanggal"]) {
    const s = classifySession({ phase: "coding", updatedAt: value, now: NOW });
    assert.equal(s.status, "ended", `nilai ${String(value)} harus berakhir`);
  }
});

test("umur tidak negatif bila jam bergeser", () => {
  const s = classifySession({
    phase: "coding",
    updatedAt: new Date(NOW.getTime() + 60_000),
    now: NOW,
  });
  assert.equal(s.ageMs, 0);
  assert.equal(s.status, "live");
});

test("setiap status punya label yang bisa dibaca manusia", () => {
  for (const key of ["idle", "live", "possibly_stuck", "ended"]) {
    assert.equal(typeof LABELS[key], "string");
    assert.ok(LABELS[key].length > 0);
  }
  assert.equal(LABELS.possibly_stuck, "mungkin macet");
});

test("fase terminal selalu berakhir, walau baru saja ditutup", () => {
  // Diukur 7 November 2026: sesi yang ditutup manual tampil "aktif" di Riwayat
  // dan masuk filter Live, bukan Selesai, karena classifySession hanya melihat
  // umur laporan.
  for (const phase of ["closed", "done", "cancelled", "archived"]) {
    const s = classifySession({ phase, updatedAt: menitLalu(1), now: NOW });
    assert.equal(s.status, "ended", `${phase} harus berakhir`);
    assert.equal(s.terminal, true, `${phase} harus ditandai terminal`);
  }
});
