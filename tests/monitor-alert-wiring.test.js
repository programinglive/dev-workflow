import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildAlerts } = require("../monitor-server/alerts.cjs");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");
const app = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");

const NOW = Date.parse("2026-11-02T10:00:00Z");

/**
 * Saran yang saya ajukan sendiri lalu kerjakan (2 November 2026):
 * "monitor yang memberi tahu, bukan yang ditunggu".
 *
 * Fungsi peringatan yang benar tetapi tidak pernah dipanggil tidak berguna.
 * Tes ini menjaga rantainya utuh: server menghitung, respons membawa, dan
 * kedua layar menampilkan.
 */

test("server mengirim peringatan di respons /api/sessions", () => {
  assert.match(dash, /require\('\.\/alerts\.cjs'\)/);
  assert.match(dash, /const alerts = buildAlerts\(\{/);
  // `alerts` harus ikut di JSON respons; tanpa ini fungsinya jadi kode mati.
  assert.match(dash, /machines, fleet, history, alerts, summary, shares, summary_days: SUMMARY_DAYS \}\)/);
});

test("peringatan dihitung dari baris yang memang tampil", () => {
  // Kalau dihitung dari sumber lain, angka di peringatan bisa berbeda dengan
  // isi layar, dan pemilik akan mencari sesi yang tidak ada.
  assert.match(dash, /sessions: tampil,/);
});

test("halaman web punya kotak peringatan", () => {
  assert.match(dash, /<div id="alerts"><\/div>/);
  assert.match(dash, /const al = data\.alerts \|\| \[\];/);
  assert.match(dash, /hal perlu dilihat/);
});

test("aplikasi punya kotak peringatan dan bisa diketuk", () => {
  assert.match(app, /const alerts = \(data && data\.alerts\) \|\| \[\];/);
  assert.match(app, /hal perlu dilihat/);
  // Peringatan sesi harus membuka detail sesi itu.
  assert.match(app, /setDipilih\(a\.session_key\)/);
});

test("teks peringatan tidak pernah menyebut mesin 'mati'", () => {
  // Dua kali saya mengulangi kesalahan yang sama: mengklaim sesuatu yang tidak
  // bisa dibuktikan dari server. Yang diuji adalah TEKS YANG TAMPIL, bukan
  // komentar - komentar justru menjelaskan bahwa klaim itu dilarang.
  const teks = buildAlerts({
    sessions: [
      {
        session_key: "ses_x",
        machine: "Mac",
        task: "tugas",
        phase: "coding",
        state: "possibly_stuck",
        updated_at: new Date(NOW - 90 * 60 * 1000).toISOString(),
      },
    ],
    machines: [
      { machine: "MMCH", last_seen: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString() },
    ],
    now: NOW,
  });
  assert.equal(teks.length, 2);
  for (const t of teks) {
    assert.ok(!/\bmati\b/i.test(t.pesan), `pesan tidak boleh menyebut mati: ${t.pesan}`);
    assert.match(t.pesan, /tidak melapor/);
  }
});

test("sesi idle tidak pernah dijadikan peringatan", () => {
  // `idle` berarti task DITUTUP. Diam adalah hasil yang benar, bukan masalah.
  const hasil = buildAlerts({
    sessions: [
      {
        session_key: "ses_idle",
        machine: "Mac",
        task: "sudah selesai",
        phase: "idle",
        state: "idle",
        updated_at: new Date(NOW - 600 * 60 * 1000).toISOString(),
      },
    ],
    machines: [],
    now: NOW,
  });
  assert.deepEqual(hasil, []);
});
