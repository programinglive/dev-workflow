# Session Share Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every session a Share button that produces a permanent, revocable public link on `https://devworkflow.programinglive.com/s/<token>` showing work status without leaking machine, path, project or session identity.

**Architecture:** A second HTTP process (`share-server.cjs`, bind `127.0.0.1:3200`) renders the public page from Postgres, reached through a new Cloudflare Tunnel `devwf-share` and proxied by a Netlify rewrite so the visible URL stays on the main domain. Token creation and revocation happen only on the tailnet-only dashboard port `3100`, guarded by a custom header plus an Origin allowlist.

**Tech Stack:** Node 20+ ESM/CJS, `node:http`, `node:crypto`, `pg`, `node:test`, Postgres 14+, Cloudflare Tunnel, Netlify redirects, Next.js static export, React Native (Expo).

**Spec:** `docs/superpowers/specs/2026-11-02-session-share-design.md`

## Global Constraints

- Node >= 20, no new runtime dependencies. `pg` is the only database client and it is already installed in `/opt/devwf-monitor/node_modules`.
- Pure modules (`share-links.cjs`, `share-page.cjs`, `share-route.cjs`) must never call `fetch`, open sockets, or read `process.env` at import time. Everything they need is an argument.
- The public page must never emit `machine`, `project_path`, `project_name`, `session_key`, `agent_pool`, `owner_pid`. The check runs against rendered HTML, not source.
- Public responses carry `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`.
- `/s/<token>` answers only `GET` and `HEAD`. Every other method gets `405` with `Allow: GET, HEAD`. The share port has no write endpoint at all.
- Token status codes: unknown token `404`; revoked token `410`; valid token whose session row is gone `404`; known table missing `503`.
- Tokens are 32 random bytes from `crypto.randomBytes`, base64url-encoded, 43 characters of `[A-Za-z0-9_-]`.
- One live token per session, enforced by a partial unique index. `POST /api/share` is idempotent.
- No `DELETE` on `share_links` anywhere. Revocation sets `revoked_at`. `PRUNE_ENABLED` must not touch this table.
- **The dashboard page script is inside a JavaScript template literal.** It must not contain `${` — use string concatenation, exactly as the existing page does. A stray template literal there is a syntax error at build time, or worse, silently interpolates a server value.
- One commit at the end via `dev-workflow`'s `commit_and_push` (it runs `git add .`); do not make intermediate commits through the MCP. Intermediate `git add`/`git commit` is forbidden for this repo by `AGENTS.md`.
- Tests must never point at production. `tests/setup-env.js` already clears `DEVWF_MONITOR_URL`; new tests that need Postgres use `DEVWF_TEST_PG` and skip with a visible reason when it is absent.

## Review Focus

1. **A session with every field filled** — the public page must still leak none of the six denied fields. A renderer tested only against a sparse session passes while leaking on a real one.
2. **A task title containing `<script>`, `</title>`, `"` and `&`** — must appear as literal text in both the body and the `<title>`/OG tags. Broken escaping here is stored XSS on a public page.
3. **Revocation** — after `DELETE /api/share`, the same URL must answer `410` on the very next request, with no cache serving the old page.
4. **The dashboard opened over plain `http://100.107.65.21:3100`** — `navigator.share` and `navigator.clipboard` do not exist in that context, so the button must still deliver the link.
5. **The tablet app sends no `Origin` header** — the share guard must allow a missing Origin while still rejecting a foreign one.

---

### Task 1: Share link primitives

**Files:**
- Create: `monitor-server/share-links.cjs`
- Test: `tests/monitor-share-links.test.js`

**Interfaces:**
- Produces:
  - `PUBLIC_ORIGIN = "https://devworkflow.programinglive.com"`
  - `FALLBACK_ORIGIN = "https://share.devworkflow.programinglive.com"`
  - `generateToken(randomBytes?) -> string`
  - `isValidToken(value) -> boolean`
  - `publicUrl(token, origin = PUBLIC_ORIGIN) -> string`
  - `fallbackUrl(token) -> string`
  - `buildInsertLink({ token, sessionKey }) -> { sql, params }`
  - `buildLiveLinkQuery({ sessionKey }) -> { sql, params }`
  - `buildRevokeLink({ token }) -> { sql, params }`
  - `buildTokenLookup({ token }) -> { sql, params }`
  - `buildTouchView({ token }) -> { sql, params }`
  - `buildLiveSharesQuery() -> { sql, params }`
  - `classifyShareLookup(row) -> { status: 200|404|410, reason: "ok"|"unknown"|"revoked"|"session_gone" }`
  - `ensureTableSql` (string)

- [ ] **Step 1: Write the failing test**

Create `tests/monitor-share-links.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  PUBLIC_ORIGIN, FALLBACK_ORIGIN,
  generateToken, isValidToken, publicUrl, fallbackUrl,
  buildInsertLink, buildLiveLinkQuery, buildRevokeLink,
  buildTokenLookup, buildTouchView, classifyShareLookup, ensureTableSql,
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
});

test("pencarian token memakai LEFT JOIN supaya sesi yang hilang bisa dibedakan", () => {
  const { sql, params } = buildTokenLookup({ token: "t" });
  assert.match(sql, /LEFT JOIN sessions/);
  assert.match(sql, /share_links/);
  assert.match(sql, /WHERE l\.token = \$1/);
  assert.deepEqual(params, ["t"]);
});

test("pencabutan hanya menyetel revoked_at, tidak pernah DELETE", () => {
  const { sql } = buildRevokeLink({ token: "t" });
  assert.match(sql, /UPDATE share_links SET revoked_at = now\(\)/);
  assert.match(sql, /revoked_at IS NULL/);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-share-links.test.js`
Expected: FAIL — `Cannot find module '../monitor-server/share-links.cjs'`.

- [ ] **Step 3: Implement `monitor-server/share-links.cjs`**

Export the eleven names listed in Interfaces. Requirements the tests pin exactly:

- `generateToken(randomBytes = crypto.randomBytes)` returns `randomBytes(32).toString("base64url")`.
- `isValidToken` accepts only `/^[A-Za-z0-9_-]{43}$/` against a stringified value.
- `buildInsertLink` throws `new Error("token wajib")` / `new Error("sessionKey wajib")` for empty inputs, and its SQL ends with `ON CONFLICT (session_key) WHERE revoked_at IS NULL DO NOTHING RETURNING token`.
- `buildTokenLookup` selects `l.token, l.session_key, l.created_at, l.revoked_at, l.views, s.session_key AS live_session_key, s.task, s.task_type, s.phase, s.plan_json, s.plan_done, s.plan_total, s.dod_done, s.dod_total, s.dod_waived, s.started_at, s.updated_at, s.session_title` from `share_links l LEFT JOIN sessions s ON s.session_key = l.session_key WHERE l.token = $1`.
- `buildRevokeLink` also returns `RETURNING token` so the caller can count rows.
- `ensureTableSql` is the DDL text from the spec, verbatim.

Write a file header comment explaining why one live token per session matters: a second Share press must not silently kill the link already in someone's WhatsApp.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-share-links.test.js`
Expected: PASS, 11 tests.

---

### Task 2: Public page renderer

**Files:**
- Create: `monitor-server/share-page.cjs`
- Test: `tests/monitor-share-page.test.js`

**Interfaces:**
- Consumes: `formatDuration` from `./history-query.cjs`
- Produces:
  - `PUBLIC_DENY` — frozen array `["machine", "project_path", "project_name", "session_key", "agent_tool", "owner_pid"]`
  - `escapeHtml(value) -> string`
  - `securityHeaders() -> Record<string,string>`
  - `renderSharePage({ share, session, now, origin?, fallbackOrigin? }) -> string`
  - `renderStatusPage({ status, message }) -> string`
  - `shareTitle(session) -> string`

- [ ] **Step 1: Write the failing test**

Create `tests/monitor-share-page.test.js`:

```js
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
});

test("tautan alternatif ditampilkan sebagai jalan kedua", () => {
  const out = html();
  assert.ok(out.includes("share.devworkflow.programinglive.com/s/"));
});

test("halaman tanpa JavaScript", () => {
  const out = html();
  assert.ok(!/<script/i.test(out), "CSP default-src none, jadi skrip tidak akan jalan");
  assert.ok(!/onclick=/i.test(out));
});

test("sesi tanpa rencana dan tanpa waktu mulai tetap dirender jujur", () => {
  const out = html({
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
  assert.equal(shareTitle({ ...SESI, task: "   " }), "Judul", "spasi saja bukan task");
});

test("halaman status untuk 404 dan 410 berbunyi berbeda", () => {
  const hilang = renderStatusPage({ status: 404, message: "Tautan tidak dikenal." });
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-share-page.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `monitor-server/share-page.cjs`**

Rules the tests pin:

- `PUBLIC_DENY` must not appear **as a substring anywhere** in the output, and no field's value may appear. Because of that, never write the literal words in a CSS class, comment, `data-*` attribute or `id`. Name the styles `kartu`, `chip`, `bar`, `daftar` — not `session-key`.
- `shareTitle` order: trimmed `task` → trimmed `session_title` → `"Sesi dev workflow"`.
- Progress strings must contain `done/total` with a slash; write them as `esc(String(done)) + " / " + esc(String(total))`.
- Missing `started_at` renders the words `tidak tercatat`. Do not render `0d`.
- When `plan_total` is 0 or absent, omit the plan progress line entirely (do not print `0/0`).
- `<title>` and `og:title` use `escapeHtml(shareTitle(session))`.
- `og:url` uses `publicUrl`-style origin; accept `origin`/`fallbackOrigin` params defaulting to the exported constants (import them from `./share-links.cjs`).
- `securityHeaders()` returns lowercase keys exactly as asserted.
- No `<script`, no inline event handlers.
- `renderStatusPage` returns a small standalone document with the same security headers applied by the caller.

The page must state plainly that it is a snapshot, with the age of the last report — a static-looking page that is actually stale is the failure mode the spec calls out.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-share-page.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Verify the deny-list test actually bites**

Temporarily add `machine` to the rendered HTML, run the test, confirm it fails with the leak message, then revert. A deny test that cannot fail is decoration.

---

### Task 3: Share route handlers

**Files:**
- Create: `monitor-server/share-route.cjs`
- Test: `tests/monitor-share-route.test.js`

**Interfaces:**
- Consumes: everything from `share-links.cjs`
- Produces:
  - `shareGuard({ headers, allowedOrigins }) -> { ok: boolean, status?: 403, error?: string }`
  - `handleCreateShare({ query, sessionKey, origin }) -> Promise<{ status, body }>`
  - `handleRevokeShare({ query, token }) -> Promise<{ status, body }>`
  - `handleListShares({ query, sessionKey, origin }) -> Promise<{ status, body }>`
  - `listLiveShares({ query, origin }) -> Promise<Array<{ sessionKey, token, url, views, createdAt }>>`
  - `isOriginAllowed(origin, allowedOrigins) -> boolean`
  - `shareErrorStatus(error) -> number`

`query(sql, params)` is injected and returns `{ rows, rowCount }` — that is what `pg` returns, and it lets every test run without a database.

- [ ] **Step 1: Write the failing test**

Create `tests/monitor-share-route.test.js`:

```js
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
  assert.ok(hasil.body.fallbackUrl.includes("share.devworkflow.programinglive.com"));
});

test("menekan Share dua kali memakai ulang token yang sudah ada", async () => {
  const query = fakeQuery((sql) => {
    if (/FROM sessions WHERE session_key/.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (/INSERT INTO share_links/.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM share_links WHERE session_key/.test(sql)) {
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-share-route.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `monitor-server/share-route.cjs`**

Behavior the tests pin:

- `shareGuard` requires header `x-devwf-share` exactly `"1"` **and** `isOriginAllowed` for any Origin that is present. Returns `{ ok: true }` or `{ ok: false, status: 403, error: "forbidden" }`.
- `isOriginAllowed` compares the full origin string, not a prefix. A missing/empty origin is handled by `shareGuard`, not here.
- `handleCreateShare` order: trim and reject empty `sessionKey` (400) → `SELECT 1 FROM sessions WHERE session_key = $1` (404 if empty) → `buildInsertLink` insert → if 0 rows, `buildLiveLinkQuery` → 200 with `{ token, url, fallbackUrl, createdAt, views }`.
- `handleListShares` returns `{ status: 200, body: { url: null } }` when nothing live, otherwise the same shape as create.
- `shareErrorStatus` maps Postgres `42P01` (undefined_table) and messages containing `share_links` + `does not exist` to 503.

Every handler catches its own error and returns `{ status: shareErrorStatus(error), body: { ok: false, error: String(error.message) } }` — never throws to the caller.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-share-route.test.js`
Expected: PASS, 12 tests.

---

### Task 4: Public share server

**Files:**
- Create: `monitor-server/share-server.cjs`
- Test: `tests/monitor-share-server.test.js`

**Interfaces:**
- Consumes: `share-links.cjs`, `share-page.cjs`
- Produces:
  - `createShareServer({ query, allowedOrigins?, now?, rateLimitPerMinute?, enableRateLimit? }) -> http.Server`
  - `routeShare({ pathname, method }) -> { kind: "page", token } | { kind: "health" } | { kind: "method" } | { kind: "missing" }`
  - `main()` when run directly (`PORT`, `DATABASE_URL` from env)

- [ ] **Step 1: Write the failing test**

Create `tests/monitor-share-server.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createShareServer, routeShare } = require("../monitor-server/share-server.cjs");

const TOKEN = "T".repeat(43);
const SESI = {
  live_session_key: "ses_1", task: "Kerjakan", task_type: "feature", phase: "coding",
  plan_json: [{ id: "p1", text: "langkah", status: "open" }],
  plan_done: 0, plan_total: 1, dod_done: 0, dod_total: 2, dod_waived: 0,
  started_at: new Date(Date.now() - 60000).toISOString(),
  updated_at: new Date().toISOString(), session_title: "",
};

function serverWith(row) {
  const query = async (sql, params) => {
    const teks = String(sql);
    if (/FROM share_links l/.test(teks)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (/UPDATE share_links/.test(teks)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return createShareServer({ query, enableRateLimit: false });
}

let server;
let base;

async function start(row) {
  server = serverWith(row);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
}

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test("routing mengenali halaman, health, metode salah, dan path asing", () => {
  assert.deepEqual(routeShare({ pathname: "/s/" + TOKEN, method: "GET" }), { kind: "page", token: TOKEN });
  assert.deepEqual(routeShare({ pathname: "/s/" + TOKEN, method: "HEAD" }), { kind: "page", token: TOKEN });
  assert.deepEqual(routeShare({ pathname: "/s/" + TOKEN, method: "POST" }), { kind: "method" });
  assert.deepEqual(routeShare({ pathname: "/s/" + TOKEN, method: "DELETE" }), { kind: "method" });
  assert.deepEqual(routeShare({ pathname: "/health", method: "GET" }), { kind: "health" });
  assert.deepEqual(routeShare({ pathname: "/", method: "GET" }), { kind: "missing" });
  assert.deepEqual(routeShare({ pathname: "/s/", method: "GET" }), { kind: "missing" });
});

test("token sah menampilkan halaman dan menambah views", async () => {
  await start({ token: TOKEN, session_key: "ses_1", revoked_at: null, views: 1, created_at: new Date().toISOString(), ...SESI });
  const r = await fetch(base + "/s/" + TOKEN);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  const html = await r.text();
  assert.ok(html.includes("Kerjakan"));
  assert.ok(!html.includes("ses_1"), "session_key tidak boleh tampil");
  await new Promise((res) => setTimeout(res, 50));
  await new Promise((r2) => server.close(r2));
});

test("token tidak dikenal menjawab 404", async () => {
  await start(null);
  const r = await fetch(base + "/s/" + TOKEN);
  assert.equal(r.status, 404);
  assert.match(await r.text(), /tidak dikenal/i);
  await new Promise((r2) => server.close(r2));
});

test("token dicabut menjawab 410 dengan kalimat yang berbeda", async () => {
  await start({ token: TOKEN, session_key: "ses_1", revoked_at: new Date().toISOString(), views: 0, ...SESI });
  const r = await fetch(base + "/s/" + TOKEN);
  assert.equal(r.status, 410);
  const html = await r.text();
  assert.match(html, /dicabut/i);
  assert.ok(!/tidak dikenal/i.test(html));
  await new Promise((r2) => server.close(r2));
});

test("sesi yang sudah dibersihkan menjawab 404, bukan 410", async () => {
  // Token sah dan tidak dicabut, tetapi baris sesinya sudah dibuang retensi.
  await start({ ...SESI, live_session_key: null, token: TOKEN, session_key: "ses_1", revoked_at: null, views: 0 });
  const r = await fetch(base + "/s/" + TOKEN);
  assert.equal(r.status, 404);
  await new Promise((r2) => server.close(r2));
});

test("tidak ada cara menulis lewat port share", async () => {
  await start({ token: TOKEN, session_key: "ses_1", revoked_at: null, views: 0, ...SESI });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const r = await fetch(base + "/s/" + TOKEN, { method });
    assert.equal(r.status, 405, method + " harus 405");
    assert.equal(r.headers.get("allow"), "GET, HEAD");
  }
  await new Promise((r2) => server.close(r2));
});

test("HEAD mengembalikan header tanpa badan", async () => {
  await start({ token: TOKEN, session_key: "ses_1", revoked_at: null, views: 0, ...SESI });
  const r = await fetch(base + "/s/" + TOKEN, { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "");
  await new Promise((r2) => server.close(r2));
});

test("health menjawab 200", async () => {
  await start(null);
  const r = await fetch(base + "/health");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  await new Promise((r2) => server.close(r2));
});

test("kegagalan database menjadi 503 dengan pesan yang menyebut sebabnya", async () => {
  const query = async () => {
    throw Object.assign(new Error('relation "share_links" does not exist'), { code: "42P01" });
  };
  const s = createShareServer({ query, enableRateLimit: false });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const r = await fetch("http://127.0.0.1:" + s.address().port + "/s/" + TOKEN);
  assert.equal(r.status, 503);
  assert.match(await r.text(), /share_links|belum/i);
  await new Promise((r2) => s.close(r2));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-share-server.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `monitor-server/share-server.cjs`**

Requirements:

- `routeShare` is pure string matching: `/s/<token>` where token passes `isValidToken` → `page`; `/s/` or a token failing validation → `missing`; `/health` → `health`; a valid page path with a method other than GET/HEAD → `method`; anything else → `missing`.
- Order matters: check the method **after** confirming the path looks like a page, so a POST to an unknown path is `missing`, not `method`. The test asserts `POST /s/<valid>` → 405 only.
- `createShareServer` binds nothing on construction; the caller calls `listen`, which the tests do.
- On a valid GET: `buildTokenLookup` → `classifyShareLookup` → `renderSharePage`, then fire-and-forget `buildTouchView`. Do not `await` the touch before responding, and do not let a rejection escape — attach `.catch(() => {})`.
- `HEAD` renders nothing: send the same status and headers, then `end()`.
- Rate limit: in-memory `Map` keyed by `socket.remoteAddress`, fixed window of 60s. Over the limit → `429` with `Retry-After: 60`. `enableRateLimit: false` disables it for tests. Clean stale keys when the map exceeds 1000 entries so a long-running process cannot grow unbounded.
- `main()` reads `PORT` (default 3200), `HOST` (default `127.0.0.1`), `DATABASE_URL`, optional `DEVWF_SHARE_ORIGINS` (comma-separated, appended to the two default dashboard origins). It prints the DDL and a clear message when `DATABASE_URL` is missing, then exits non-zero — a share server without a database can only serve 503s, and failing loudly beats serving nothing.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-share-server.test.js`
Expected: PASS, 9 tests.

---

### Task 5: Dashboard endpoints

**Files:**
- Modify: `monitor-server/dashboard.cjs` (query section near line 283, `/api/sessions` handler near line 398, request dispatch near line 369, startup near line 511)
- Test: `tests/monitor-share-wiring.test.js`

**Interfaces:**
- Consumes: `share-route.cjs`
- Produces: `/api/share` on port 3100 accepting `POST`, `DELETE`, `GET`, and `shares` array in the `/api/sessions` payload.

- [ ] **Step 1: Write the failing test**

Create `tests/monitor-share-wiring.test.js`. This test reads the source, because importing `dashboard.cjs` starts a server:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");

test("dashboard memakai modul share, bukan menyalin logikanya", () => {
  assert.match(src, /require\('\.\/share-route\.cjs'\)/);
  assert.match(src, /require\('\.\/share-links\.cjs'\)/);
});

test("tiga metode share terpasang di jalur /api/share", () => {
  assert.match(src, /url\.pathname === '\/api\/share'/);
  assert.match(src, /'POST'/);
  assert.match(src, /'DELETE'/);
  assert.match(src, /shareGuard\(/);
});

test("guard berjalan sebelum handler mana pun", () => {
  const idxGuard = src.indexOf("shareGuard(");
  const idxCreate = src.indexOf("handleCreateShare(");
  assert.ok(idxGuard > 0 && idxCreate > idxGuard, "guard harus dipanggil lebih dulu");
});

test("respons sesi membawa daftar tautan hidup", () => {
  assert.match(src, /shares:/);
  assert.match(src, /listLiveShares\(/);
});

test("kegagalan tabel share tidak menjatuhkan dashboard", () => {
  // Query daftar share harus berada di try sendiri, sehingga dashboard tetap
  // menjawab /api/sessions walau share_links belum ada.
  const idx = src.indexOf("listLiveShares(");
  const sekitar = src.slice(Math.max(0, idx - 600), idx + 200);
  assert.match(sekitar, /catch/);
});

test("kode halaman dashboard tidak memakai template literal di dalam template literal", () => {
  // Halaman ini adalah template literal. Satu `${` di dalamnya akan
  // diinterpolasi server dan merusak skrip klien.
  const mulai = src.indexOf("const PAGE = `");
  const akhir = src.indexOf("</html>`", mulai);
  const halaman = src.slice(mulai, akhir);
  const terlarang = halaman.match(/\$\{(?!POLL_MS\})/g) || [];
  assert.deepEqual(terlarang, [], "hanya ${POLL_MS} yang boleh diinterpolasi");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-share-wiring.test.js`
Expected: FAIL on the first assertion.

- [ ] **Step 3: Wire the endpoints into `monitor-server/dashboard.cjs`**

Add at the top with the other requires:

```js
const { shareGuard, handleCreateShare, handleRevokeShare, handleListShares, listLiveShares } = require('./share-route.cjs');
const { ensureTableSql } = require('./share-links.cjs');
```

Add a constant next to `WRITE_TOKEN`:

```js
const SHARE_ORIGINS = String(process.env.DEVWF_SHARE_ORIGINS || 'http://100.107.65.21:3100,http://localhost:3100')
  .split(',').map((s) => s.trim()).filter(Boolean);
```

In the dispatcher, **before** the existing `/api/session` block, add a branch for `url.pathname === '/api/share'` that:

1. `if (!shareGuard({ headers: req.headers, allowedOrigins: SHARE_ORIGINS }).ok)` → 403 JSON `{ ok: false, error: 'forbidden', hint: 'Kirim header X-Devwf-Share: 1 dari origin dashboard.' }`.
2. `POST` → `JSON.parse(await readBody(req))` → `handleCreateShare({ query, sessionKey: body.sessionKey })`.
3. `DELETE` → `handleRevokeShare({ query, token: url.searchParams.get('token') })`.
4. `GET` → `handleListShares({ query, sessionKey: url.searchParams.get('sessionKey') })`.
5. Anything else → 405.
6. Write `hasil.status` and `JSON.stringify(hasil.body)`.

Inside the `/api/sessions` handler, after `summary` is computed, add:

```js
let shares = [];
try {
  shares = await listLiveShares({ query });
} catch (error) {
  // Tabel share_links belum ada (deploy lama) - dashboard tetap harus jalan.
  console.error('daftar share gagal:', String(error && error.message || error));
}
```

and include `shares` in the response object.

At startup, after the `server.listen` callback logs, add a fire-and-forget `ensureShareTable()` that runs `query(ensureTableSql)` and on failure logs the DDL to stderr with the instruction to run it manually. Never `await` it in the listen callback and never let it throw.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-share-wiring.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the dashboard still boots and serves**

Run: `node monitor-server/dashboard.cjs` with `DATABASE_URL` unset.
Expected: it starts, logs the "PRUNE mati" line, and `/health` answers 200 — the share table failure must be logged, not fatal.

---

### Task 6: Dashboard Share button

**Files:**
- Modify: `monitor-server/dashboard.cjs` (the `PAGE` template: `<style>`, card rendering in `render()`, and two helpers before `render`)

- [ ] **Step 1: Add the client helpers**

Inside the `PAGE` script, before `render(data)`, add these with **string concatenation only**:

- `function shareUrlFor(session)` — looks up `data.shares` (pass it in, do not rely on a global).
- `async function salinTeks(teks)` — the four-step ladder: `navigator.share` → `navigator.clipboard.writeText` → `document.execCommand('copy')` via a temporary `<textarea>` → returns `'gagal'` so the caller can show the manual box.
- `async function mintaTautan(sessionKey)` — `POST /api/share` with `headers: { 'content-type': 'application/json', 'x-devwf-share': '1' }`, returns the parsed body or throws with the server's message.
- `async function cabutTautan(token)` — `DELETE /api/share?token=<token>` with the same header.
- `function kotakSalinManual(url)` — returns markup for a `<textarea readonly>` pre-selected plus the text "salin manual", used only when every copy path failed.

- [ ] **Step 2: Render the button on each card**

In the card markup, after the DoD line, append a row:

- If the session has no live share: `<button class="btn" data-share="<escaped session_key>">Bagikan</button>`.
- If it has one: `<button class="btn" data-copy="<url>">Salin tautan</button>` and `<button class="btn danger" data-revoke="<token>">Cabut</button>`, plus `<span class="meta">dibuka <N>×</span>`.

Add CSS classes `.btn`, `.btn.danger`, `.btn:active`, and `.salin` inside the existing `<style>` block. Keep them visually consistent with the existing dark palette.

- [ ] **Step 3: Wire the handlers**

Use one delegated listener on `document.getElementById('list')` after the initial `render` call:

```js
document.getElementById('list').addEventListener('click', function (e) {
  var t = e.target.closest('[data-share],[data-copy],[data-revoke]');
  if (!t) return;
  if (t.dataset.share) { void tombolBagikan(t.dataset.share, t); }
  else if (t.dataset.copy) { void tombolSalin(t.dataset.copy, t); }
  else if (t.dataset.revoke) { void tombolCabut(t.dataset.revoke, t); }
});
```

Each of the three sets `t.disabled = true`, shows "menyiapkan…", performs the action, then calls `tick()` so the card repaints from the server rather than from local guesswork.

- [ ] **Step 4: Verify by hand in a browser**

Run `node monitor-server/dashboard.cjs` with a `DATABASE_URL` pointing at a local Postgres, open `http://localhost:3100`, and confirm: the button exists on a card, clicking it produces a URL starting with `https://devworkflow.programinglive.com/s/`, and a second click offers "Salin tautan" + "Cabut" instead of "Bagikan".

If no local Postgres is available, verify against the deployed one after Task 8 and record the result there — do not claim this step passed without a click.

---

### Task 7: Tablet Share button

**Files:**
- Modify: `mobile-app/App.js` (imports near line 1, `DetailSesi` near line 599, `gaya` near line 800)

- [ ] **Step 1: Import `Share` and add state**

Add `Share` to the `react-native` import list. In `DetailSesi`, add `const [tautan, setTautan] = useState(null)` and `const [galatBagikan, setGalatBagikan] = useState(null)`.

- [ ] **Step 2: Add the request**

```js
async function mintaTautan(sessionKey) {
  const r = await fetch(MONITOR_URL + "/api/share", {
    method: "POST",
    headers: { "content-type": "application/json", "x-devwf-share": "1" },
    body: JSON.stringify({ sessionKey }),
  });
  if (!r.ok) throw new Error("server menjawab " + r.status);
  return r.json();
}
```

Note in a comment that React Native sends **no** `Origin` header, and that is why the guard allows a missing one — the header is the guard, not the origin.

- [ ] **Step 3: Add the button**

Below the timer line in `DetailSesi`, add a `Pressable` labelled **Bagikan** that calls `mintaTautan(s.session_key)` then `Share.share({ message: hasil.url + "\n" + (s.task || s.project_name || "Sesi dev workflow"), url: hasil.url })`. On failure, render `galatBagikan` in yellow with the server's message. After success, render the URL as `<Text selectable>` so it can be long-pressed and copied.

Add `tombolBagikan` and `tautanTeks` to `gaya`.

- [ ] **Step 4: Verify it compiles**

Run: `npx expo export --platform android` in `mobile-app/`, or if unavailable, `node --check` cannot parse JSX — instead run `npx tsc --noEmit` if a tsconfig exists, otherwise confirm by `npx expo start --no-dev` reaching "Bundled" without a red screen.

Record which command you ran and its output. Do not claim the button works on a device unless it was tapped.

---

### Task 8: Public site route

**Files:**
- Create: `web/app/share/page.tsx`
- Modify: `web/netlify.toml`
- Test: `tests/web-share-route.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function config() {
  const raw = await readFile(path.join(ROOT, "web", "netlify.toml"), "utf8");
  return raw.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n");
}

test("tautan /s/* diteruskan ke server share", async () => {
  const c = await config();
  assert.match(c, /from\s*=\s*"\/s\/\*"/);
  assert.match(c, /to\s*=\s*"https:\/\/share\.devworkflow\.programinglive\.com\/s\/:splat"/);
  assert.match(c, /status\s*=\s*200/);
  assert.match(c, /force\s*=\s*true/);
});

test("rewrite share berada SEBELUM catch-all 404", async () => {
  const c = await config();
  const iShare = c.indexOf("/s/*");
  const iCatch = c.indexOf("/*");
  assert.ok(iShare > 0 && iCatch > iShare, "catch-all harus di bawah, atau semua tautan share jadi 404");
  assert.match(c.slice(iCatch), /to\s*=\s*"\/404\.html"/);
});

test("halaman penjelasan ada di /share, bukan /s", async () => {
  const page = await readFile(path.join(ROOT, "web", "app", "share", "page.tsx"), "utf8");
  assert.ok(page.length > 200);
  assert.ok(!/\bsession_key\b|\bmachine\b/.test(page), "halaman statis tidak boleh mengklaim data sesi");
});

test("halaman penjelasan tidak menjanjikan sesuatu yang bisa basi", async () => {
  const page = await readFile(path.join(ROOT, "web", "app", "share", "page.tsx"), "utf8");
  // Halaman statis tidak bisa tahu kondisi server. Kalimat seperti "server
  // sedang aktif" akan berbohong begitu prosesnya mati.
  assert.ok(!/sedang aktif|is running|online now/i.test(page));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/web-share-route.test.js`
Expected: FAIL — `web/app/share/page.tsx` missing.

- [ ] **Step 3: Write `web/app/share/page.tsx`**

A short static page in the site's existing Tailwind style: heading, two sentences explaining that a share link opens a read-only snapshot of a work session, a bullet list of what it shows (task, phase, plan progress, DoD progress, time) and what it explicitly does not show (machine, project path, project name, session id), and a `Link` back to `/`. Import nothing that reads data. Do not state server status.

- [ ] **Step 4: Add the rewrite to `web/netlify.toml`**

Insert the `[[redirects]]` block **above** the existing catch-all, keeping the existing comment about the 404 catch-all intact and adding a comment explaining why `force = true` and why order matters.

- [ ] **Step 5: Run the tests**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/web-share-route.test.js tests/web-static-site.test.js`
Expected: PASS both — the new rewrite must not break the existing 404 invariants.

- [ ] **Step 6: Build the site**

Run: `npm run build:web`
Expected: completes and writes `web/out/share/index.html`.

---

### Task 9: Deploy and verify

**Files:**
- Create: `monitor-server/devwf-share.service`
- Create: `monitor-server/share-tunnel.yml`
- Modify: `monitor-server/devwf-monitor.env.example` (document `DEVWF_SHARE_ORIGINS`)

- [ ] **Step 1: Write the unit and tunnel config**

`devwf-share.service`: `Type=simple`, `WorkingDirectory=/opt/devwf-monitor`, `EnvironmentFile=/etc/devwf-monitor.env`, `Environment=PORT=3200`, `Environment=HOST=127.0.0.1`, `ExecStart=/usr/bin/env node /opt/devwf-monitor/share-server.cjs`, `Restart=always`, `NoNewPrivileges=true`, `PrivateTmp=true`.

`share-tunnel.yml`: `tunnel: devwf-share`, `credentials-file: /etc/cloudflared/devwf-share.json`, and an ingress rule mapping `share.devworkflow.programinglive.com` → `http://127.0.0.1:3200` with a final `- service: http_status:404`.

- [ ] **Step 2: Copy files and start the service**

```bash
scp monitor-server/share-links.cjs monitor-server/share-page.cjs monitor-server/share-route.cjs monitor-server/share-server.cjs monitor-server/dashboard.cjs root@100.107.65.21:/tmp/
ssh root@100.107.65.21
install -m 644 /tmp/share-links.cjs /tmp/share-page.cjs /tmp/share-route.cjs /tmp/share-server.cjs /tmp/dashboard.cjs /opt/devwf-monitor/
install -m 644 /tmp/devwf-share.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now devwf-share
systemctl restart devwf-monitor
curl -s http://127.0.0.1:3200/health
curl -s http://100.107.65.21:3100/health
```

Expected: both health checks answer `{"ok":true,...}`.

- [ ] **Step 3: Create the tunnel**

Create `devwf-share` through the Cloudflare API on the account that holds the zone (`1d5f4382cc0a8f3ba2c6834c2841b4e0` — the other account is not in this session's scope). Write the returned credentials JSON to `/etc/cloudflared/devwf-share.json` with mode `600`, install `cloudflared`, copy `share-tunnel.yml` to `/etc/cloudflared/config.yml`, and enable the tunnel service.

Expected: `cloudflared tunnel info devwf-share` shows one healthy connector.

- [ ] **Step 4: Create the DNS record**

CNAME `share.devworkflow.programinglive.com` → `<tunnel-id>.cfargotunnel.com`, **proxied ON**. Verify with `Resolve-DnsName` and `curl -I https://share.devworkflow.programinglive.com/health`.

Expected: `200` and `{"ok":true}`.

- [ ] **Step 5: Deploy the site**

Commit and push so `.github/workflows/deploy-web.yml` publishes the new redirect, then verify `curl -sI https://devworkflow.programinglive.com/share/` returns 200.

- [ ] **Step 6: Verify end to end from outside the tailnet**

Create a share through the dashboard, then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://devworkflow.programinglive.com/s/<token>   # 200
curl -s https://devworkflow.programinglive.com/s/<token> | grep -c -E 'machine|project_path|project_name|session_key|agent_tool'  # 0
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE 'http://100.107.65.21:3100/api/share?token=<token>' -H 'X-Devwf-Share: 1'  # 200
curl -s -o /dev/null -w '%{http_code}\n' https://devworkflow.programinglive.com/s/<token>   # 410
```

Record the four outputs verbatim. This is the evidence for the definition of done; without it the deploy is not proven.

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/monitor-dashboard.md`
- Modify: `CHANGELOG.md` (via the release tooling, not by hand)

- [ ] **Step 1: README — add a repository map**

Add a "What lives where" table near the top listing each top-level area and its single responsibility: `index.js` (MCP tool registration), `workflow-state.js` (state machine and persistence), `db/` (adapters), `monitor.js` (fire-and-forget reporting), `monitor-server/` (dashboard + share server), `web/` (static marketing site), `mobile-app/` (tablet client), `security/`, `tests/`. One line each. The owner asked for this explicitly: the README should be the map, so nobody has to reconstruct it.

- [ ] **Step 2: README — add "Sharing a session"**

Explain: the Share button produces a permanent link on the main domain; what the public page shows and does not show; how to revoke; that the link is unauthenticated by design and anyone holding it can read it; and that `PRUNE_ENABLED` never deletes share rows. Link to `docs/monitor-dashboard.md` for the deploy steps.

- [ ] **Step 3: `docs/monitor-dashboard.md`**

Extend the file table with the four new modules and their responsibilities, add the three `/api/share` endpoints with their guard rules, document `DEVWF_SHARE_ORIGINS`, add the deploy sequence (service → tunnel → DNS → Netlify rewrite), and add a "kenapa begitu" section covering: why the share server is a separate process, why `127.0.0.1` and not `0.0.0.0`, why 410 differs from 404, and why the dashboard script cannot use template literals.

- [ ] **Step 4: Update infra knowledge**

In `D:\code\infra-knowledge-mcp-server`, add the `share.devworkflow.programinglive.com` domain entry and a `devwf-share` service entry, bump both files' `updated:` to today, run `npm test` there, and stage only the two files you changed. That repo is shared with other sessions — never `git add .` there.

---

## Verification

Before claiming completion:

1. `npm test` — full suite green, including the eleven existing `monitor-share-*` neighbours.
2. `npm run build:web` — succeeds, `web/out/share/index.html` exists.
3. The four `curl` outputs from Task 9 Step 6, pasted verbatim.
4. Dashboard button clicked in a real browser; tablet button tapped on a real device, or explicitly reported as untested.
5. `git status` clean except intended files.
