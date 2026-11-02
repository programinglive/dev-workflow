import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  PUBLIC_DENY, escapeHtml, securityHeaders,
  renderSharePage, renderStatusPage, shareTitle,
} = require("../monitor-server/share-page.cjs");

const NOW = "2026-11-02T10:00:00.000Z";

/**
 * Sesi dengan SETIAP field terisi. Nilai rahasianya sengaja unik supaya
 * kebocoran satu field saja langsung terlihat di HTML.
 *
 * Halaman yang hanya diuji dengan sesi kosong akan lulus sambil membocorkan
 * nama mesin pada sesi sungguhan - persis kelas kesalahan yang tes ini tutup.
 */
const SESI = {
  live_session_key: "ses_RAHASIA_123",
  session_key: "ses_RAHASIA_123",
  machine: "MESIN_RAHASIA",
  project_path: "D:\\RAHASIA\\proyek",
  project_name: "PROYEK_RAHASIA",
  agent_tool: "ALAT_RAHASIA",
  owner_pid: 4242,
  task: "Perbaiki bug login",
  task_type: "bugfix",
  phase: "coding",
  plan_json: [
    { id: "p1", text: "telusuri handler", status: "done" },
    { id: "p2", text: "tulis tes gagal", status: "open" },
  ],
  plan_done: 1,
  plan_total: 2,
  dod_done: 1,
  dod_total: 3,
  dod_waived: 0,
  started_at: "2026-11-02T08:00:00.000Z",
  updated_at: "2026-11-02T09:59:00.000Z",
  session_title: "Sesi perbaikan login",
};

const SHARE = { token: "T".repeat(43), created_at: "2026-11-02T09:00:00.000Z", views: 4 };

function html(session = SESI, share = SHARE) {
  return renderSharePage({ share, session, now: NOW });
}

test("tidak satu pun field terlarang muncul di HTML", () => {
  const out = html();
  const bocor = PUBLIC_DENY.filter((field) => {
    const value = SESI[field];
    return value != null && String(value) !== "" && out.includes(String(value));
  });
  assert.deepEqual(bocor, [], "field terlarang bocor ke halaman publik: " + bocor.join(", "));
  for (const nama of PUBLIC_DENY) {
    assert.ok(!out.includes(nama), `nama field "${nama}" tidak boleh muncul di HTML`);
  }
});

test("yang memang perlu dibagikan tetap tampil", () => {
  const out = html();
  assert.ok(out.includes("Perbaiki bug login"), "task harus tampil");
  assert.ok(out.includes("coding"), "fase harus tampil");
  assert.ok(out.includes("telusuri handler"), "langkah rencana harus tampil");
  assert.ok(out.includes("tulis tes gagal"), "langkah yang belum selesai juga tampil");
  assert.match(out, /1\s*\/\s*2/, "progres rencana");
  assert.match(out, /1\s*\/\s*3/, "progres DoD");
});

test("teks yang bisa memutus tag di-escape", () => {
  const jahat = {
    ...SESI,
    task: '</title><script>alert(1)</script> & "kutip"',
    plan_json: [{ id: "p1", text: "<img src=x onerror=alert(2)>", status: "open" }],
  };
  const out = html(jahat);
  assert.ok(!out.includes("<script>alert(1)</script>"));
  assert.ok(!out.includes("<img src=x"));
  assert.ok(out.includes("&lt;script&gt;"), "teks asli tetap terbaca sebagai teks");
  assert.ok(out.includes("&amp;"));
  assert.ok(out.includes("&quot;kutip&quot;"));
  assert.equal(out.match(/<\/title>/g).length, 1, "hanya satu </title> yang sah");
});

test("escapeHtml menutup empat karakter yang berbahaya", () => {
  assert.equal(escapeHtml('<>&"'), "&lt;&gt;&amp;&quot;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(0), "0");
});

test("OG tag memuat judul dan progres supaya pratinjau WhatsApp berguna", () => {
  const out = html();
  assert.match(out, /<meta property="og:title" content="[^"]*Perbaiki bug login/);
  assert.match(out, /<meta property="og:description"/);
  assert.match(out, /<meta property="og:url" content="https:\/\/devworkflow\.programinglive\.com\/s\//);
  assert.match(out, /<meta name="twitter:card" content="summary"/);
  assert.ok(!/og:image/.test(out), "tanpa gambar: static export tidak bisa membuatnya");
  assert.match(out, /<meta name="robots" content="noindex/);
});

test("tautan alternatif ditampilkan sebagai jalan kedua", () => {
  const out = html();
  assert.ok(out.includes("devwfshare.programinglive.com/s/"));
  assert.ok(out.includes("devworkflow.programinglive.com/s/"));
});

test("halaman tanpa JavaScript", () => {
  const out = html();
  assert.ok(!/<script/i.test(out), "CSP default-src none, jadi skrip tidak akan jalan");
  assert.ok(!/onclick=/i.test(out));
});

test("sesi tanpa rencana dan tanpa waktu mulai tetap dirender jujur", () => {  const out = html({
    ...SESI,
    plan_json: [],
    plan_done: 0,
    plan_total: 0,
    dod_total: 0,
    dod_done: 0,
    started_at: null,
  });
  assert.ok(out.includes("Perbaiki bug login"));
  assert.match(out, /tidak tercatat/, "waktu mulai kosong disebut apa adanya, bukan 0 detik");
  assert.ok(!/rencana 0\s*\/\s*0/i.test(out));
});

test("task kosong tidak menghasilkan judul kosong", () => {
  assert.equal(shareTitle({ ...SESI, task: "", session_title: "" }), "Sesi dev workflow");
  assert.equal(shareTitle({ ...SESI, task: "", session_title: "Judul" }), "Judul");
  assert.equal(shareTitle({ ...SESI, task: "Tugas" }), "Tugas");
  // Spasi saja bukan task: jatuh ke judul sesi yang memang terisi.
  assert.equal(shareTitle({ ...SESI, task: "   " }), SESI.session_title);
  assert.equal(shareTitle({ ...SESI, task: "   ", session_title: "" }), "Sesi dev workflow");
});

test("rencana yang dipotong menyebut jumlah sisanya", () => {
  // Rencana 60 langkah dulu tampil 40 tanpa keterangan, sehingga tampak
  // selesai padahal tidak. Halaman yang menyembunyikan sisa pekerjaan
  // membohongi pembacanya.
  const banyak = Array.from({ length: 60 }, (_, i) => ({ id: "p" + i, text: "langkah " + i, status: "open" }));
  const out = html({ ...SESI, plan_json: banyak, plan_done: 0, plan_total: 60 });
  assert.ok(out.includes("langkah 39"), "40 langkah pertama tampil");
  assert.ok(!out.includes("langkah 40<"), "langkah ke-41 tidak dirender");
  assert.match(out, /dan 20 langkah lain|dan\s*20\s*langkah/);
});

test("jumlah kunjungan disebut sebagai milik pembaca sebelumnya", () => {
  const out = html();
  assert.match(out, /sebelum Anda/, "angka views dibaca sebelum kunjungan ini dihitung");
});

test("halaman status untuk 404 dan 410 berbunyi berbeda", () => {  const hilang = renderStatusPage({ status: 404, message: "Tautan tidak dikenal." });
  const dicabut = renderStatusPage({ status: 410, message: "Tautan ini sudah dicabut pemiliknya." });
  assert.ok(hilang.includes("Tautan tidak dikenal"));
  assert.ok(dicabut.includes("sudah dicabut"));
  assert.notEqual(hilang, dicabut);
});

test("header keamanan lengkap", () => {
  const h = securityHeaders();
  assert.equal(h["cache-control"], "no-store");
  assert.equal(h["x-robots-tag"], "noindex");
  assert.equal(h["referrer-policy"], "no-referrer");
  assert.match(h["content-security-policy"], /default-src 'none'/);
  assert.match(h["content-security-policy"], /style-src 'unsafe-inline'/);
  assert.match(h["content-type"], /text\/html/);
});

test("umur laporan disebut supaya pembaca tahu ini snapshot, bukan siaran langsung", () => {
  const out = html();
  assert.match(out, /10\s*menit|menit lalu/, "harus ada umur laporan terakhir");
  // Yang dilarang adalah MENGAKU langsung. Menyangkalnya ("bukan siaran
  // langsung") justru yang diinginkan, jadi yang diperiksa adalah ada-tidaknya
  // frasa penyangkalan itu, bukan kata "langsung" secara membabi buta.
  assert.match(out, /bukan siaran langsung/i, "halaman harus jujur bahwa ini cuplikan");
  assert.ok(!/\b(data|status)\s+langsung\b/i.test(out), "jangan menyebut data langsung");
});
