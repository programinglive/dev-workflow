import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isWriteAuthorized } = require("../monitor-server/retention.cjs");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Rotasi token harus bisa dilakukan TANPA memutus mesin yang belum diperbarui.
 *
 * Tanpa token lama yang masih diterima sebentar, setiap mesin yang belum
 * diganti ditolak 401 dan kartunya hilang diam-diam - kegagalan yang baru
 * ketahuan berhari-hari kemudian.
 */

const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");

test("server punya jalur token lama selama masa rotasi", () => {
  assert.match(dash, /DEVWF_MONITOR_TOKEN_PREVIOUS/);
  assert.match(dash, /function writeAllowed\(req\)/);
  // Token lama hanya berlaku bila diisi; kosong berarti tidak ada toleransi.
  assert.match(dash, /if \(!WRITE_TOKEN_PREVIOUS\) return false;/);
});

test("ketiga endpoint tulis memakai pemeriksaan yang sama", () => {
  const panggilan = (dash.match(/if \(!writeAllowed\(req\)\)/g) || []).length;
  // POST /api/session, POST /api/event, and POST /api/reaper/action. The reaper
  // action can archive a card, so it must use the same write token as the
  // report endpoints instead of a separate weaker check.
  assert.equal(panggilan, 3, "POST /api/session, /api/event dan /api/reaper/action harus dijaga");
});

test("templat env monitor mendokumentasikan token tanpa nilai nyata", () => {
  const envExample = readFileSync(path.join(ROOT, "monitor-server", "devwf-monitor.env.example"), "utf8");
  assert.match(envExample, /DEVWF_MONITOR_TOKEN=GANTI_TOKEN_PANJANG_ACAK/);
  assert.match(envExample, /127\.0\.0\.1:5432/);
});

test("aturan token tetap: kosong ditolak, salah ditolak", () => {
  // Perilaku dasar tidak boleh berubah karena penambahan token lama.
  assert.equal(isWriteAuthorized({ header: "Bearer x", expectedToken: "" }), false);
  assert.equal(isWriteAuthorized({ header: "Bearer salah", expectedToken: "benar" }), false);
  assert.equal(isWriteAuthorized({ header: "Bearer benar", expectedToken: "benar" }), true);
});
