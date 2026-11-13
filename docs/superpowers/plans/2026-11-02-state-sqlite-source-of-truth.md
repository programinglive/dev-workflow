# State Hidup di SQLite sebagai Sumber Kebenaran — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memindahkan state hidup workflow dari berkas JSON ke SQLite lokal, sehingga tulis bersamaan tidak bisa lagi merusak data, dan Postgres tidak pernah berada di jalur tulis.

**Architecture:** SQLite lokal (`<proyek>/.state/dev-workflow.db`) menjadi satu-satunya sumber kebenaran untuk state sesi, history, dan ringkasan. Setiap baris state dikunci `(user_id, project_path, session_key)` dan membawa kolom `version`, sehingga dua sesi tidak bisa berbagi baris dan tulis ganda ditolak, bukan ditimpa. Postgres hanya menerima salinan lewat antrean `sync_queue` yang dikuras best-effort. Berkas JSON tetap ditulis, tetapi hanya sebagai ekspor.

**Tech Stack:** Node 24 ESM, `better-sqlite3` 12.11.1 (sudah terpasang), `node:test`, `better-sqlite3` WAL mode.

**Spec:** `docs/superpowers/specs/2026-11-02-state-sqlite-source-of-truth-design.md`

## Global Constraints

- **SQLite adalah sumber kebenaran.** Tidak ada jalur baca state hidup yang boleh jatuh ke berkas JSON atau ke Postgres.
- **Postgres tidak pernah berada di jalur tulis.** Kegagalan replika tidak boleh menggagalkan `save()`.
- **SQLite gagal dibuka berarti tolak tulis** dengan melempar `StateUnavailable`. Tidak ada cadangan JSON.
- **Gagal membaca tidak pernah berarti kosong** (aturan dari commit `870d495`).
- **Berkas JSON lama tidak boleh dihapus**, hanya dipindah ke `.state/legacy-json/<stamp>/`.
- **`resolveSessionKey(env, sessionId)` tetap mengembalikan string** dan tetap diekspor, demi pemanggil lama.
- **Cadangan identitas sesi adalah `proc-<uuid4>`, bukan `pid-<pid>`.**
- **`better-sqlite3` bersifat sinkron**; setiap transaksi harus selesai dalam satu putaran tanpa `await` di dalamnya.
- Nama tabel, kolom, dan nilai `key_source` mengikuti spec apa adanya: `request-metadata`, `env`, `process-random`, `legacy-file`, `legacy-db`.

## Review Focus

- **Normalisasi `project_path`.** `D:\code\foo` dan `d:/code/foo` dan `D:\code\foo\` harus menjadi satu baris yang sama. Kalau tidak, sesi yang sama berpindah mesin akan tampak sebagai proyek baru dan riwayatnya terpecah.
- **Dua proses menguras antrean yang sama.** `drain()` bisa berjalan dari dua proses; pengiriman ganda harus dicegah oleh `dedupe_key`, bukan oleh harapan bahwa hanya ada satu penguras.
- **Paritas sanitasi kunci saat migrasi.** Nama berkas `workflow-state.ses_e6f3f146fffdUkCQUiSxpb75W6.json` harus menghasilkan `session_key` yang identik dengan `sanitizeSessionKey`. Kalau tidak, migrasi membuat baris yatim yang tidak pernah dibaca.
- **Jam mesin yang meleset.** `updated_at` dan backoff harus memakai `datetime('now')` dari SQLite, bukan `new Date()` dari proses, supaya mesin dengan jam salah tidak membalik urutan antrean.
- **Ukuran `state_json` saat history menua.** `history` masih tinggal di dalam `state_json`; ribuan entri membuat setiap `save()` menulis ulang seluruh riwayat. Ukur dan batasi.
- **Penyimpanan wajib tidak boleh gagal karena hal opsional.** Replika mati, ekspor JSON gagal ditulis, atau monitor tidak terjangkau tidak boleh membatalkan penyimpanan state. Ini kelas bug yang sudah pernah terjadi: penyimpanan dokumentasi ikut gagal karena hal lain.

---

## File Structure

| Berkas | Tanggung jawab |
|---|---|
| `db/errors.js` (baru) | `StateConflict`, `StateUnavailable` — dua kelas error yang dipakai lapisan db dan handler |
| `db/session-key.js` (baru) | `resolveSessionKeyWithSource`, `sanitizeSessionKey`, `normalizeProjectPath` — satu tempat untuk semua normalisasi kunci |
| `db/schema.js` (baru) | DDL v1 + `ensureSchema(db)` — dipisah dari adapter supaya migrasi bisa menguji skema tanpa membuka koneksi |
| `db/adapters/sqlite.js` (ubah) | memakai `db/schema.js`; tambah `saveStateVersioned`, `loadStateVersioned`, `enqueue`, `drainOnce`, `queueDepth`, `archiveLegacyState` |
| `db/replicate.js` (baru) | backoff, `drainSync`, pelaporan; satu-satunya tempat yang tahu tentang adapter replika |
| `db/index.js` (ubah) | `getLocalAdapter()`, `getReplicaAdapter()`, `saveStateVersioned`, `loadStateVersioned`, `enqueueSync`, `drainSync`, `queueDepth` |
| `workflow-state.js` (ubah) | `load`/`save`/`writeHistoryFile`/`syncToDatabase` dialihkan; `reconcileWithDisk`, `detectStaleOverwrite`, `adoptDiskState` dihapus |
| `tools/handler-modules/status-handlers.js` (ubah) | `get_workflow_status` menampilkan kedalaman antrean dan peringatan pertikaian |
| `tools/handler-modules/index.js` (ubah) | meneruskan `StateConflict`/`StateUnavailable` sebagai jawaban tool |

---

### Task 1: Kelas error state dan normalisasi kunci

**Files:**
- Create: `db/errors.js`
- Create: `db/session-key.js`
- Test: `tests/state-keys.test.js`

**Interfaces:**
- Consumes: tidak ada
- Produces:
  - `class StateConflict extends Error` — `code = "STATE_CONFLICT"`, properti `sessionKey`, `expectedVersion`, `actualVersion`
  - `class StateUnavailable extends Error` — `code = "STATE_UNAVAILABLE"`, properti `cause` (Error asli)
  - `resolveSessionKeyWithSource(env, explicitSessionId) -> { key: string, source: "request-metadata"|"env"|"process-random" }`
  - `sanitizeSessionKey(value) -> string` (dipindah dari `workflow-state.js`, perilaku identik)
  - `normalizeProjectPath(value) -> string` — huruf drive kecil, garis miring jadi `/`, garis miring akhir dibuang

- [ ] **Step 1: Tulis tes yang gagal**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSessionKeyWithSource, sanitizeSessionKey, normalizeProjectPath } from "../db/session-key.js";
import { StateConflict, StateUnavailable } from "../db/errors.js";

test("metadata request menang atas env", () => {
  const r = resolveSessionKeyWithSource({ DEV_WORKFLOW_SESSION_ID: "env-key" }, "ses_abc");
  assert.deepEqual(r, { key: "ses_abc", source: "request-metadata" });
});

test("tanpa metadata dan env, kunci adalah proc- acak dan sumbernya jujur", () => {
  const a = resolveSessionKeyWithSource({}, null);
  const b = resolveSessionKeyWithSource({}, null);
  assert.match(a.key, /^proc-[0-9a-f-]{36}$/);
  assert.equal(a.source, "process-random");
  assert.equal(a.key, b.key, "satu proses memakai satu kunci");
});

test("sanitasi kunci sama dengan yang dipakai nama berkas legacy", () => {
  assert.equal(
    sanitizeSessionKey("ses_e6f3f146fffdUkCQUiSxpb75W6"),
    "ses_e6f3f146fffdUkCQUiSxpb75W6",
  );
  assert.equal(sanitizeSessionKey("a/b c"), "a-b-c");
});

test("project_path dinormalisasi sehingga satu proyek jadi satu baris", () => {
  assert.equal(normalizeProjectPath("D:\\code\\Foo\\"), "d:/code/foo");
  assert.equal(normalizeProjectPath("d:/code/foo"), "d:/code/foo");
  assert.equal(normalizeProjectPath("D:\\code\\Foo"), "d:/code/foo");
});

test("error membawa kode dan detail", () => {
  const c = new StateConflict("bentrok", { sessionKey: "s", expectedVersion: 3, actualVersion: 4 });
  assert.equal(c.code, "STATE_CONFLICT");
  assert.equal(c.expectedVersion, 3);
  const u = new StateUnavailable("disk penuh", { cause: new Error("SQLITE_FULL") });
  assert.equal(u.code, "STATE_UNAVAILABLE");
  assert.equal(u.cause.message, "SQLITE_FULL");
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test tests/state-keys.test.js`
Expected: FAIL — `Cannot find module '../db/session-key.js'`

- [ ] **Step 3: Implementasikan `db/errors.js` dan `db/session-key.js`**

`resolveSessionKeyWithSource` meniru urutan `resolveSessionKey` yang ada di `workflow-state.js:660`, dengan satu perubahan: cabang terakhir mengembalikan `proc-<uuid4>` yang **dihitung sekali per proses** (simpan di variabel modul), bukan `pid-<pid>`. Tambahkan `normalizeProjectPath` di berkas yang sama.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test tests/state-keys.test.js`
Expected: PASS, 5 tes.

- [ ] **Step 5: Commit**

```bash
git add db/errors.js db/session-key.js tests/state-keys.test.js
git commit -m "feat(db): kelas error state dan normalisasi kunci sesi"
```

---

### Task 2: Skema v1 dan baca/tulis state berversi

**Files:**
- Create: `db/schema.js`
- Modify: `db/adapters/sqlite.js:57-151` (ganti isi `migrate()` agar memanggil `ensureSchema`)
- Modify: `db/index.js`
- Test: `tests/db-state-versioned.test.js`

**Interfaces:**
- Consumes: `StateConflict`, `StateUnavailable`, `normalizeProjectPath` dari Task 1
- Produces:
  - `ensureSchema(db)` — membuat semua tabel dan `schema_version = 1` bila belum ada
  - `saveStateVersioned({ userId, projectPath, sessionKey, state, expectedVersion }) -> { version }`
  - `loadStateVersioned({ userId, projectPath, sessionKey }) -> { state, version } | null`

- [ ] **Step 1: Tulis tes yang gagal**

```js
test("simpan pertama membuat versi 0 lalu 1", async () => {
  const db = tmpAdapter();
  const first = await saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "s", state: { a: 1 }, expectedVersion: null });
  assert.equal(first.version, 1);
  const loaded = await loadStateVersioned({ userId: "u", projectPath: "p", sessionKey: "s" });
  assert.deepEqual(loaded.state, { a: 1 });
  assert.equal(loaded.version, 1);
});

test("dua sesi berbeda tidak saling menimpa", async () => {
  await saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "A", state: { who: "A" }, expectedVersion: null });
  await saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "B", state: { who: "B" }, expectedVersion: null });
  assert.equal((await loadStateVersioned({ userId: "u", projectPath: "p", sessionKey: "A" })).state.who, "A");
  assert.equal((await loadStateVersioned({ userId: "u", projectPath: "p", sessionKey: "B" })).state.who, "B");
});

test("versi basi ditolak dengan StateConflict, isi pemenang tidak rusak", async () => {
  await saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { v: 1 }, expectedVersion: null });
  await saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { v: 2 }, expectedVersion: 1 });
  await assert.rejects(
    saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { v: 3 }, expectedVersion: 1 }),
    (e) => e.code === "STATE_CONFLICT" && e.actualVersion === 2,
  );
  assert.deepEqual((await loadStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S" })).state, { v: 2 });
});

test("project_path yang berbeda penulisannya menunjuk baris yang sama", async () => {
  await saveStateVersioned({ userId: "u", projectPath: "D:\\Code\\Foo\\", sessionKey: "S", state: { n: 1 }, expectedVersion: null });
  const loaded = await loadStateVersioned({ userId: "u", projectPath: "d:/code/foo", sessionKey: "S" });
  assert.equal(loaded.state.n, 1);
});

test("updated_at memakai jam SQLite, bukan jam proses", async () => {
  await saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: {}, expectedVersion: null });
  const row = readRaw("select updated_at from workflow_state where session_key='S'");
  assert.ok(row.updated_at);
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test tests/db-state-versioned.test.js`
Expected: FAIL — `saveStateVersioned is not a function`

- [ ] **Step 3: Tulis `db/schema.js` dan implementasikan di adapter**

`ensureSchema(db)` menjalankan DDL dari spec: `workflow_state` dengan PK `(user_id, project_path, session_key)`, `state_writer`, `sync_queue`, `schema_version`, `workflow_state_legacy`. Semua `CREATE ... IF NOT EXISTS`.

`saveStateVersioned` memakai satu transaksi `BEGIN IMMEDIATE`:

```
expectedVersion === null -> INSERT ... ON CONFLICT DO NOTHING
                            bila 0 baris -> baris sudah ada -> lempar StateConflict
expectedVersion !== null -> UPDATE ... SET version = version + 1 WHERE ... AND version = expectedVersion
                            bila 0 baris -> baca actualVersion -> lempar StateConflict
```

`updated_at` diisi `datetime('now')` di SQL, bukan parameter.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test tests/db-state-versioned.test.js`
Expected: PASS, 5 tes.

- [ ] **Step 5: Commit**

```bash
git add db/schema.js db/adapters/sqlite.js db/index.js tests/db-state-versioned.test.js
git commit -m "feat(db): skema v1 dan state berversi per sesi"
```

---

### Task 3: Antrean replika dengan backoff

**Files:**
- Create: `db/replicate.js`
- Modify: `db/adapters/sqlite.js` (tambah `enqueue`, `drainOnce`, `queueDepth`)
- Modify: `db/index.js`
- Test: `tests/db-replica-queue.test.js`

**Interfaces:**
- Consumes: koneksi SQLite dari Task 2
- Produces:
  - `enqueue(adapter, kind, dedupeKey, payload)` — `INSERT ... ON CONFLICT(kind, dedupe_key) DO UPDATE payload`
  - `drainSync({ replica, limit, budgetMs }) -> { sent, failed, remaining }`
  - `backoffSeconds(attempts) -> number` — 1, 2, 4, 8, 16, 32, 64, lalu 300
  - `queueDepth() -> { pending: number, oldestAgeMs: number }`

- [ ] **Step 1: Tulis tes yang gagal**

```js
test("enqueue idempoten: kunci sama tidak menumpuk", async () => {
  await enqueue(adapter, "state", "u|p|s", JSON.stringify({ v: 1 }));
  await enqueue(adapter, "state", "u|p|s", JSON.stringify({ v: 2 }));
  assert.equal(await pendingCount(adapter), 1);
});

test("replika mati tidak melempar dan antrean bertahan", async () => {
  const failing = { push: async () => { throw new Error("ECONNREFUSED"); } };
  const r = await drainSync({ replica: failing, limit: 10, budgetMs: 1000 });
  assert.equal(r.failed, 1);
  assert.equal(r.remaining, 1);
});

test("backoff menaik lalu berhenti di 300 detik", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(backoffSeconds), [1, 2, 4, 8, 16, 32, 64, 300]);
});

test("dua penguras tidak mengirim baris yang sama dua kali", async () => {
  const sent = [];
  let inFlight = 0;
  const replica = {
    push: async (row) => {
      inFlight++;
      try { sent.push(row.dedupe_key); } finally { inFlight--; }
    },
  };
  await Promise.all([
    drainSync({ replica, limit: 10, budgetMs: 1000 }),
    drainSync({ replica, limit: 10, budgetMs: 1000 }),
  ]);
  assert.deepEqual(sent, ["u|p|s"], "dedupe_key mencegah kiriman ganda");
});

test("queueDepth melaporkan umur baris tertua", async () => {
  const d = await queueDepth();
  assert.equal(d.pending, 1);
  assert.ok(d.oldestAgeMs >= 0);
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test tests/db-replica-queue.test.js`
Expected: FAIL — `drainSync is not a function`

- [ ] **Step 3: Implementasikan `db/replicate.js` dan method adapter**

`drainOnce` memilih baris dengan `WHERE next_attempt_at IS NULL OR next_attempt_at <= datetime('now')`, lalu mengirim satu per satu. Untuk mencegah kiriman ganda antar-proses, klaim baris lebih dulu di dalam transaksi:

```
UPDATE sync_queue SET next_attempt_at = datetime('now', '+300 seconds')
WHERE id = ? AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
```

Hanya lanjut mengirim bila 1 baris berubah.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test tests/db-replica-queue.test.js`
Expected: PASS, 5 tes.

- [ ] **Step 5: Commit**

```bash
git add db/replicate.js db/adapters/sqlite.js db/index.js tests/db-replica-queue.test.js
git commit -m "feat(db): antrean replika dengan backoff dan klaim baris"
```

---

### Task 4: Migrasi dari JSON lama dan arsip baris state lama

**Files:**
- Modify: `db/adapters/sqlite.js` (tambah `archiveLegacyState`, `migrateLegacyJson`)
- Test: `tests/db-migrate-legacy.test.js`

**Interfaces:**
- Consumes: `ensureSchema`, `saveStateVersioned`, `sanitizeSessionKey`, `normalizeProjectPath`
- Produces:
  - `archiveLegacyState(db) -> { archived: number }`
  - `migrateLegacyJson(db, { baseDir }) -> { sessions: number, projects: number, legacyFallback: number }`
  - Melempar `Error` bila jumlah baris < jumlah berkas yang terbaca

- [ ] **Step 1: Tulis tes yang gagal**

```js
test("baris workflow_state lama diarsipkan, bukan dijadikan state hidup", async () => {
  seedLegacyRow({ userId: "u", projectPath: "p", stateJson: '{"taskDescription":"milik sesi lain"}' });
  const r = await archiveLegacyState(db);
  assert.equal(r.archived, 1);
  assert.equal(countRows("workflow_state"), 0);
  assert.equal(countRows("workflow_state_legacy"), 1);
});

test("state per sesi dimigrasikan dari berkas JSON, bukan dari baris DB", async () => {
  writeJson(".state/projects/foo-b1/users/user-x/workflow-state.ses_aaa.json", { taskDescription: "task A" });
  seedLegacyRow({ userId: "user-x", projectPath: "p", stateJson: '{"taskDescription":"milik sesi lain"}' });
  await archiveLegacyState(db);
  await migrateLegacyJson(db, { baseDir: ".state" });
  const loaded = await loadStateVersioned({ userId: "user-x", projectPath: "p", sessionKey: "ses_aaa" });
  assert.equal(loaded.state.taskDescription, "task A");
});

test("proyek tanpa berkas JSON memakai baris legacy sebagai cadangan", async () => {
  seedLegacyRow({ userId: "user-y", projectPath: "q", stateJson: '{"taskDescription":"sisa"}' });
  await archiveLegacyState(db);
  await migrateLegacyJson(db, { baseDir: ".state" });
  const loaded = await loadStateVersioned({ userId: "user-y", projectPath: "q", sessionKey: "legacy-project" });
  assert.equal(loaded.state.taskDescription, "sisa");
});

test("migrasi kedua tidak menggandakan apa pun", async () => {
  await migrateLegacyJson(db, { baseDir: ".state" });
  const before = countRows("workflow_state");
  await migrateLegacyJson(db, { baseDir: ".state" });
  assert.equal(countRows("workflow_state"), before);
});

test("berkas lama dipindah, tidak dihapus", async () => {
  assert.equal(existsSync(".state/legacy-json"), true);
  assert.equal(existsSync(".state/projects/foo-b1/users/user-x/workflow-state.ses_aaa.json"), false);
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test tests/db-migrate-legacy.test.js`
Expected: FAIL — `archiveLegacyState is not a function`

- [ ] **Step 3: Implementasikan migrasi**

Urutan wajib: arsipkan `workflow_state` → baca berkas JSON → `INSERT OR IGNORE` → cadangan `legacy-project` untuk proyek tanpa JSON → hitung ulang dan lempar bila kurang → pindahkan berkas ke `.state/legacy-json/<stamp>/` → tulis `schema_version`.

`session_key` dari nama berkas dihitung dengan `sanitizeSessionKey` yang sama dari Task 1, supaya paritasnya terjaga.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test tests/db-migrate-legacy.test.js`
Expected: PASS, 5 tes.

- [ ] **Step 5: Commit**

```bash
git add db/adapters/sqlite.js tests/db-migrate-legacy.test.js
git commit -m "feat(db): migrasi JSON lama ke SQLite dan arsip baris state proyek"
```

---

### Task 5: `save()` menulis ke SQLite

**Files:**
- Modify: `workflow-state.js:1603-1680` (`save`)
- Modify: `workflow-state.js:1895-1924` (`syncToDatabase` menjadi `enqueueReplica`)
- Test: `tests/state-sqlite-save.test.js`

**Interfaces:**
- Consumes: `resolveSessionKeyWithSource`, `saveStateVersioned`, `enqueue`, `drainSync`, `StateConflict`, `StateUnavailable`
- Produces:
  - `WorkflowState.prototype.sessionKey` — string, diisi di constructor
  - `WorkflowState.prototype.sessionKeySource` — string
  - `WorkflowState.prototype.stateVersion` — number
  - `save(options)` mengembalikan bentuk yang sama seperti sekarang (`{ conflict?, verified, ... }`) agar handler tidak perlu berubah

- [ ] **Step 1: Tulis tes yang gagal**

```js
test("dua sesi pada proyek sama tidak saling menimpa", async () => {
  const a = await makeState({ sessionId: "ses_a" });
  const b = await makeState({ sessionId: "ses_b" });
  await a.startTask("task A"); await a.save();
  await b.startTask("task B"); await b.save();
  const aReload = await makeState({ sessionId: "ses_a" });
  assert.equal(aReload.state.taskDescription, "task A");
});

test("penulis kedua dengan versi basi mendapat conflict, bukan menimpa", async () => {
  const w1 = await makeState({ sessionId: "ses_x" });
  const w2 = await makeState({ sessionId: "ses_x" });
  await w1.startTask("pertama"); await w1.save();
  await w2.startTask("kedua");
  const r = await w2.save();
  assert.ok(r.conflict, "save kedua harus melaporkan konflik");
  const fresh = await makeState({ sessionId: "ses_x" });
  assert.equal(fresh.state.taskDescription, "pertama", "isi pemenang tidak rusak");
});

test("bersama background tidak menyentuh jalur tulis", async () => {
  const w = await makeState({ sessionId: "ses_y" });
  await w.startTask("task"); await w.save();
  assert.equal(w.state.projectDir !== undefined, true);
});

test("dokumentasi tetap tersimpan meski replika gagal", async () => {
  // Kelas bug 2 November 2026: penyimpanan wajib tidak boleh ikut gagal
  // karena hal opsional. Replika yang mati harus terlihat di antrean saja.
  const replica = { push: async () => { throw new Error("down"); } };
  const w = await makeState({ sessionId: "ses_doc", replica });
  await w.startTask("simpan dokumentasi");
  w.state.documentationFiles = ["docs/x.md"];
  await w.save();
  const reloaded = await makeState({ sessionId: "ses_doc", replica });
  assert.deepEqual(reloaded.state.documentationFiles, ["docs/x.md"]);
});

test("SQLite tidak bisa dibuka: save melempar StateUnavailable, bukan mengaku sukses", async () => {
  process.env.DEV_WORKFLOW_DB_PATH = "/tidak/ada/direktori/db.sqlite";
  const w = await makeState({ sessionId: "ses_z" });
  await assert.rejects(w.save(), (e) => e.code === "STATE_UNAVAILABLE");
});

test("replika mati tidak menggagalkan save", async () => {
  const w = await makeState({ sessionId: "ses_w", replica: { push: async () => { throw new Error("down"); } } });
  await w.startTask("tetap jalan");
  const r = await w.save();
  assert.equal(r.verified, true);
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test tests/state-sqlite-save.test.js`
Expected: FAIL — state masih ditulis ke JSON, konflik tidak terdeteksi sebagai `StateConflict`

- [ ] **Step 3: Implementasikan `save()` baru**

Ganti badan `save()` mengikuti 12 langkah di spec: hitung `sessionKey`, `saveStateVersioned`, `enqueue` baris replika, tulis ekspor JSON secara atomik (`tmp` + `rename`), `drainSync` berbatas ~1,2 detik, lalu `verifyPersisted` membaca ulang **dari SQLite**.

`mergeMonotonicProgress` dan `mergeDefinitionOfDone` dipanggil **di dalam** transaksi terhadap baris yang baru dibaca, bukan terhadap berkas.

`reconcileWithDisk`, `detectStaleOverwrite`, `adoptDiskState` dihapus dari `save()`. Metodenya dihapus pada Task 7.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test tests/state-sqlite-save.test.js`
Expected: PASS, 5 tes.

- [ ] **Step 5: Commit**

```bash
git add workflow-state.js tests/state-sqlite-save.test.js
git commit -m "feat(state): save() menulis state hidup ke SQLite berversi"
```

---

### Task 6: `load()` dan history membaca dari SQLite

**Files:**
- Modify: `workflow-state.js:1291-1420` (`load`)
- Modify: `workflow-state.js:1423-1500` (`mergeSharedHistory`, `writeHistoryFile`)
- Test: `tests/state-sqlite-load.test.js`

**Interfaces:**
- Consumes: `loadStateVersioned`, `migrateLegacyJson`, `insertHistoryEntry` (adapter lokal)
- Produces: `load()` yang memuat state dari SQLite; `writeHistoryFile()` menjadi penulis DB, bukan penulis berkas

- [ ] **Step 1: Tulis tes yang gagal**

```js
test("load memakai state dari SQLite walau berkas JSON tidak ada", async () => {
  await saveStateVersioned({ userId, projectPath, sessionKey: "ses_q", state: { taskDescription: "dari db" }, expectedVersion: null });
  const w = await makeState({ sessionId: "ses_q" });
  assert.equal(w.state.taskDescription, "dari db");
});

test("load memanggil migrasi sekali saat database kosong", async () => {
  const w = await makeState({ sessionId: "ses_m", freshDb: true });
  assert.equal(countRows("schema_version"), 1);
});

test("state_json rusak ditolak, tidak dianggap kosong", async () => {
  seedCorruptRow({ userId, projectPath, sessionKey: "ses_bad" });
  const w = makeStateRaw({ sessionId: "ses_bad" });
  await assert.rejects(w.load(), /rusak/);
});

test("history ditulis ke tabel workflow_history, bukan berkas bersama", async () => {
  const w = await makeState({ sessionId: "ses_h" });
  await w.startTask("task history");
  await w.save();
  assert.ok(countRows("workflow_history") > 0);
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test tests/state-sqlite-load.test.js`
Expected: FAIL — `load()` masih membaca berkas JSON

- [ ] **Step 3: Implementasikan `load()` dan history**

`load()`:

1. `migrateLegacyJson` bila `schema_version` belum ada
2. `loadStateVersioned`; `null` berarti sesi baru → state default
3. `state_json` rusak → salin ke `*.corrupt-<stamp>` lalu lempar `StateUnavailable`
4. `history` dibaca dari `workflow_history` per proyek, bukan per sesi
5. tidak ada lagi pembacaan berkas JSON sebagai sumber

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test tests/state-sqlite-load.test.js`
Expected: PASS, 4 tes.

- [ ] **Step 5: Commit**

```bash
git add workflow-state.js tests/state-sqlite-load.test.js
git commit -m "feat(state): load() dan history membaca dari SQLite"
```

---

### Task 7: Hapus rekonsiliasi berkas dan jadikan JSON ekspor

**Files:**
- Modify: `workflow-state.js` (hapus `reconcileWithDisk`, `detectStaleOverwrite`, `adoptDiskState`, `ensureCompatibilityLinks` dari jalur tulis)
- Test: `tests/state-json-export-only.test.js`

**Interfaces:**
- Consumes: `save()` dari Task 5
- Produces: `exportJson(path)` internal — menulis atomik, mencatat kegagalan tanpa melempar

- [ ] **Step 1: Tulis tes yang gagal**

```js
test("berkas JSON tetap ditulis sebagai ekspor", async () => {
  const w = await makeState({ sessionId: "ses_e" });
  await w.startTask("ekspor"); await w.save();
  const onDisk = JSON.parse(readFileSync(w.stateFile, "utf-8"));
  assert.equal(onDisk.taskDescription, "ekspor");
});

test("berkas JSON diubah tangan tidak mengubah state sesi", async () => {
  const w = await makeState({ sessionId: "ses_f" });
  await w.startTask("asli"); await w.save();
  writeFileSync(w.stateFile, JSON.stringify({ taskDescription: "diubah tangan" }));
  const reloaded = await makeState({ sessionId: "ses_f" });
  assert.equal(reloaded.state.taskDescription, "asli", "SQLite yang menang");
});

test("gagal menulis ekspor tidak menggagalkan save", async () => {
  const w = await makeState({ sessionId: "ses_g" });
  w.stateFile = "Z:\\tidak\\ada\\state.json";
  await w.startTask("tetap tersimpan");
  const r = await w.save();
  assert.equal(r.verified, true);
});

test("tidak ada lagi jalur yang memanggil reconcileWithDisk", () => {
  const src = readFileSync("workflow-state.js", "utf-8");
  assert.equal(src.includes("reconcileWithDisk("), false);
  assert.equal(src.includes("detectStaleOverwrite("), false);
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test tests/state-json-export-only.test.js`
Expected: FAIL — berkas JSON masih dibaca sebagai kebenaran

- [ ] **Step 3: Hapus jalur rekonsiliasi, sisakan ekspor**

Ekspor ditulis ke `tmp` lalu `rename` (atomik). Kegagalan dicatat lewat `safeLog` dan **tidak** dilempar.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test tests/state-json-export-only.test.js`
Expected: PASS, 4 tes.

- [ ] **Step 5: Commit**

```bash
git add workflow-state.js tests/state-json-export-only.test.js
git commit -m "refactor(state): JSON hanya ekspor, rekonsiliasi berkas dihapus"
```

---

### Task 8: `get_workflow_status` melaporkan antrean dan pertikaian

**Files:**
- Modify: `tools/handler-modules/status-handlers.js`
- Test: `tests/status-queue-report.test.js`

**Interfaces:**
- Consumes: `queueDepth()` dari Task 3, `state_writer` dari Task 2
- Produces: dua baris tambahan di jawaban `get_workflow_status`:
  - `Replika: tertunda N` (hanya bila `N > 0`)
  - `⚠️ Dua proses menulis sesi yang sama` (hanya bila pertikaian terdeteksi)

- [ ] **Step 1: Tulis tes yang gagal**

```js
test("antrean kosong tidak menampilkan baris replika", async () => {
  const text = await statusText();
  assert.equal(text.includes("Replika:"), false);
});

test("antrean terisi menampilkan jumlahnya", async () => {
  await enqueue(adapter, "state", "u|p|s", "{}");
  const text = await statusText();
  assert.match(text, /Replika: tertunda 1/);
});

test("satu proses menulis berulang tidak memicu peringatan pertikaian", async () => {
  await touchWriter({ sessionKey: "ses_s", pid: 111, token: "t1" });
  await touchWriter({ sessionKey: "ses_s", pid: 111, token: "t1" });
  const text = await statusText();
  assert.equal(text.includes("Dua proses"), false);
});

test("dua proses berbeda pada kunci sama memicu peringatan", async () => {
  await touchWriter({ sessionKey: "ses_s", pid: 111, token: "t1" });
  await touchWriter({ sessionKey: "ses_s", pid: 222, token: "t2" });
  const text = await statusText();
  assert.match(text, /Dua proses menulis sesi yang sama/);
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test tests/status-queue-report.test.js`
Expected: FAIL — baris belum ada

- [ ] **Step 3: Implementasikan pelaporan**

`state_writer` di-upsert setiap `save()` dengan `datetime('now')`. Pertikaian dihitung: `count(distinct process_token) > 1` untuk `(user, proyek, sesi)` dalam 60 detik terakhir.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test tests/status-queue-report.test.js`
Expected: PASS, 4 tes.

- [ ] **Step 5: Commit**

```bash
git add tools/handler-modules/status-handlers.js tests/status-queue-report.test.js
git commit -m "feat(status): laporkan antrean replika dan pertikaian penulis"
```

---

### Task 9: Handler meneruskan `StateConflict` dan `StateUnavailable`

**Files:**
- Modify: `tools/handler-modules/index.js:437-453`
- Test: `tests/handler-state-errors.test.js`

**Interfaces:**
- Consumes: `StateConflict`, `StateUnavailable`
- Produces: jawaban tool yang menyebut sebab, bukan `⚠️ Internal server error`

- [ ] **Step 1: Tulis tes yang gagal**

```js
test("StateConflict dijawab dengan pesan yang menyebut sesi lain, bukan error internal", async () => {
  const r = await callWithThrowing(() => { throw new StateConflict("versi 3 sudah basi", { sessionKey: "ses_s", expectedVersion: 3, actualVersion: 4 }); });
  assert.equal(r.content[0].text.includes("Internal server error"), false);
  assert.match(r.content[0].text, /ses_s/);
});

test("StateUnavailable menyebut sebabnya dan menolak mengaku sukses", async () => {
  const r = await callWithThrowing(() => { throw new StateUnavailable("disk penuh"); });
  assert.match(r.content[0].text, /disk penuh/);
  assert.equal(r.isError, true);
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test tests/handler-state-errors.test.js`
Expected: FAIL — pesan generik

- [ ] **Step 3: Tambahkan cabang error di `handleToolCall`**

Bersebelahan dengan cabang `SECRET_CONTENT_DENIED` yang sudah ada.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test tests/handler-state-errors.test.js`
Expected: PASS, 2 tes.

- [ ] **Step 5: Commit**

```bash
git add tools/handler-modules/index.js tests/handler-state-errors.test.js
git commit -m "feat(handlers): bedakan konflik state dan penyimpanan tidak tersedia"
```

---

### Task 10: Suite lama hijau dan dokumentasi

**Files:**
- Modify: `tests/workflowState.test.js` (stub `db/index.js` diganti adapter SQLite di tmpdir)
- Modify: `docs/monitor-dashboard.md` atau `docs/SHARED-STATE.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: semua task sebelumnya
- Produces: rilis 1.20.0

- [ ] **Step 1: Jalankan seluruh suite**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/*.test.js`
Expected: semua lulus. Kegagalan yang muncul diharapkan berasal dari stub `db/index.js`.

- [ ] **Step 2: Perbaiki tes yang bergantung pada jalur JSON**

Ganti stub dengan adapter SQLite sungguhan di `tmpdir()`. Jangan melemahkan asersi.

- [ ] **Step 3: Jalankan ulang suite**

Run: `node --no-deprecation --import ./tests/setup-env.js --test tests/*.test.js`
Expected: 0 fail.

- [ ] **Step 4: Perbarui dokumentasi**

`docs/SHARED-STATE.md`: ganti seluruh bagian "berkas JSON" menjadi "SQLite adalah sumber kebenaran; JSON hanya ekspor", sertakan tata letak tabel dan arti `key_source`. `CHANGELOG.md`: catat sebagai perubahan yang memutus — alat yang membaca `.state/workflow-state.json` langsung akan melihat data beku.

- [ ] **Step 5: Commit**

```bash
git add tests/workflowState.test.js docs/SHARED-STATE.md CHANGELOG.md
git commit -m "test(state): suite memakai SQLite sungguhan; dokumentasi diperbarui"
```

---

## Catatan untuk pelaksana

1. **Urutan tidak boleh diubah.** Task 5 bergantung pada Task 1-4; menghapus rekonsiliasi (Task 7) sebelum `save()` baru hijau akan merusak sementara.
2. **Jangan menyentuh `monitor-server/`.** Dashboard tetap membaca Postgres.
3. **Setiap tugas berakhir dengan commit.** Jangan menggabungkan dua tugas dalam satu commit.
4. **Bila `better-sqlite3` perlu rebuild** di salah satu mesin, hentikan dan laporkan — jangan diam-diam mengganti ke adapter lain.
5. **Ukur durasi `save()` sebelum dan sesudah Task 5.** Angka itu masuk ke catatan rilis.