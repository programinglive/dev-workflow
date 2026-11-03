import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");

test("halaman dashboard memuat bottom navigation bar dengan 5 tab", () => {
  assert.match(dash, /class="tabbar"/);
  assert.match(dash, /data-tab="aktif"/);
  assert.match(dash, /data-tab="riwayat"/);
  assert.match(dash, /data-tab="rekap"/);
  assert.match(dash, /data-tab="mesin"/);
  assert.match(dash, /data-tab="info"/);
});

test("halaman dashboard memuat container tab untuk tiap bagian", () => {
  assert.match(dash, /id="tab-aktif"/);
  assert.match(dash, /id="tab-riwayat"/);
  assert.match(dash, /id="tab-rekap"/);
  assert.match(dash, /id="tab-mesin"/);
  assert.match(dash, /id="tab-info"/);
});

test("halaman dashboard memuat modal detail sesi", () => {
  assert.match(dash, /id="modal-detail"/);
  assert.match(dash, /class="modal-backdrop"/);
  assert.match(dash, /class="modal-box"/);
  assert.match(dash, /id="modal-task"/);
  assert.match(dash, /id="modal-plan"/);
  assert.match(dash, /id="modal-dod"/);
});

test("kartu sesi memiliki data-session-key dan teks ketuk untuk detail", () => {
  assert.match(dash, /data-session-key=/);
  assert.match(dash, /ketuk untuk detail/);
});

test("delegasi klik mendukung membuka detail dan beralih tab", () => {
  assert.match(dash, /bukaDetail/);
  assert.match(dash, /tutupModal/);
  assert.match(dash, /pilihTab/);
});

test("dashboard memuat endpoint /api/session/close dan tombol Tutup Sesi", () => {
  assert.match(dash, /\/api\/session\/close/);
  assert.match(dash, /modal-close-session-btn/);
  assert.match(dash, /Tutup Sesi/);
});

test("mobile app memuat tombol Tutup Sesi dan konfirmasi penutupan", () => {
  const appJs = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");
  assert.match(appJs, /konfirmasiTutupSesi/);
  assert.match(appJs, /\/api\/session\/close/);
  assert.match(appJs, /Tutup Sesi/);
});
