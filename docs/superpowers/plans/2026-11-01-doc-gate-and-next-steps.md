# Gerbang Dokumentasi, Rekomendasi Pekerjaan Selanjutnya, dan Pemeriksaan Update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dev-workflow MCP berhenti menerima klaim dokumentasi tanpa bukti berkas, meninggalkan daftar tindak lanjut yang bisa ditunjuk sumbernya setiap kali task selesai, dan bisa menjawab apakah versinya sudah ketinggalan.

**Architecture:** Aturan gerbang dan aturan rekomendasi adalah fungsi murni di modul baru (`docs.js`, `next-steps.js`) tanpa MCP dan tanpa filesystem, mengikuti pola `dod.js`. Handler hanya mengumpulkan input dari git, memanggil fungsi murni, mengubah state, lalu menyimpan. Satu baris baru di `handleReadyCheck` cukup untuk memblokir commit juga, karena `commit_and_push` sudah memanggil ready check saat belum siap.

**Tech Stack:** Node.js ESM, MCP SDK, `node:test` + `node:assert/strict`. Tanpa dependency baru.

**Spec:** `docs/superpowers/specs/2026-11-01-doc-gate-and-next-steps-design.md`

## Global Constraints

- Repo: `D:\code\dev-workflow-mcp-server`, branch `main`, versi awal `1.15.1`.
- Baseline tes sebelum perubahan: `npm test` → **563 tes, 560 pass, 3 skipped, 0 fail**.
- Perintah tes satu berkas: `node --no-deprecation --import ./tests/setup-env.js --test <path>`.
- `MIN_WAIVER_REASON = 5`, `MAX_WAIVER_REASON = 500`.
- `nextSteps`: maksimal 5 butir, tiap butir 10–200 karakter. Array kosong = tidak dikirim.
- Rekomendasi: maksimal 6 butir, urut `high` → `medium` → `low`, duplikat dibuang berdasarkan judul.
- Status gerbang hanya: `"ok" | "needs-docs" | "waived" | "no-docs" | "unknown"`.
- Respons sukses `create_documentation` **wajib dimulai `✅`**; `isErrorResponse` (`tools/handler-modules/shared.js:27`) memperlakukan awalan `⚠️` sebagai kegagalan.
- Pesan galat berbahasa Indonesia, menyebut aturan, nilai bermasalah, dan panggilan berikutnya.
- **Satu commit saja, di akhir.** Repo ini mewajibkan commit lewat `commit_and_push` setelah `npm test` hijau dan DoD terbukti, dan tool itu menolak selama masih ada langkah terbuka. Karena itu setiap task di bawah berakhir dengan "jalankan tes fokus", bukan `git commit`. Jangan memakai `git add .` atau `git commit` manual.
- Rilis akhir: `1.16.0` (minor) lewat `npm run release:minor`.
- Jangan menambah dependency.
- Setiap berkas tes baru mendefinisikan dua helper ini di bagian atas, karena dipakai di banyak tes:

```js
const text = (response) => response.content[0].text;
const ctx = ({ status = "", toplevel = REPO_DIR, failToplevel = false } = {}) => ({
  git: {
    getStatusOutput: async () => status,
    parseStatusEntries,
    getToplevel: async () => { if (failToplevel) throw new Error("bukan repo"); return toplevel; },
    getLastCommitForPath: async () => "2026-10-18T00:00:00Z",
  },
});
```

`REPO_DIR` adalah direktori repo sementara yang dibuat per tes dengan `mkdtemp` dan berisi `README.md`.

## Review Focus

- **Repo tanpa README dan tanpa `docs/`.** Ekspektasi: gerbang `no-docs`, ready check lolos, dan tidak ada pesan galat — repo yang dokumentasinya di tempat lain tidak boleh dihukum.
- **README sudah kotor sebelum `start_task`.** Ekspektasi: tidak dihitung sebagai bukti task ini; bila agen menyebutnya di `files[]`, barulah dihitung. Pekerjaan sesi lain tidak boleh tampak seperti milik kita.
- **Berkas dokumentasi dihapus (`D README.md`).** Ekspektasi: dihitung sebagai perubahan dokumentasi sehingga gerbang lolos, karena penghapusan memang mengubah dokumentasi; tidak ada jalur khusus yang membuatnya crash.
- **`complete_task` tanpa `nextSteps`.** Ekspektasi: blok fakta tetap tampil, ditambah satu baris yang meminta saran, dan task tetap bisa ditutup — bukan galat, bukan blok kosong.
- **History dari versi lama tanpa field `recommendations`.** Ekspektasi: `next_steps` menyebut belum ada rekomendasi tersimpan dan menampilkan ringkasan proyek, bukan `undefined` atau crash.

---

### Task 1: Modul murni `docs.js`

**Files:**
- Create: `tools/handler-modules/docs.js`
- Test: `tests/docs-gate.test.js`

**Interfaces:**
- Produces:
  - `MIN_WAIVER_REASON = 5`, `MAX_WAIVER_REASON = 500`
  - `normalizePath(p) -> string` — pemisah `/`, buang `./` di depan, buang spasi tepi
  - `isDocumentationPath(p) -> boolean`
  - `isSourcePath(p) -> boolean`
  - `isGateSatisfied(status) -> boolean` — benar untuk `ok`, `waived`, `no-docs`, `unknown`
  - `evaluateDocGate({ changedPaths, dirtyAtStart, declaredFiles, hasDocumentation, waived }) -> { status, sourceChanged, docsTouched }`
  - `formatRelativeAge(iso, now = new Date()) -> string` — `"hari ini"`, `"1 hari lalu"`, `"14 hari lalu"`, `""` bila `iso` kosong/tidak valid
  - `renderDocGateFailure({ sourceChanged, readmePath, readmeAge, legacy }) -> string`

- [ ] **Step 1: Tulis tes yang gagal** — `tests/docs-gate.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDocumentationPath, isSourcePath, evaluateDocGate, formatRelativeAge, renderDocGateFailure, isGateSatisfied } from "../tools/handler-modules/docs.js";

test("isDocumentationPath mengenali berkas dokumentasi", () => {
  for (const p of ["README.md", "readme", "src/README.md", "CHANGELOG.md", "CONTRIBUTING.md", "docs/guide/any.txt", "doc/api.yaml", "notes/design.mdx"]) {
    assert.equal(isDocumentationPath(p), true, p);
  }
});

test("isDocumentationPath menolak non-dokumentasi dan fixture tes", () => {
  for (const p of ["src/app.js", "package.json", "tests/fixtures/sample.md", "test/data/readme.md"]) {
    assert.equal(isDocumentationPath(p), false, p);
  }
});

test("isSourcePath mengenali source dan menolak config/tes/lockfile", () => {
  for (const p of ["src/app.js", "src/View.vue", "app/Http/Controllers/Foo.php", "cmd/main.go"]) {
    assert.equal(isSourcePath(p), true, p);
  }
  for (const p of ["src/app.test.js", "tests/helper.js", "node_modules/x/index.js", "package-lock.json", "README.md", "docker-compose.yml", ".github/workflows/ci.yml"]) {
    assert.equal(isSourcePath(p), false, p);
  }
});

test("evaluateDocGate: hanya source berubah tanpa doc -> needs-docs", () => {
  const r = evaluateDocGate({ changedPaths: ["src/a.js"], dirtyAtStart: [], declaredFiles: [], hasDocumentation: true, waived: false });
  assert.equal(r.status, "needs-docs");
  assert.deepEqual(r.sourceChanged, ["src/a.js"]);
});

test("evaluateDocGate: source dan doc berubah -> ok", () => {
  const r = evaluateDocGate({ changedPaths: ["src/a.js", "README.md"], dirtyAtStart: [], declaredFiles: [], hasDocumentation: true, waived: false });
  assert.equal(r.status, "ok");
});

test("evaluateDocGate: doc yang sudah kotor sejak awal tidak dihitung", () => {
  const r = evaluateDocGate({ changedPaths: ["src/a.js", "README.md"], dirtyAtStart: [{ path: "README.md" }], declaredFiles: [], hasDocumentation: true, waived: false });
  assert.equal(r.status, "needs-docs");
});

test("evaluateDocGate: doc kotor sejak awal yang disebut eksplisit dihitung", () => {
  const r = evaluateDocGate({ changedPaths: ["src/a.js", "README.md"], dirtyAtStart: [{ path: "README.md" }], declaredFiles: ["README.md"], hasDocumentation: true, waived: false });
  assert.equal(r.status, "ok");
});

test("evaluateDocGate: doc dihapus tetap dihitung sebagai perubahan dokumentasi", () => {
  const r = evaluateDocGate({ changedPaths: ["src/a.js", "README.md"], dirtyAtStart: [], declaredFiles: [], hasDocumentation: true, waived: false });
  assert.equal(r.status, "ok");
});

test("evaluateDocGate: tanpa dokumentasi di repo -> no-docs", () => {
  const r = evaluateDocGate({ changedPaths: ["src/a.js"], dirtyAtStart: [], declaredFiles: [], hasDocumentation: false, waived: false });
  assert.equal(r.status, "no-docs");
});

test("evaluateDocGate: waiver menang atas segalanya", () => {
  const r = evaluateDocGate({ changedPaths: ["src/a.js"], dirtyAtStart: [], declaredFiles: [], hasDocumentation: false, waived: true });
  assert.equal(r.status, "waived");
});

test("evaluateDocGate: hanya config/tes/lockfile berubah -> ok", () => {
  for (const changed of [["package.json"], ["src/a.test.js"], ["package-lock.json"], [".github/workflows/ci.yml"]]) {
    const r = evaluateDocGate({ changedPaths: changed, dirtyAtStart: [], declaredFiles: [], hasDocumentation: true, waived: false });
    assert.equal(r.status, "ok", changed.join(","));
  }
});

test("evaluateDocGate: tanpa perubahan sama sekali -> ok", () => {
  const r = evaluateDocGate({ changedPaths: [], dirtyAtStart: [], declaredFiles: [], hasDocumentation: true, waived: false });
  assert.equal(r.status, "ok");
});

test("formatRelativeAge menghitung hari", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  assert.equal(formatRelativeAge("2026-11-01T00:00:00Z", now), "hari ini");
  assert.equal(formatRelativeAge("2026-10-31T00:00:00Z", now), "1 hari lalu");
  assert.equal(formatRelativeAge("2026-10-18T00:00:00Z", now), "14 hari lalu");
  assert.equal(formatRelativeAge("", now), "");
});

test("renderDocGateFailure menyebut berkas, README, dan dua jalan keluar", () => {
  const text = renderDocGateFailure({ sourceChanged: ["src/a.js", "src/b.js"], readmePath: "README.md", readmeAge: "14 hari lalu", legacy: false });
  assert.match(text, /2 berkas source berubah/);
  assert.match(text, /src\/a\.js/);
  assert.match(text, /README\.md — commit terakhir 14 hari lalu/);
  assert.match(text, /create_documentation/);
  assert.match(text, /waive_documentation/);
  assert.match(text, /Tidak ada yang di-commit/);
});

test("isGateSatisfied", () => {
  for (const s of ["ok", "waived", "no-docs", "unknown"]) assert.equal(isGateSatisfied(s), true, s);
  assert.equal(isGateSatisfied("needs-docs"), false);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/docs-gate.test.js`
Expected: FAIL — `Cannot find module .../tools/handler-modules/docs.js`

- [ ] **Step 3: Implementasi `docs.js`**

Aturan klasifikasi mengikuti spec. Dua detail yang menentukan:

- `isDocumentationPath` mengembalikan `false` lebih dulu bila `isTestPath` benar, sehingga `.md` di `tests/` tidak lolos. `isTestPath` adalah regex yang sama dengan `isTestFilePath` di `git-helpers.js:56` — salin regexnya, jangan impor, karena `git-helpers.js` memanggil `exec`.
- `evaluateDocGate` menghitung `sourceChanged` dari `changedPaths` yang bukan anggota `dirtyAtStart` (dibandingkan lewat `normalizePath`), lalu `docsTouched` dari gabungan himpunan yang sama ditambah `declaredFiles ∩ changedPaths ∩ isDocumentationPath`.

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/docs-gate.test.js`
Expected: PASS, 15 tes.

### Task 2: Field state baru

**Files:**
- Modify: `workflow-state.js` — tiga literal state (constructor, `useSession`, `reset`) dan normalisasi di `load()`
- Test: `tests/docs-gate-state.test.js`

**Interfaces:**
- Produces pada `workflowState.state`: `documentationFiles: string[]`, `documentationWaived: boolean`, `documentationWaiverReason: string`, `lastCommitSha: string`

- [ ] **Step 1: Tulis tes yang gagal** — `tests/docs-gate-state.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowState } from "../workflow-state.js";

test("state segar punya field gerbang dokumentasi dengan default", () => {
  const s = new WorkflowState(path.join(tmpdir(), "unused-state.json"));
  assert.deepEqual(s.state.documentationFiles, []);
  assert.equal(s.state.documentationWaived, false);
  assert.equal(s.state.documentationWaiverReason, "");
  assert.equal(s.state.lastCommitSha, "");
});

test("reset mengosongkan field gerbang dokumentasi", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-"));
  try {
    const s = new WorkflowState(path.join(dir, "state.json"));
    s.state.documentationFiles = ["README.md"];
    s.state.documentationWaived = true;
    s.state.documentationWaiverReason = "tidak relevan";
    s.state.lastCommitSha = "abc123";
    s.reset();
    assert.deepEqual(s.state.documentationFiles, []);
    assert.equal(s.state.documentationWaived, false);
    assert.equal(s.state.documentationWaiverReason, "");
    assert.equal(s.state.lastCommitSha, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load menormalkan berkas state lama tanpa field baru", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-"));
  try {
    const file = path.join(dir, "state.json");
    await writeFile(file, JSON.stringify({ currentPhase: "coding", taskDescription: "lama", documentationFiles: "bukan-array", documentationWaived: "ya", lastCommitSha: 42 }), "utf8");
    const s = new WorkflowState(file);
    await s.load();
    assert.deepEqual(s.state.documentationFiles, []);
    assert.equal(s.state.documentationWaived, false);
    assert.equal(s.state.documentationWaiverReason, "");
    assert.equal(s.state.lastCommitSha, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/docs-gate-state.test.js`
Expected: FAIL — `documentationFiles` adalah `undefined`

- [ ] **Step 3: Tambahkan empat field** di ketiga literal state dan normalkan di `load()` dengan pola yang sudah dipakai `dodRevision` (`workflow-state.js:885`). `documentationFiles` wajib array of string; entri kosong atau bukan string dibuang.

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/docs-gate-state.test.js`
Expected: PASS, 3 tes.

### Task 3: Helper git untuk dokumentasi dan diff

**Files:**
- Modify: `git-helpers.js`, `git-facade.js`
- Test: `tests/git-helpers-docs.test.js`

**Interfaces:**
- Produces:
  - `getLastCommitForPath(filePath) -> Promise<string>` — ISO 8601 tanggal commit terakhir yang menyentuh path itu; `""` bila tidak ada
  - `inspectCommitDiff(sha) -> Promise<{ paths: string[], todos: Array<{ path: string, line: number, text: string }> }>` — `sha` kosong berarti `HEAD`
- Facade `createGitFacade()` wajib memuat keduanya (`tests/git-facade.test.js` gagal bila lupa).

- [ ] **Step 1: Tulis tes yang gagal** — `tests/git-helpers-docs.test.js`

Tes membuat repo git sementara lewat helper lokal `withTmpRepo(fn)`: `mkdtemp`, `git init`, `git -c user.email=a@b -c user.name=a commit --allow-empty -m init`, commit pertama menulis `README.md`, commit kedua menulis `src/a.js` yang berisi dua baris (`const a = 1;` lalu `// TODO: rapikan`), lalu `fn(dir)` dijalankan dengan cwd repo dan hasilnya dikembalikan sebelum direktori dihapus.

```js
test("getLastCommitForPath mengembalikan tanggal ISO commit yang menyentuh path", async () => {
  // repo sementara: commit 1 menulis README.md, commit 2 menulis src/a.js
  const iso = await withTmpRepo(async (dir) => getLastCommitForPath("README.md"));
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T/);
});

test("getLastCommitForPath mengembalikan string kosong untuk path yang belum pernah di-commit", async () => {
  const iso = await withTmpRepo(async () => getLastCommitForPath("tidak-ada.md"));
  assert.equal(iso, "");
});

test("inspectCommitDiff mengembalikan path dan TODO yang baru masuk", async () => {
  const r = await withTmpRepo(async () => inspectCommitDiff(""));
  assert.deepEqual(r.paths.sort(), ["README.md", "src/a.js"]);
  assert.equal(r.todos.length, 1);
  assert.equal(r.todos[0].path, "src/a.js");
  assert.equal(r.todos[0].line, 2);
  assert.match(r.todos[0].text, /TODO: rapikan/);
});

test("inspectCommitDiff mengabaikan TODO yang hanya dihapus", async () => {
  // commit menghapus baris TODO, tidak menambah
  const r = await withTmpRepo(async () => inspectCommitDiff(""));
  assert.deepEqual(r.todos, []);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/git-helpers-docs.test.js`
Expected: FAIL — bukan fungsi

- [ ] **Step 3: Implementasi**

- `getLastCommitForPath`: `git log -1 --format=%cI -- "<path>"`, `trim()`, kembalikan `""` bila kosong.
- `inspectCommitDiff`: satu panggilan `git show --unified=0 --no-color --no-renames <sha|HEAD>`. Lacak path aktif dari baris `+++ b/...`; hitung nomor baris dari header hunk `@@ -a,b +c,d @@`; kumpulkan baris yang diawali `+` (bukan `+++`) dan cocok `/TODO|FIXME|HACK|XXX/`. Simpan `text` tanpa awalan `+`, maksimal 160 karakter.
- Daftarkan keduanya di `git-facade.js`.

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/git-helpers-docs.test.js tests/git-facade.test.js`
Expected: PASS

### Task 4: `create_documentation` terverifikasi dan tool `waive_documentation`

**Files:**
- Modify: `tools/handler-modules/shared.js` (loader input gerbang), `tools/handler-modules/workflow-handlers.js`, `tools/definitions.js`, `tools/handler-modules/index.js`
- Test: `tests/docs-gate-handlers.test.js`

**Interfaces:**
- Consumes: `evaluateDocGate`, `isDocumentationPath`, `normalizePath`, `MIN_WAIVER_REASON`, `MAX_WAIVER_REASON` dari `docs.js`
- Produces:
  - `shared.js`: `loadDocGateInputs({ workflowState, git }) -> Promise<{ changedPaths, dirtyAtStart, declaredFiles, hasDocumentation, readmePath }>`
  - `workflow-handlers.js`: `handleCreateDocumentation(args, workflowState, context)`, `handleWaiveDocumentation(args, workflowState)`
  - Tool `create_documentation` menerima `files?: string[]`; tool baru `waive_documentation { reason }`

- [ ] **Step 1: Tulis tes yang gagal** — `tests/docs-gate-handlers.test.js`

Gunakan `git` tiruan: `getStatusOutput` mengembalikan keluaran porcelain, `parseStatusEntries` diambil dari `git-helpers.js`, `getToplevel` mengembalikan direktori repo sementara.

```js
test("create_documentation menolak files[] yang tidak muncul di working tree", async () => {
  const r = await handleCreateDocumentation({ documentationType: "README", summary: "x", files: ["README.md"] }, state, ctx({ status: " M src/a.js" }));
  assert.match(text(r), /^⚠️/);
  assert.match(text(r), /README\.md/);
  assert.match(text(r), /tidak muncul/);
});

test("create_documentation menolak files[] yang bukan dokumentasi", async () => {
  const r = await handleCreateDocumentation({ documentationType: "README", summary: "x", files: ["src/a.js"] }, state, ctx({ status: " M src/a.js" }));
  assert.match(text(r), /bukan berkas dokumentasi/);
});

test("create_documentation menyimpan files yang terverifikasi", async () => {
  const r = await handleCreateDocumentation({ documentationType: "README", summary: "x", files: ["README.md"] }, state, ctx({ status: " M src/a.js\n M README.md" }));
  assert.match(text(r), /^✅/);
  assert.deepEqual(state.state.documentationFiles, ["README.md"]);
});

test("create_documentation tanpa files tetap berhasil tetapi menyebut gerbang belum terpenuhi", async () => {
  const r = await handleCreateDocumentation({ documentationType: "inline-comments", summary: "x" }, state, ctx({ status: " M src/a.js" }));
  assert.match(text(r), /^✅/);
  assert.match(text(r), /gerbang dokumentasi belum terpenuhi/i);
});

test("waive_documentation menolak alasan kosong atau terlalu pendek", async () => {
  assert.match(text(await handleWaiveDocumentation({ reason: "" }, state)), /^⚠️/);
  assert.match(text(await handleWaiveDocumentation({ reason: "abc" }, state)), /^⚠️/);
});

test("waive_documentation mencatat alasan di state", async () => {
  const r = await handleWaiveDocumentation({ reason: "perubahan hanya refactor internal" }, state);
  assert.match(text(r), /^✅/);
  assert.equal(state.state.documentationWaived, true);
  assert.equal(state.state.documentationWaiverReason, "perubahan hanya refactor internal");
});

test("waive_documentation menolak sebelum tes lulus", async () => {
  state.state.testsPassed = false;
  assert.match(text(await handleWaiveDocumentation({ reason: "cukup panjang" }, state)), /^⚠️/);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/docs-gate-handlers.test.js`
Expected: FAIL

- [ ] **Step 3: Implementasi**

- `loadDocGateInputs` di `shared.js`: ambil `getStatusOutput` lalu `parseStatusEntries`, `dirtyAtStart` dari state, `declaredFiles` dari `state.documentationFiles`, `hasDocumentation` dengan `existsSync` pada `path.join(toplevel, kandidat)` untuk `README.md`, `readme.md`, `README`, `README.rst`, `README.txt`, `docs/README.md`, atau `existsSync(path.join(toplevel, "docs"))`; `readmePath` = kandidat pertama yang ada (atau `""`). Bila `git.getToplevel` gagal, kembalikan `hasDocumentation: false` dan `readmePath: ""` — jangan melempar.
- `handleCreateDocumentation`: verifikasi `files` seperti tes di atas. Pesan sukses selalu diawali `✅`; bila gerbang menghasilkan `needs-docs`, tambahkan paragraf `⚠️ Gerbang dokumentasi belum terpenuhi: ...` **di baris kedua**, bukan di awal.
- `handleWaiveDocumentation`: prasyarat `testsPassed || testsSkipped`; validasi panjang alasan 5–500; set dua field state; respons diawali `✅` dan menyebut bahwa waiver akan muncul di history dan rekomendasi.
- `definitions.js`: tambah `files` (array string, `maxItems: 20`) pada `create_documentation`; tambah definisi `waive_documentation` dengan `reason` wajib. Deskripsi menyebut bahwa tanpa `files` gerbang tidak akan lolos bila source berubah.
- `index.js`: teruskan `{ git }` ke `handleCreateDocumentation`, daftarkan `waive_documentation` di `dispatchToolCall`.

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/docs-gate-handlers.test.js`
Expected: PASS, 7 tes.

### Task 5: Gerbang di ready check, commit, dan panduan

**Files:**
- Modify: `tools/handler-modules/status-handlers.js`, `tools/handler-modules/commit-handlers.js`, `tools/handler-modules/shared.js`, `tools/handler-modules/index.js`
- Test: `tests/docs-gate-ready.test.js`

**Interfaces:**
- Consumes: `loadDocGateInputs` dari `shared.js`; `evaluateDocGate`, `isGateSatisfied`, `renderDocGateFailure` dari `docs.js`
- Produces: `handleReadyCheck(workflowState, context)`; `state.lastCommitSha` diisi `pushed.head`

- [ ] **Step 1: Tulis tes yang gagal** — `tests/docs-gate-ready.test.js`

```js
test("ready check menolak saat source berubah tanpa dokumentasi", async () => {
  const r = await handleReadyCheck(state, ctx({ status: " M src/a.js" }));
  assert.match(text(r), /NOT READY/);
  assert.match(text(r), /Documentation updated for code changes/);
  assert.match(text(r), /waive_documentation/);
  assert.equal(state.state.readyCheckCompleted, false);
});

test("ready check lolos saat berkas dokumentasi berubah", async () => {
  const r = await handleReadyCheck(state, ctx({ status: " M src/a.js\n M README.md" }));
  assert.match(text(r), /ALL CHECKS PASSED/);
});

test("ready check lolos saat waiver tercatat", async () => {
  state.state.documentationWaived = true;
  state.state.documentationWaiverReason = "refactor internal";
  const r = await handleReadyCheck(state, ctx({ status: " M src/a.js" }));
  assert.match(text(r), /ALL CHECKS PASSED/);
});

test("ready check tidak memblokir saat git tidak tersedia", async () => {
  const r = await handleReadyCheck(state, {});
  assert.match(text(r), /✅ Documentation updated for code changes/);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/docs-gate-ready.test.js`
Expected: FAIL

- [ ] **Step 3: Implementasi**

- `handleReadyCheck(workflowState, context = {})`: setelah baris `Documentation created`, tambahkan `{ name: "Documentation updated for code changes", done }`. Bila `context.git` tidak ada, `done = true` dan tambahkan catatan "gerbang dokumentasi tidak bisa diperiksa".
- Saat gagal, tambahkan hint berisi `renderDocGateFailure({ sourceChanged, readmePath, readmeAge, legacy })`; `readmeAge` dihitung dengan `formatRelativeAge(await git.getLastCommitForPath(readmePath))` di dalam `try/catch`. `legacy` = `true` bila `state.documentationCreated` sudah benar sebelum gerbang ini ada — cukup periksa `Boolean(state.documentationCreated)`.
- `commit-handlers.js:144` → `handleReadyCheck(workflowState, { git })`; setelah `verifyPushed` berhasil set `workflowState.state.lastCommitSha = pushed.head`.
- `status-handlers.js:139` → `handleReadyCheck(workflowState, context)`.
- `shared.js` `getContinueGuidance` fase `ready_to_complete`: tambahkan `Siapkan 'nextSteps' (1-5 butir, 10-200 karakter) saat 'complete_task' — apa yang sebaiknya dikerjakan berikutnya.` dan sebutkan `next_steps` untuk melihat rekomendasi.
- `index.js` case `check_ready_to_commit` → `handleReadyCheck(workflowState, context)`.

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/docs-gate-ready.test.js`
Expected: PASS, 4 tes.

### Task 6: `run_full_workflow` menolak di depan

**Files:**
- Modify: `tools/handler-modules/index.js`, `tools/definitions.js`
- Test: `tests/docs-gate-full-workflow.test.js`

**Interfaces:**
- Consumes: `loadDocGateInputs`, `evaluateDocGate`, `isGateSatisfied`
- Produces: `run_full_workflow` menerima `documentationFiles?: string[]` dan `documentationWaiverReason?: string`

- [ ] **Step 1: Tulis tes yang gagal** — `tests/docs-gate-full-workflow.test.js`

```js
// Helper lokal berkas ini:
// const runTool = (name, args) => handleToolCall({
//   request: { params: { name, arguments: args } },
//   normalizeRequestArgs,
//   workflowState: state, exec, git: ctx({ status: " M src/a.js" }).git,
//   utils: { shellEscape, determineReleaseTypeFromCommit, createCommitMessageParts },
// });

test("run_full_workflow menolak sebelum langkah pertama saat dokumentasi kurang", async () => {
  const r = await runTool("run_full_workflow", { summary: "x", testCommand: "npm test", documentationType: "README", documentationSummary: "x", commitMessage: "feat: x", releaseCommand: "npm run release", mermaidCode: "graph TD; A-->B;", featureFlowDescription: "x" });
  assert.match(text(r), /Dibatalkan sebelum satu langkah pun berjalan/);
  assert.match(text(r), /src\/a\.js/);
  assert.equal(state.state.bugFixed, false);
});

test("run_full_workflow menerima documentationWaiverReason", async () => {
  const r = await runTool("run_full_workflow", { summary: "x", testCommand: "npm test", documentationType: "README", documentationSummary: "x", commitMessage: "feat: x", releaseCommand: "npm run release", mermaidCode: "graph TD; A-->B;", featureFlowDescription: "x", documentationWaiverReason: "refactor internal" });
  assert.doesNotMatch(text(r), /Dibatalkan sebelum satu langkah pun berjalan/);
  assert.equal(state.state.documentationWaived, true);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/docs-gate-full-workflow.test.js`
Expected: FAIL

- [ ] **Step 3: Implementasi**

Sisipkan pemeriksaan tepat setelah blok `dodEvidence` (`tools/handler-modules/index.js:95`), sebelum `const steps = []`. Bila status `needs-docs` dan tidak ada `documentationFiles` maupun `documentationWaiverReason` non-kosong, kembalikan pesan yang diawali `⚠️ Dibatalkan sebelum satu langkah pun berjalan:` + `renderDocGateFailure(...)`. Bila `documentationWaiverReason` ada, panggil `handleWaiveDocumentation` sebelum loop dan catat di `steps`. Teruskan `documentationFiles` ke `handleCreateDocumentation`.

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/docs-gate-full-workflow.test.js`
Expected: PASS, 2 tes.

### Task 7: Modul murni `next-steps.js`

**Files:**
- Create: `tools/handler-modules/next-steps.js`
- Test: `tests/next-steps.test.js`

**Interfaces:**
- Produces:
  - `MAX_RECOMMENDATIONS = 6`, `MAX_AI_SUGGESTIONS = 5`, `MIN_AI_SUGGESTION = 10`, `MAX_AI_SUGGESTION = 200`
  - `validateAiSuggestions(raw) -> { ok: true, items: string[] } | { ok: false, error: string }`
  - `collectSignals({ state, commitInspection, statusOutput, dirtyAtStart }) -> Array<{ priority, source: "signal", title }>`
  - `buildRecommendations({ signals, aiSuggestions }) -> Array<{ priority, source, title }>` — urut `high`→`medium`→`low`, dedupe judul case-insensitive, potong 6 sinyal, lalu tambahkan saran AI dengan `source: "ai"` dan `priority: "medium"`
  - `renderRecommendations(items) -> string`

- [ ] **Step 1: Tulis tes yang gagal** — `tests/next-steps.test.js`

```js
test("validateAiSuggestions menolak lebih dari 5, terlalu pendek, terlalu panjang", () => {
  assert.equal(validateAiSuggestions(Array(6).fill("saran yang cukup panjang")).ok, false);
  assert.equal(validateAiSuggestions(["pendek"]).ok, false);
  assert.equal(validateAiSuggestions(["x".repeat(201)]).ok, false);
  assert.deepEqual(validateAiSuggestions(["saran yang cukup panjang"]).items, ["saran yang cukup panjang"]);
  assert.deepEqual(validateAiSuggestions([]).items, []);
});

test("collectSignals menandai DoD yang di-waive sebagai prioritas tinggi", () => {
  const signals = collectSignals({ state: { definitionOfDone: [{ id: "dod-1", text: "login terverifikasi", status: "waived", waivedReason: "butuh akun staging" }], history: [] } });
  assert.equal(signals[0].priority, "high");
  assert.match(signals[0].title, /login terverifikasi/);
  assert.match(signals[0].title, /butuh akun staging/);
});

test("collectSignals menyebut tes yang di-skip dan dokumentasi yang di-waive", () => {
  const signals = collectSignals({ state: { testsSkipped: true, testsSkippedReason: "tidak ada harness", documentationWaived: true, documentationWaiverReason: "refactor internal", history: [] } });
  assert.ok(signals.some((s) => /tidak ada harness/.test(s.title)));
  assert.ok(signals.some((s) => /refactor internal/.test(s.title)));
});

test("collectSignals mengambil TODO dari commitInspection, maksimal 5", () => {
  const todos = Array.from({ length: 7 }, (_, i) => ({ path: "src/a.js", line: i + 1, text: `TODO: ke-${i}` }));
  const signals = collectSignals({ state: { history: [] }, commitInspection: { paths: ["src/a.js"], todos } });
  const todoSignal = signals.find((s) => /TODO/.test(s.title));
  assert.match(todoSignal.title, /5 TODO/);
  assert.match(todoSignal.title, /src\/a\.js:1/);
});

test("collectSignals mendeteksi pola bugfix berulang dan diff besar", () => {
  const history = Array.from({ length: 5 }, () => ({ taskType: "bugfix" }));
  const signals = collectSignals({ state: { history }, commitInspection: { paths: Array.from({ length: 16 }, (_, i) => `src/f${i}.js`), todos: [] } });
  assert.ok(signals.some((s) => /bugfix/.test(s.title)));
  assert.ok(signals.some((s) => /16 berkas/.test(s.title)));
});

test("collectSignals menandai berkas kotor yang tertinggal", () => {
  const signals = collectSignals({ state: { history: [] }, statusOutput: " M lain.txt", dirtyAtStart: [{ path: "lain.txt" }] });
  assert.ok(signals.some((s) => s.priority === "high" && /tertinggal/.test(s.title)));
});

test("collectSignals tidak mengarang saat tidak ada sinyal", () => {
  assert.deepEqual(collectSignals({ state: { history: [] } }), []);
});

test("buildRecommendations mengurutkan prioritas, membuang duplikat, memotong 6", () => {
  const signals = [
    { priority: "low", source: "signal", title: "a" },
    { priority: "high", source: "signal", title: "b" },
    { priority: "high", source: "signal", title: "B" },
    { priority: "medium", source: "signal", title: "c" },
    { priority: "low", source: "signal", title: "d" },
    { priority: "low", source: "signal", title: "e" },
    { priority: "low", source: "signal", title: "f" },
    { priority: "low", source: "signal", title: "g" },
  ];
  const out = buildRecommendations({ signals, aiSuggestions: ["saran dari sesi ini"] });
  assert.equal(out.filter((i) => i.source === "signal").length, 6);
  assert.equal(out[0].title, "b");
  assert.equal(out.at(-1).source, "ai");
});

test("renderRecommendations menyebut fakta dan saran secara terpisah", () => {
  const text = renderRecommendations([
    { priority: "high", source: "signal", title: "DoD dilewati" },
    { priority: "medium", source: "ai", title: "refreshToken rapuh" },
  ]);
  assert.match(text, /Dari fakta sesi ini:/);
  assert.match(text, /Saran sesi ini:/);
  assert.match(text, /\[tinggi\] DoD dilewati/);
  assert.match(text, /refreshToken rapuh/);
});

test("renderRecommendations menyatakan terus terang bila kosong", () => {
  assert.match(renderRecommendations([]), /Tidak ada sinyal/);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/next-steps.test.js`
Expected: FAIL

- [ ] **Step 3: Implementasi `next-steps.js`** sesuai daftar interface. Batas judul 300 karakter. Jangan menambahkan saran pengganti saat daftar kosong.

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/next-steps.test.js`
Expected: PASS, 10 tes.

### Task 8: `complete_task` dengan rekomendasi dan tool `next_steps`

**Files:**
- Create: `tools/handler-modules/next-steps-handlers.js`
- Modify: `tools/handler-modules/commit-handlers.js`, `tools/handler-modules/index.js`, `tools/definitions.js`
- Test: `tests/next-steps-handlers.test.js`

**Interfaces:**
- Consumes: `collectSignals`, `buildRecommendations`, `renderRecommendations`, `validateAiSuggestions` dari `next-steps.js`; `inspectCommitDiff` dari `git-facade`
- Produces: `handleCompleteTask(args, workflowState, context)`, `handleNextSteps(args, workflowState)`

- [ ] **Step 1: Tulis tes yang gagal** — `tests/next-steps-handlers.test.js`

```js
test("complete_task menolak nextSteps yang tidak valid", async () => {
  const r = await handleCompleteTask({ commitMessage: "feat: x", nextSteps: ["pendek"] }, state, ctx());
  assert.match(text(r), /^⚠️/);
  assert.match(text(r), /10/);
  assert.equal(state.state.currentPhase, "coding");
});

test("complete_task menampilkan blok rekomendasi dan menyimpannya", async () => {
  state.state.definitionOfDone = [{ id: "dod-1", text: "x", status: "waived", waivedReason: "butuh staging" }];
  state.state.dodRevision = 0;
  const r = await handleCompleteTask({ commitMessage: "feat: x", nextSteps: ["perbaiki refreshToken"] }, state, ctx());
  assert.match(text(r), /Saran pekerjaan selanjutnya/);
  assert.match(text(r), /butuh staging/);
  assert.match(text(r), /perbaiki refreshToken/);
  const entry = state.state.history.at(-1);
  assert.equal(entry.aiSuggestions.length, 1);
  assert.ok(entry.recommendations.some((i) => i.source === "ai"));
});

test("complete_task tanpa nextSteps tetap menutup task dan meminta saran", async () => {
  const r = await handleCompleteTask({ commitMessage: "feat: x" }, state, ctx());
  assert.match(text(r), /^✅/);
  assert.match(text(r), /Kirim 'nextSteps'/);
});

test("next_steps menampilkan rekomendasi tersimpan", async () => {
  await handleCompleteTask({ commitMessage: "feat: x" }, state, ctx());
  const r = await handleNextSteps({}, state);
  assert.match(text(r), /Saran pekerjaan selanjutnya/);
});

test("next_steps tanpa history tidak crash", async () => {
  const r = await handleNextSteps({}, state);
  assert.match(text(r), /Belum ada rekomendasi tersimpan/);
});

test("next_steps mengabaikan entri history lama tanpa recommendations", async () => {
  state.state.history = [{ taskDescription: "lama", taskType: "other", commitMessage: "x" }];
  const r = await handleNextSteps({}, state);
  assert.match(text(r), /Belum ada rekomendasi tersimpan/);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/next-steps-handlers.test.js`
Expected: FAIL

- [ ] **Step 3: Implementasi**

- `handleCompleteTask`: validasi `nextSteps` dengan `validateAiSuggestions` **sebelum** menyentuh state. Kumpulkan `statusOutput`, `dirtyAtStart`, dan `commitInspection` (lewat `inspectCommitDiff(state.lastCommitSha)`, dibungkus `try/catch`; saat gagal, lanjutkan tanpa sinyal diff dan tambahkan catatan di output). Bangun rekomendasi, masukkan ke entri history bersama `documentation: { type, files, waived, waiverReason }` dan `aiSuggestions`.
- Tanpa `nextSteps`, tambahkan baris `Kirim 'nextSteps' saat 'complete_task' kalau ada yang Anda lihat selama mengerjakan.` — dan tetap diawali `✅`.
- `handleNextSteps`: ambil entri terakhir yang punya `recommendations` non-kosong; render. Bila tidak ada, tampilkan `Belum ada rekomendasi tersimpan.` + ringkasan proyek dari `generateProjectSummary(state.history)`.
- `definitions.js`: `complete_task` menerima `nextSteps` (array string, `maxItems: 5`); tool baru `next_steps` tanpa argumen.
- `index.js`: dispatch `next_steps`; teruskan `{ git }` ke `handleCompleteTask`; `run_full_workflow` meneruskan `nextSteps` bila ada.

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/next-steps-handlers.test.js`
Expected: PASS, 6 tes.

### Task 9: Skrip `npm run update:check`

**Files:**
- Create: `scripts/check-update.mjs`
- Modify: `package.json` (script `update:check`)
- Test: `tests/check-update.test.js`

**Interfaces:**
- Produces:
  - `compareVersions(a, b) -> -1 | 0 | 1`
  - `buildReport({ localVersion, npmVersion, localSha, remoteSha, errors }) -> { exitCode: 0 | 1 | 2, findings: Array<{ level: "ok"|"update"|"unknown", message: string }>, human: string, json: object }`
  - `main(argv) -> Promise<number>` — hanya berjalan saat dieksekusi langsung

- [ ] **Step 1: Tulis tes yang gagal** — `tests/check-update.test.js`

```js
test("compareVersions mengurutkan versi numerik", () => {
  assert.equal(compareVersions("1.15.1", "1.15.0"), 1);
  assert.equal(compareVersions("1.15.0", "1.15.0"), 0);
  assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
});

test("buildReport: dua-duanya mutakhir -> exit 0", () => {
  const r = buildReport({ localVersion: "1.15.1", npmVersion: "1.15.1", localSha: "38be409", remoteSha: "38be409", errors: [] });
  assert.equal(r.exitCode, 0);
});

test("buildReport: clone tertinggal -> exit 1 dan sebut git pull", () => {
  const r = buildReport({ localVersion: "1.15.1", npmVersion: "1.15.0", localSha: "38be409", remoteSha: "a1b2c3d", errors: [] });
  assert.equal(r.exitCode, 1);
  assert.match(r.human, /git pull/);
  assert.match(r.human, /restart proses MCP/);
});

test("buildReport: clone lebih maju dari npm dilaporkan apa adanya", () => {
  const r = buildReport({ localVersion: "1.15.1", npmVersion: "1.15.0", localSha: "38be409", remoteSha: "38be409", errors: [] });
  assert.equal(r.exitCode, 0);
  assert.match(r.human, /lebih baru dari rilis publik/);
});

test("buildReport: semua sumber gagal -> exit 2, tidak melempar", () => {
  const r = buildReport({ localVersion: "1.15.1", npmVersion: "", localSha: "", remoteSha: "", errors: ["npm: timeout", "git: tidak ada remote"] });
  assert.equal(r.exitCode, 2);
  assert.match(r.human, /tidak bisa diperiksa/);
});

test("buildReport: --json menghasilkan objek yang sama", () => {
  const r = buildReport({ localVersion: "1.15.1", npmVersion: "1.15.1", localSha: "a", remoteSha: "a", errors: [] });
  assert.equal(r.json.localVersion, "1.15.1");
  assert.equal(r.json.exitCode, 0);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/check-update.test.js`
Expected: FAIL

- [ ] **Step 3: Implementasi** — `compareVersions` membandingkan segmen numerik, lalu memperlakukan versi dengan sufiks `-prerelease` lebih rendah. `main()` memanggil tiga sumber dengan `try/catch` dan `AbortSignal.timeout(5000)`, mencetak `report.human` atau `JSON.stringify(report.json)` bila `--json`, lalu `process.exitCode = report.exitCode`. Jalankan hanya bila `process.argv[1]` menunjuk berkas ini.

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/check-update.test.js`
Expected: PASS, 6 tes.

- [ ] **Step 5: Verifikasi nyata**

Run: `npm run update:check`
Expected: mencetak versi terpasang 1.15.1, npm latest, status clone, lalu exit 0 (clone sinkron dengan `origin/main` pada 1 November 2026).

### Task 10: Dokumentasi, suite penuh, dan rilis

**Files:**
- Modify: `README.md`, `AGENTS.md`, `.agent/workflows/dev-workflow-feature.md`, `.agent/workflows/dev-workflow-bugfix.md`, `.agent/workflows/dev-workflow-refactor.md`, `.agent/workflows/dev-workflow-full-cycle.md`, `docs/WORKFLOW-BEST-PRACTICES.md`
- Modify: `tests/tool-definitions.test.js`, `tests/handlers.test.js`, `tests/handlers-workflow.test.js`, `tests/handlers-commit.test.js`, `tests/workflowState.test.js`

**Interfaces:**
- Consumes: seluruh tool dan signature dari Task 1–9

- [ ] **Step 1: Perbarui tes yang memanggil handler dengan signature lama**

`handleReadyCheck` sekarang menerima context dan `handleCreateDocumentation` menerima context. Perbaiki pemanggilan di empat berkas tes agar menerima `{ git }` tiruan; tambahkan asersi bahwa `tools/definitions.js` memuat `waive_documentation` dan `next_steps`, dan bahwa `create_documentation` punya properti `files`.

- [ ] **Step 2: Jalankan seluruh suite**

Run: `npm test`
Expected: seluruh tes PASS. Jumlah tes naik dari 563; tidak boleh ada `fail`.

- [ ] **Step 3: Perbarui dokumentasi**

- `README.md`: tambahkan `waive_documentation` dan `next_steps` ke tabel tool, `files` pada `create_documentation`, langkah gerbang dokumentasi di bagian workflow, dan bagian baru "Memeriksa update" berisi `npm run update:check`.
- `AGENTS.md`: langkah 7 menyebut `files` dan `waive_documentation`; tambahkan langkah "Tinjau tindak lanjut" dengan `next_steps` dan `nextSteps` pada `complete_task`.
- Empat `.agent/workflows/dev-workflow-*.md`: perbarui bagian `create_documentation` agar menyebut `files`.
- `docs/WORKFLOW-BEST-PRACTICES.md`: tambahkan paragraf singkat tentang waiver sebagai keputusan yang tercatat, bukan jalan pintas.

- [ ] **Step 4: Verifikasi dokumentasi menyebut perilaku baru**

Run: `Select-String -Path README.md,AGENTS.md,.agent/workflows/*.md -Pattern "waive_documentation|next_steps|update:check" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: lebih dari 10 kecocokan.

- [ ] **Step 5: Buktikan seluruh DoD dan jalankan gerbang**

Untuk tiap item `dod-1`…`dod-9`, panggil `mark_dod_item` dengan bukti yang menyebut perintah yang benar-benar dijalankan. Lalu `check_ready_to_commit`.

- [ ] **Step 6: Commit dan rilis**

`commit_and_push` dengan pesan `feat(workflow): gerbang dokumentasi, rekomendasi tindak lanjut, dan pemeriksaan update`, lalu `perform_release` dengan `npm run release:minor`. Verifikasi `package.json` menjadi `1.16.0` dan tag ter-push.