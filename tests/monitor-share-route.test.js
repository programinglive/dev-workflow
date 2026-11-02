import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  shareGuard, isOriginAllowed, handleCreateShare, handleRevokeShare,
  handleListShares, listLiveShares, shareErrorStatus,
} = require("../monitor-server/share-route.cjs");

const ORIGINS = ["http://100.107.65.21:3100", "http://localhost:3100"];
const TOKEN = "T".repeat(43);

/** Query palsu: mencatat panggilan dan menjawab dari skrip per pola. */
function fakeQuery(handler) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return handler(String(sql), params) || { rows: [], rowCount: 0 };
  };
  query.calls = calls;
  return query;
}

test("origin asing ditolak, origin dashboard diterima", () => {
  assert.equal(isOriginAllowed("http://100.107.65.21:3100", ORIGINS), true);
  assert.equal(isOriginAllowed("http://localhost:3100", ORIGINS), true);
  assert.equal(isOriginAllowed("https://evil.example", ORIGINS), false);
  assert.equal(isOriginAllowed("http://100.107.65.21:3100.evil.example", ORIGINS), false);
  assert.equal(isOriginAllowed("null", ORIGINS), false);
});

test("origin yang tidak dikirim diterima, tapi header wajib ada", () => {
  // Aplikasi tablet React Native mengirim tanpa Origin. Menolaknya berarti
  // tombol Bagikan di tablet selalu gagal.
  assert.equal(shareGuard({ headers: { "x-devwf-share": "1" }, allowedOrigins: ORIGINS }).ok, true);
  assert.equal(
    shareGuard({ headers: { "x-devwf-share": "1", origin: "https://evil.example" }, allowedOrigins: ORIGINS }).ok,
    false,
  );
  assert.equal(shareGuard({ headers: { origin: "http://localhost:3100" }, allowedOrigins: ORIGINS }).ok, false);
  assert.equal(
    shareGuard({ headers: { "x-devwf-share": "1", origin: "http://localhost:3100" }, allowedOrigins: ORIGINS }).ok,
    true,
  );
  // Header bernilai lain bukan izin.
  assert.equal(shareGuard({ headers: { "x-devwf-share": "true" }, allowedOrigins: ORIGINS }).ok, false);
});

test("membuat tautan untuk sesi yang tidak ada menjawab 404", async () => {
  const query = fakeQuery(() => ({ rows: [], rowCount: 0 }));
  const hasil = await handleCreateShare({ query, sessionKey: "ses_hantu", origin: "http://localhost:3100" });
  assert.equal(hasil.status, 404);
  assert.ok(!query.calls.some((c) => /INSERT INTO share_links/.test(c.sql)), "jangan sisipkan baris yatim");
});

test("sessionKey kosong ditolak 400 tanpa menyentuh database", async () => {
  const query = fakeQuery(() => ({ rows: [], rowCount: 0 }));
  assert.equal((await handleCreateShare({ query, sessionKey: "  " })).status, 400);
  assert.equal(query.calls.length, 0);
});

test("tautan baru dibuat lalu dikembalikan dengan URL publik", async () => {
  const hasil = await handleCreateShare({
    query: fakeQuery((sql) => {
      if (/FROM sessions WHERE session_key/.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (/INSERT INTO share_links/.test(sql)) return { rows: [{ token: TOKEN }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    sessionKey: "ses_1",
  });
  assert.equal(hasil.status, 200);
  assert.equal(hasil.body.token, TOKEN);
  assert.equal(hasil.body.url, "https://devworkflow.programinglive.com/s/" + TOKEN);
  assert.ok(hasil.body.fallbackUrl.includes("devwfshare.programinglive.com"));
});

test("menekan Share dua kali memakai ulang token yang sudah ada", async () => {
  const query = fakeQuery((sql) => {
    if (/FROM sessions WHERE session_key/.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (/INSERT INTO share_links/.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM\s+share_links[\s\S]*WHERE\s+session_key/.test(sql)) {
      return { rows: [{ token: TOKEN, created_at: "2026-11-02T09:00:00.000Z", views: 7 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const hasil = await handleCreateShare({ query, sessionKey: "ses_1" });
  assert.equal(hasil.status, 200);
  assert.equal(hasil.body.token, TOKEN);
  assert.equal(hasil.body.views, 7);
});

test("mencabut tautan melaporkan jumlah baris yang berubah", async () => {
  const query = fakeQuery(() => ({ rows: [{ token: TOKEN }], rowCount: 1 }));
  const hasil = await handleRevokeShare({ query, token: TOKEN });
  assert.equal(hasil.status, 200);
  assert.deepEqual(hasil.body, { ok: true, revoked: 1 });
});

test("mencabut token berbentuk salah ditolak 400 tanpa query", async () => {
  const query = fakeQuery(() => ({ rows: [], rowCount: 1 }));
  assert.equal((await handleRevokeShare({ query, token: "<script>" })).status, 400);
  assert.equal(query.calls.length, 0);
});

test("mencabut token yang sudah dicabut melaporkan 0, bukan error", async () => {
  const hasil = await handleRevokeShare({
    query: fakeQuery(() => ({ rows: [], rowCount: 0 })),
    token: TOKEN,
  });
  assert.equal(hasil.status, 200);
  assert.equal(hasil.body.revoked, 0);
});

test("daftar per sesi mengembalikan tautan hidup atau null", async () => {
  const ada = await handleListShares({
    query: fakeQuery(() => ({ rows: [{ token: TOKEN, views: 2, created_at: "2026-11-02T09:00:00.000Z" }], rowCount: 1 })),
    sessionKey: "ses_1",
  });
  assert.equal(ada.status, 200);
  assert.equal(ada.body.token, TOKEN);

  const tidak = await handleListShares({
    query: fakeQuery(() => ({ rows: [], rowCount: 0 })),
    sessionKey: "ses_2",
  });
  assert.equal(tidak.status, 200);
  assert.equal(tidak.body.url, null);
});

test("daftar semua tautan hidup berbentuk array siap tempel", async () => {
  const rows = await listLiveShares({
    query: fakeQuery(() => ({ rows: [{ session_key: "ses_1", token: TOKEN, views: 3, created_at: "2026-11-02T09:00:00.000Z" }], rowCount: 1 })),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionKey, "ses_1");
  assert.equal(rows[0].url, "https://devworkflow.programinglive.com/s/" + TOKEN);
});

test("tabel yang belum ada dibalas 503, bukan 500", () => {
  assert.equal(shareErrorStatus({ code: "42P01" }), 503);
  assert.equal(shareErrorStatus(new Error('relation "share_links" does not exist')), 503);
  assert.equal(shareErrorStatus(Object.assign(new Error("koneksi putus"), { code: "ECONNREFUSED" })), 500);
  assert.equal(shareErrorStatus(new Error("apa saja")), 500);
});

test("kegagalan database tidak melempar ke pemanggil", async () => {
  const query = async () => {
    throw Object.assign(new Error('relation "share_links" does not exist'), { code: "42P01" });
  };
  const buat = await handleCreateShare({ query, sessionKey: "ses_1" });
  assert.equal(buat.status, 503);
  assert.equal(buat.body.ok, false);

  const cabut = await handleRevokeShare({ query, token: TOKEN });
  assert.equal(cabut.status, 503);

  const daftar = await handleListShares({ query, sessionKey: "ses_1" });
  assert.equal(daftar.status, 503);

  const semua = await listLiveShares({ query });
  assert.deepEqual(semua, [], "daftar yang gagal menjadi array kosong, bukan melempar");
});
