import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { handleCreateShare, shareGuard } = require("../monitor-server/share-route.cjs");

/**
 * TEMUAN REVIEW (2 November 2026)
 * ===============================
 * Balapan tiga tab pada sesi yang baru saja dicabut tautannya dulu berakhir
 * `500`, padahal jawabannya bukan kesalahan server: "orang lain baru saja
 * membuatnya, baca yang itu". 500 memberitahu pemilik bahwa ada yang rusak.
 */

const TOKEN = "T".repeat(43);

function fakeQuery(handler) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return handler(String(sql), params) || { rows: [], rowCount: 0 };
  };
  query.calls = calls;
  return query;
}

test("balapan tiga tab tidak pernah menjadi 500", async () => {
  // Skenario: sesi ada. Sisipan pertama kalah (DO NOTHING). Pembacaan tautan
  // hidup kosong (baru saja dicabut). Sisipan ulang juga kalah oleh tab
  // ketiga. Jawaban yang benar: 200 dengan tautan milik pemenang.
  let insert = 0;
  let bacaHidup = 0;
  const query = fakeQuery((sql) => {
    const t = String(sql);
    if (/FROM sessions WHERE session_key/.test(t)) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (/INSERT INTO share_links/.test(t)) {
      insert += 1;
      return { rows: [], rowCount: 0 };
    }
    if (/FROM\s+share_links[\s\S]*WHERE\s+session_key/.test(t)) {
      bacaHidup += 1;
      // Percobaan pertama kosong (dicabut), percobaan berikutnya menemukan
      // tautan yang baru dibuat tab lain.
      return bacaHidup === 1
        ? { rows: [], rowCount: 0 }
        : { rows: [{ token: TOKEN, created_at: "2026-11-02T09:00:00.000Z", views: 3 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const hasil = await handleCreateShare({ query, sessionKey: "ses_1" });
  assert.equal(hasil.status, 200, "konflik yang wajar bukan kesalahan server");
  assert.equal(hasil.body.token, TOKEN);
  assert.equal(hasil.body.views, 3);
  assert.ok(insert >= 1, "harus benar-benar mencoba menyisipkan");
});

test("kegagalan menyisipkan yang bukan konflik tetap dilaporkan sebagai galat database", async () => {
  const query = async (sql) => {
    const t = String(sql);
    if (/FROM sessions WHERE session_key/.test(t)) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (/INSERT INTO share_links/.test(t)) throw Object.assign(new Error("db putus"), { code: "ECONNRESET" });
    return { rows: [], rowCount: 0 };
  };
  const hasil = await handleCreateShare({ query, sessionKey: "ses_1" });
  assert.equal(hasil.status, 500, "galat sungguhan tetap 500, jangan ditelan");
  assert.equal(hasil.body.ok, false);
});

test("pembacaan ulang dibatasi supaya permintaan tidak menggantung", async () => {
  // Tidak ada pemenang yang bisa dibaca: setiap sisipan kalah, setiap
  // pembacaan kosong. Harus berhenti dengan jawaban yang jujur, bukan
  // berputar tanpa akhir dan bukan 500.
  let insert = 0;
  const query = fakeQuery((sql) => {
    const t = String(sql);
    if (/FROM sessions WHERE session_key/.test(t)) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (/INSERT INTO share_links/.test(t)) {
      insert += 1;
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const hasil = await handleCreateShare({ query, sessionKey: "ses_1" });
  assert.ok([409, 503].includes(hasil.status), "jawaban jujur: " + hasil.status);
  assert.ok(insert <= 3, "pengulangan harus dibatasi, bukan tak terbatas");
});

test("penjaga: OPTIONS dari origin asing ditolak, dari origin sah diberi 204", () => {
  const ORIGINS = ["http://localhost:3100"];
  const asing = shareGuard({
    headers: { "x-devwf-share": "1", origin: "https://evil.example" },
    allowedOrigins: ORIGINS,
    method: "OPTIONS",
  });
  assert.equal(asing.ok, false);
  assert.equal(asing.status, 403);

  const sah = shareGuard({
    headers: { "x-devwf-share": "1", origin: "http://localhost:3100" },
    allowedOrigins: ORIGINS,
    method: "OPTIONS",
  });
  assert.equal(sah.ok, true);
  assert.equal(sah.preflight, true, "OPTIONS yang sah dijawab 204, bukan 405");
});
