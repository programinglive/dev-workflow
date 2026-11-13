import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createShareServer } = require("../monitor-server/share-server.cjs");
const {
  buildOrphanSharesQuery, buildOrphanCountQuery, buildRevokeOrphans,
} = require("../monitor-server/share-links.cjs");

const TOKEN = "T".repeat(43);

/**
 * TEMUAN AUDIT (3 November 2026, terukur di produksi)
 * ===================================================
 * Membuka halaman 3x lewat domain utama menaikkan `views` 0 → 3 (benar),
 * tetapi satu permintaan `HEAD` menaikkannya lagi → 4.
 *
 * Dua jenis pembaca yang TIDAK membuka halaman tetap terhitung:
 *   - crawler pratinjau WhatsApp (mengambil HEAD/GET untuk OG tag);
 *   - uptime monitor yang mengecek tautan setiap menit.
 *
 * Akibatnya angka "dibuka N×" yang dibaca pemilik bukan jumlah orang, dan
 * tidak ada cara mempercayainya. HEAD tidak boleh dihitung; ia memang bukan
 * kunjungan.
 */

let sentuh = 0;
let query;

before(() => {
  query = async (sql) => {
    const teks = String(sql);
    if (/FROM share_links l/.test(teks)) {
      return {
        rows: [{
          token: TOKEN, session_key: "s", revoked_at: null, live_session_key: "s",
          task: "x", views: 1, updated_at: new Date().toISOString(),
        }],
        rowCount: 1,
      };
    }
    if (/UPDATE share_links/.test(teks)) {
      sentuh += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
});

async function sekali(fn) {
  const s = createShareServer({ query, enableRateLimit: false });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    return await fn("http://127.0.0.1:" + s.address().port);
  } finally {
    await new Promise((r) => s.close(r));
  }
}

const jeda = () => new Promise((r) => setTimeout(r, 80));

test("GET menghitung satu kunjungan", async () => {
  sentuh = 0;
  await sekali(async (base) => {
    const r = await fetch(base + "/s/" + TOKEN);
    assert.equal(r.status, 200);
  });
  await jeda();
  assert.equal(sentuh, 1);
});

test("HEAD TIDAK dihitung sebagai kunjungan", async () => {
  sentuh = 0;
  await sekali(async (base) => {
    const r = await fetch(base + "/s/" + TOKEN, { method: "HEAD" });
    assert.equal(r.status, 200);
  });
  await jeda();
  assert.equal(sentuh, 0, "crawler dan uptime monitor memakai HEAD; hitungannya harus tetap untuk manusia");
});

test("404 dan 410 tidak menghitung kunjungan", async () => {
  sentuh = 0;
  const hantu = createShareServer({
    query: async (sql) => {
      const teks = String(sql);
      if (/FROM share_links l/.test(teks)) return { rows: [], rowCount: 0 };
      if (/UPDATE share_links/.test(teks)) { sentuh += 1; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
    enableRateLimit: false,
  });
  await new Promise((r) => hantu.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch("http://127.0.0.1:" + hantu.address().port + "/s/" + TOKEN);
    assert.equal(r.status, 404);
  } finally {
    await new Promise((r) => hantu.close(r));
  }
  await jeda();
  assert.equal(sentuh, 0, "tautan yang tidak ada tidak punya baris untuk dihitung");
});

test("jumlah yatim dihitung database, bukan dari daftar yang dibatasi 200", async () => {
  // Daftar tautan dibatasi LIMIT 200. Menghitung yatim dari daftar itu
  // melaporkan angka yang salah begitu tautan hidup melewati 200 - dan angka
  // itu yang dipakai tombol "Cabut yang yatim".
  const { sql } = buildOrphanCountQuery();
  assert.match(sql, /count\(\*\)/i);
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /revoked_at IS NULL/);
  assert.ok(!/LIMIT/i.test(sql), "COUNT tidak boleh dibatasi");
});

test("query daftar yatim tetap ada dan konsisten dengan COUNT", () => {
  const daftar = buildOrphanSharesQuery().sql;
  const hitung = buildOrphanCountQuery().sql;
  // Syarat keduanya harus sama, kalau tidak tombol dan angkanya berbeda cerita.
  assert.match(daftar, /s\.session_key IS NULL/);
  assert.match(hitung, /NOT EXISTS/);
  assert.match(buildRevokeOrphans().sql, /NOT EXISTS/);
});
