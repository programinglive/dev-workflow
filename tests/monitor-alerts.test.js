import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildAlerts, DEFAULT_STUCK_ALERT_MS, DEFAULT_MACHINE_SILENT_MS } = require(
  "../monitor-server/alerts.cjs",
);

/**
 * Saran yang saya ajukan sendiri kepada pemilik (2 November 2026):
 * "monitor yang memberi tahu, bukan yang ditunggu".
 *
 * Selama ini tablet hanya berguna kalau pemilik ingat melihatnya. Sesi yang
 * macet dan mesin yang berhenti melapor tidak pernah memberi tahu siapa pun.
 *
 * ATURAN YANG DIJAGA TES INI
 * --------------------------
 * Peringatan harus berdasarkan FAKTA yang bisa dibuktikan, bukan tebakan:
 * - "tidak melapor X" bukan "mati" - mesin yang menganggur memang diam.
 * - Sesi yang baru berhenti sebentar bukan macet. Ambangnya 30 menit, dan
 *   itulah yang mencegah tablet berteriak tiap kali satu task selesai.
 */

const NOW = Date.parse("2026-11-02T10:00:00Z");
const menitLalu = (m) => new Date(NOW - m * 60 * 1000).toISOString();

function sesi(over = {}) {
  return {
    session_key: "ses_uji",
    machine: "HELLOWORLD",
    task: "Perbaiki kartu",
    project_name: "dev-workflow-mcp-server",
    phase: "coding",
    state: "live",
    updated_at: menitLalu(1),
    ...over,
  };
}

function mesin(over = {}) {
  return { machine: "Mac", last_seen: menitLalu(5), sessions: 3, stale: false, ...over };
}

test("sesi yang baru saja melapor tidak memicu peringatan", () => {
  const a = buildAlerts({
    sessions: [sesi({ state: "live", updated_at: menitLalu(2) })],
    machines: [],
    now: NOW,
  });
  assert.deepEqual(a, [], "tablet tidak boleh berteriak tanpa sebab");
});

test("sesi maybe macet lebih dari 30 menit memicu peringatan", () => {
  const a = buildAlerts({
    sessions: [sesi({ state: "possibly_stuck", updated_at: menitLalu(45) })],
    machines: [],
    now: NOW,
  });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "sesi_macet");
  assert.equal(a[0].session_key, "ses_uji");
  assert.match(a[0].pesan, /45 menit/);
});

test("macet 20 menit BELUM memicu - terlalu dini untuk disebut macet", () => {
  const a = buildAlerts({
    sessions: [sesi({ state: "possibly_stuck", updated_at: menitLalu(20) })],
    machines: [],
    now: NOW,
  });
  assert.deepEqual(a, []);
  assert.ok(DEFAULT_STUCK_ALERT_MS >= 30 * 60 * 1000, "ambang bawaan minimal 30 menit");
});

test("sesi idle tidak pernah disebut macet", () => {
  // phase idle = task ditutup. Diam bukan berarti macet.
  const a = buildAlerts({
    sessions: [sesi({ state: "idle", phase: "idle", updated_at: menitLalu(600) })],
    machines: [],
    now: NOW,
  });
  assert.deepEqual(a, []);
});

test("sesi yang sudah berakhir lama tidak memicu peringatan", () => {
  // Berakhir normal. Kalau ini memicu, tablet akan penuh peringatan palsu
  // setiap kali mesin ditinggal semalam.
  const a = buildAlerts({
    sessions: [sesi({ state: "ended", updated_at: menitLalu(600) })],
    machines: [],
    now: NOW,
  });
  assert.deepEqual(a, []);
});

test("mesin yang diam lebih dari 24 jam memicu peringatan, tanpa menyebut mati", () => {
  const a = buildAlerts({
    sessions: [],
    machines: [mesin({ machine: "MMCH", last_seen: menitLalu(60 * 26) })],
    now: NOW,
  });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "mesin_diam");
  assert.equal(a[0].machine, "MMCH");
  // "mati" adalah klaim yang tidak bisa dibuktikan dari sini.
  assert.ok(!/mati/i.test(a[0].pesan), "jangan mengklaim mesin mati");
  assert.match(a[0].pesan, /tidak melapor/);
});

test("mesin yang melapor 2 jam lalu tidak memicu peringatan", () => {
  // Persis kesalahan yang sudah dua kali saya ulangi: mesin menganggur
  // dicap mati. Ambangnya harus sehari, bukan semenit.
  const a = buildAlerts({ sessions: [], machines: [mesin({ last_seen: menitLalu(120) })], now: NOW });
  assert.deepEqual(a, []);
  assert.ok(DEFAULT_MACHINE_SILENT_MS >= 20 * 60 * 60 * 1000, "ambang bawaan minimal 20 jam");
});

test("peringatan diurutkan dari yang paling lama", () => {
  const a = buildAlerts({
    sessions: [
      sesi({ session_key: "ses_a", state: "possibly_stuck", updated_at: menitLalu(40) }),
      sesi({ session_key: "ses_b", state: "possibly_stuck", updated_at: menitLalu(90) }),
    ],
    machines: [],
    now: NOW,
  });
  assert.deepEqual(
    a.map((x) => x.session_key),
    ["ses_b", "ses_a"],
  );
});

test("data rusak tidak membuat peringatan palsu maupun melempar", () => {
  const a = buildAlerts({
    sessions: [
      null,
      sesi({ updated_at: "bukan tanggal", state: "possibly_stuck" }),
      sesi({ updated_at: undefined, state: "possibly_stuck" }),
    ],
    machines: [null, mesin({ last_seen: null })],
    now: NOW,
  });
  assert.deepEqual(a, [], "tanpa waktu yang sah, tidak ada dasar untuk memperingatkan");
});

test("panggilan tanpa argumen tetap menjawab, tidak melempar", () => {
  assert.deepEqual(buildAlerts({}), []);
  assert.deepEqual(buildAlerts(), []);
});

test("nama sesi yang kosong diganti penanda, bukan string kosong", () => {
  const a = buildAlerts({
    sessions: [
      sesi({
        state: "possibly_stuck",
        updated_at: menitLalu(50),
        task: "",
        session_title: "",
        project_name: "",
      }),
    ],
    machines: [],
    now: NOW,
  });
  assert.equal(a.length, 1);
  assert.match(a[0].judul, /ses_uji/, "pakai potongan session_key supaya bisa dibedakan");
});

test("judul panjang dipotong supaya pesannya tetap terbaca", () => {
  // Terbukti di data nyata: judul task 90 karakter disambung "tidak melapor
  // 18 menit" menjadi satu kalimat yang tidak terbaca. Judulnya dipotong,
  // dan `judul` penuh tetap disimpan untuk keperluan lain.
  const panjang =
    "Riwayat kehilangan sesi tanpa started_at, dan monitor belum memberi tahu saat sesi macet";
  const a = buildAlerts({
    sessions: [sesi({ task: panjang, state: "possibly_stuck", updated_at: menitLalu(50) })],
    machines: [],
    now: NOW,
  });
  assert.equal(a.length, 1);
  assert.ok(a[0].pesan.length <= 80, `pesan terlalu panjang: ${a[0].pesan.length} karakter`);
  assert.ok(a[0].pesan.includes("…"), "potongan harus terlihat sebagai potongan");
  assert.equal(a[0].judul, panjang, "judul penuh tetap disimpan");
});
