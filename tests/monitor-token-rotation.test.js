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

test("kedua endpoint tulis memakai pemeriksaan yang sama", () => {
  const panggilan = (dash.match(/if \(!writeAllowed\(req\)\)/g) || []).length;
  assert.equal(panggilan, 2, "POST /api/session dan /api/event harus sama-sama dijaga");
});

test("skrip rotasi tidak mengubah apa pun tanpa --apply", () => {
  const skrip = readFileSync(path.join(ROOT, "scripts", "rotate-monitor-token.sh"), "utf8");
  assert.match(skrip, /APPLY=0/);
  assert.match(skrip, /MODE KERING/);
  // Penulisan hanya boleh terjadi setelah penjagaan --apply.
  const idxApply = skrip.indexOf('if [ "$APPLY" -ne 1 ]');
  const idxTulis = skrip.indexOf("cp -p \"$ENVF\"");
  assert.ok(idxApply > 0 && idxTulis > idxApply, "penulisan harus berada setelah penjagaan --apply");
});

test("skrip rotasi mencadangkan berkas dan tidak mencetak token", () => {
  const skrip = readFileSync(path.join(ROOT, "scripts", "rotate-monitor-token.sh"), "utf8");
  assert.match(skrip, /cp -p "\$ENVF" "\$ENVF\.bak-\$STAMP"/);
  // Token tidak boleh pernah di-echo.
  assert.ok(!/echo[^\n]*\$BARU/.test(skrip), "skrip tidak boleh mencetak token");
  assert.match(skrip, /tidak dicetak/);
});

test("aturan token tetap: kosong ditolak, salah ditolak", () => {
  // Perilaku dasar tidak boleh berubah karena penambahan token lama.
  assert.equal(isWriteAuthorized({ header: "Bearer x", expectedToken: "" }), false);
  assert.equal(isWriteAuthorized({ header: "Bearer salah", expectedToken: "benar" }), false);
  assert.equal(isWriteAuthorized({ header: "Bearer benar", expectedToken: "benar" }), true);
});
