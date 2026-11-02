import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");
// SQL UPSERT tinggal di modulnya sendiri supaya bisa diuji tanpa menyalakan
// server; `dashboard.cjs` hanya memanggilnya.
const upsert = readFileSync(
  path.join(ROOT, "monitor-server", "session-upsert.cjs"),
  "utf8",
);
const ws = readFileSync(path.join(ROOT, "workflow-state.js"), "utf8");
const handlers = readFileSync(
  path.join(ROOT, "tools", "handler-modules", "workflow-handlers.js"),
  "utf8",
);

/**
 * Pemilik meminta counter waktu per task. Percobaan pertama gagal karena
 * `started_at` diisi dari MEMORI PROSES (`this.sessionStartedAt`), sehingga
 * hilang setiap proses MCP restart - dan dashboard menerima nilai kosong.
 *
 * Perbaikannya: waktu mulai disimpan di STATE (`taskStartedAt`), ikut ke disk,
 * dan bertahan melewati restart.
 */

test("start_task menyimpan waktu mulai ke state, bukan hanya ke memori", () => {
  assert.match(handlers, /state\.taskStartedAt = new Date\(\)\.toISOString\(\)/);
});

test("pelapor memakai taskStartedAt dari state", () => {
  assert.match(ws, /sessionStartedAt: \(state && state\.taskStartedAt\) \|\| createdAt \|\| ""/);
});

test("database tidak membekukan nilai kosong", () => {
  // COALESCE saja akan menyimpan NULL selamanya bila baris lama kosong.
  // LEAST(NULL, x) juga NULL, jadi tiap sisi dibungkus GREATEST (yang
  // mengabaikan NULL di PostgreSQL).
  assert.match(upsert, /started_at=LEAST\(/);
  assert.match(upsert, /GREATEST\(sessions\.started_at, EXCLUDED\.started_at\)/);
  assert.match(upsert, /GREATEST\(EXCLUDED\.started_at, sessions\.started_at\)/);
});
