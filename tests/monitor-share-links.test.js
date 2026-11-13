import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  PUBLIC_ORIGIN, FALLBACK_ORIGIN,
  generateToken, isValidToken, publicUrl, fallbackUrl,
  buildInsertLink, buildLiveLinkQuery, buildRevokeLink,
  buildTokenLookup, buildTouchView, buildLiveSharesQuery, classifyShareLookup, ensureTableSql,
} = require("../monitor-server/share-links.cjs");

test("token 43 karakter base64url dan tidak pernah kembar", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const t = generateToken();
    assert.equal(t.length, 43);
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!seen.has(t), "token kembar berarti generatornya tidak acak");
    seen.add(t);
  }
});

test("validasi token menolak bentuk yang bisa menyusup ke URL", () => {
  assert.equal(isValidToken(generateToken()), true);
  assert.equal(isValidToken(""), false);
  assert.equal(isValidToken("pendek"), false);
  assert.equal(isValidToken("a".repeat(44)), false);
  assert.equal(isValidToken("a".repeat(42)), false);
  assert.equal(isValidToken("a".repeat(42) + "+"), false);
  assert.equal(isValidToken("a".repeat(42) + "/"), false);
  assert.equal(isValidToken("a".repeat(42) + "="), false);
  assert.equal(isValidToken("../etc/passwd"), false);
  assert.equal(isValidToken(null), false);
  assert.equal(isValidToken(undefined), false);
});

test("tautan memakai domain utama, cadangannya subdomain share", () => {
  const token = "A".repeat(43);
  assert.equal(publicUrl(token), PUBLIC_ORIGIN + "/s/" + token);
  assert.equal(publicUrl(token, "https://contoh.test"), "https://contoh.test/s/" + token);
  assert.equal(fallbackUrl(token), FALLBACK_ORIGIN + "/s/" + token);
  assert.ok(!publicUrl(token).endsWith("/"), "jangan ada garis miring di ujung");
  assert.equal(PUBLIC_ORIGIN, "https://devworkflow.programinglive.com");
  assert.equal(FALLBACK_ORIGIN, "https://devwfshare.programinglive.com");
});

test("insert idempoten lewat indeks unik parsial", () => {
  const { sql, params } = buildInsertLink({ token: "t", sessionKey: "ses_1" });
  assert.match(sql, /INSERT INTO share_links/);
  assert.match(sql, /ON CONFLICT \(session_key\) WHERE revoked_at IS NULL DO NOTHING/);
  assert.match(sql, /RETURNING token/);
  assert.deepEqual(params, ["t", "ses_1"]);
});

test("insert menolak sessionKey kosong sebelum menyentuh database", () => {
  assert.throws(() => buildInsertLink({ token: "t", sessionKey: "" }), /sessionKey/);
  assert.throws(() => buildInsertLink({ token: "", sessionKey: "ses_1" }), /token/);
  assert.throws(() => buildInsertLink({ token: "t", sessionKey: "   " }), /sessionKey/);
});

test("pencarian token memakai LEFT JOIN supaya sesi yang hilang bisa dibedakan", () => {
  const { sql, params } = buildTokenLookup({ token: "t" });
  assert.match(sql, /LEFT JOIN sessions/);
  assert.match(sql, /share_links/);
  assert.match(sql, /WHERE l\.token = \$1/);
  assert.match(sql, /live_session_key/);
  assert.deepEqual(params, ["t"]);
});

test("pencabutan hanya menyetel revoked_at, tidak pernah DELETE", () => {
  const { sql } = buildRevokeLink({ token: "t" });
  assert.match(sql, /UPDATE share_links SET revoked_at = now\(\)/);
  assert.match(sql, /revoked_at IS NULL/);
  assert.match(sql, /RETURNING token/);
  assert.ok(!/DELETE/i.test(sql), "baris tidak boleh dihapus");
});

test("kunjungan menambah views tanpa menyentuh tabel sesi", () => {
  const { sql } = buildTouchView({ token: "t" });
  assert.match(sql, /UPDATE share_links/);
  assert.match(sql, /views = views \+ 1/);
  assert.ok(!/sessions/i.test(sql), "membaca tautan tidak boleh mengubah sesi");
});

test("daftar tautan hidup hanya yang belum dicabut", () => {
  const { sql } = buildLiveSharesQuery();
  assert.match(sql, /revoked_at IS NULL/);
  assert.match(sql, /session_key/);
});

test("daftar tautan hidup dibatasi supaya payload poll tidak tumbuh selamanya", () => {
  // Dashboard menyegarkan diri tiap 3 detik dan tautan hidup sampai dicabut.
  assert.match(buildLiveSharesQuery().sql, /LIMIT \$1/);
  assert.deepEqual(buildLiveSharesQuery().params, [200]);
  assert.deepEqual(buildLiveSharesQuery({ limit: 5 }).params, [5]);
  assert.deepEqual(buildLiveSharesQuery({ limit: 5000 }).params, [1000], "dibatasi atas");
  assert.deepEqual(buildLiveSharesQuery({ limit: 0 }).params, [200], "nol jatuh ke bawaan");
});

test("daftar per sesi memakai parameter, bukan tempelan", () => {
  const { sql, params } = buildLiveLinkQuery({ sessionKey: "ses_1" });
  assert.match(sql, /WHERE session_key = \$1/);
  assert.match(sql, /revoked_at IS NULL/);
  assert.deepEqual(params, ["ses_1"]);
});

test("kode status membedakan salah ketik, dicabut, dan sesi yang sudah dibuang", () => {
  assert.deepEqual(classifyShareLookup(null), { status: 404, reason: "unknown" });
  assert.deepEqual(classifyShareLookup({ revoked_at: new Date() }), { status: 410, reason: "revoked" });
  assert.deepEqual(
    classifyShareLookup({ revoked_at: null, live_session_key: null }),
    { status: 404, reason: "session_gone" },
  );
  assert.deepEqual(
    classifyShareLookup({ revoked_at: null, live_session_key: "ses_1" }),
    { status: 200, reason: "ok" },
  );
});

test("DDL aman dijalankan berulang dan menjaga satu tautan hidup per sesi", () => {
  assert.match(ensureTableSql, /CREATE TABLE IF NOT EXISTS share_links/);
  assert.match(ensureTableSql, /CREATE UNIQUE INDEX IF NOT EXISTS/);
  assert.match(ensureTableSql, /WHERE revoked_at IS NULL/);
  assert.ok(!/DROP|ALTER|DELETE/i.test(ensureTableSql), "tidak boleh menyentuh tabel lama");
});
