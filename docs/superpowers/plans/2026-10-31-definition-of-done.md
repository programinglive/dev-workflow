# Definition of Done Lokal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Setiap task lokal di dev-workflow MCP membawa checklist kondisi konkret yang harus dibuktikan per item atau dikecualikan dengan alasan, dan gerbang ready-check/commit/complete menolak selama masih ada item terbuka.

**Architecture:** Item DoD disimpan sebagai array terstruktur di `workflow-state.json` (bukan teks, bukan sidecar), dinormalkan di `load()`, digabung antar-proses dengan aturan `(statusRank, revision)`, dan ditegakkan lewat dua baris baru di `handleReadyCheck` plus guard eksplisit di `commit_and_push` dan `complete_task`. Kebasian bukti memakai penghitung `dodRevision` tingkat task, bukan mutasi status, supaya tidak melawan `mergeMonotonicProgress`.

**Tech Stack:** Node.js ESM, MCP SDK, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-31-definition-of-done-design.md`

## Global Constraints

- Repo: `C:\Users\<username>\Documents\code\dev-workflow-mcp-server` (v1.13.16, salinan yang dijalankan MCP).
- Baseline tes sebelum perubahan: `npm test` → 450 tes, 448 pass, 2 skipped, 0 fail.
- Batas item: 1–20 item per task. Teks item 3–300 karakter setelah trim. `evidence` dan `waivedReason` 5–500 karakter.
- Duplikat teks item ditolak case-insensitive.
- Status item hanya `"open" | "done" | "waived"`.
- `isSatisfied(item) := status === "waived" || (status === "done" && revision === state.dodRevision)`.
- Hanya `resetToCommitIfWorkingChanges` yang menaikkan `dodRevision`.
- Pesan galat berbahasa Indonesia, menyebut aturan, nilai bermasalah, dan panggilan berikutnya.
- Rilis: `1.14.0` (minor).
- Jangan commit selama `npm test` belum hijau.

## Review Focus

- **Task lama tanpa field DoD** (state ditulis v1.13.x). Ekspektasi wajar: task tampil dengan nol item, gerbang menolak, dan `set_definition_of_done` membuka jalannya — bukan crash, bukan lolos diam-diam.
- **`mark_dod_item` pada item yang sudah `done` tetapi basi.** Ekspektasi: idempoten, bukti tersegarkan, `revision` ikut naik, item kembali memenuhi.
- **`set_definition_of_done` saat sudah ada item terbukti.** Ekspektasi: ditolak dengan tawaran `append: true` atau waive; bukti tidak hilang.
- **`claim_factory_task` untuk task papan tanpa DoD.** Ekspektasi: `dodSource` kosong + peringatan jelas, bukan daftar item kosong yang tampak sah.
- **Dua proses MCP menyimpan task yang sama.** Ekspektasi: bukti tidak saling menghapus; entri dengan `(statusRank, revision)` lebih tinggi menang.

---

### Task 1: Modul murni `dod.js`

**Files:**
- Create: `tools/handler-modules/dod.js`
- Test: `tests/dod.test.js`

**Interfaces:**
- Produces:
  - `MAX_ITEMS = 20`, `MAX_TEXT = 300`, `MIN_EVIDENCE = 5`, `MAX_EVIDENCE = 500`
  - `validateItemTexts(texts) -> { ok: true, items: string[] } | { ok: false, error: string }`
  - `normalizeItems(raw) -> item[]`
  - `parseFactoryChecklist(text) -> { items: string[], truncated: boolean }`
  - `isSatisfied(item, revision) -> boolean`
  - `nextItemId(items) -> string`
  - `openItems(items, revision) -> item[]`
  - `renderChecklist(items, revision) -> string`
  - `summarize(items, revision) -> { total, done, waived, open, waivedReasons }`
  - `mergeDefinitionOfDone(memoryItems, diskItems) -> item[]`

- [ ] **Step 1: Tulis tes yang gagal** — `tests/dod.test.js` mencakup: `validateItemTexts` menolak `[]`, `""`, teks 2 char, 21 item, duplikat `"build lulus"` vs `"Build Lulus"`; `parseFactoryChecklist` mengubah `- [ ] build lulus` dan `- [x] tes` jadi teks polos (keduanya `open` di sisi pemanggil), mengabaikan `## Heading`, baris kosong, dan prosa, memotong teks >300, membatasi 20 dengan `truncated: true`; `isSatisfied` untuk keenam kombinasi status × revisi; `nextItemId` dari daftar kosong (`dod-1`) dan dari `dod-1,dod-7` (`dod-8`); `mergeDefinitionOfDone` mempertahankan `done` atas `open` dan revision lebih tinggi atas lebih rendah.
- [ ] **Step 2: Jalankan, pastikan gagal** — `node --test tests/dod.test.js` → FAIL `Cannot find module`.
- [ ] **Step 3: Implementasi `dod.js`** sesuai daftar interface di atas.
- [ ] **Step 4: Jalankan, pastikan lolos** — `node --test tests/dod.test.js` → semua PASS.
- [ ] **Step 5: Commit** — `git add tools/handler-modules/dod.js tests/dod.test.js && git commit -m "feat(dod): pure definition-of-done helpers"`

### Task 2: Field state, normalisasi, merge, revisi

**Files:**
- Modify: `workflow-state.js` — tiga literal state (constructor :636, `useSession` :681, `reset` :1250), `load()` :712, `save()` :920
- Test: `tests/dod-state.test.js`

**Interfaces:**
- Consumes: `normalizeItems`, `mergeDefinitionOfDone` dari `dod.js`.
- Produces: `state.definitionOfDone: item[]`, `state.dodSource: string`, `state.dodFactoryTaskId: string`, `state.dodRevision: number`; method `mergeDefinitionOfDone(reconciled)` pada `WorkflowState`.

- [ ] **Step 1: Tulis tes yang gagal** — `tests/dod-state.test.js`: state lama tanpa field DoD → `[]`/`""`/`""`/`0` setelah `load()`; `reset()` mengosongkan DoD; item berstatus `"...asing"` dinormalkan jadi `"open"`; dua `WorkflowState` pada berkas sama, task sama, satu mencatat `done` lalu yang lain menyimpan `open` → hasil di disk tetap `done`.
- [ ] **Step 2: Jalankan, pastikan gagal.**
- [ ] **Step 3: Implementasi** — tambahkan empat field di ketiga literal; normalisasi di `load()` mengikuti pola `typeof ... !== "string"` yang sudah ada; `mergeDefinitionOfDone(reconciled)` dipanggil di `save()` tepat setelah `this.mergeMonotonicProgress(reconciled)`.
- [ ] **Step 4: Jalankan, pastikan lolos.**
- [ ] **Step 5: Commit** — `feat(dod): persist definition of done in workflow state`

### Task 3: `start_task` mewajibkan DoD

**Files:**
- Modify: `tools/definitions.js:9-38`, `tools/handler-modules/workflow-handlers.js:70`
- Test: `tests/dod-handlers.test.js`
- Test (update): `tests/test-helpers.js` + 15 call-site `start_task`

**Interfaces:**
- Produces: `handleStartTask` menolak dengan `textResponse` berisi `⚠️` bila `definitionOfDone` hilang/kosong/tidak sah.

- [ ] **Step 1: Tulis tes yang gagal** — `start_task` tanpa `definitionOfDone` → teks memuat `/definitionOfDone/` dan `/wajib|required/i`; dengan `["build lulus"]` → sukses dan `state.definitionOfDone[0].text === "build lulus"`; dengan dua item duplikat → ditolak.
- [ ] **Step 2: Jalankan, pastikan gagal.**
- [ ] **Step 3: Implementasi** — tambah `definitionOfDone: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 }` ke schema dan ke `required`; di `handleStartTask` validasi lebih dulu sebelum `reconcileWithDisk()`, lalu isi `definitionOfDone`, `dodSource: "manual"`, `dodFactoryTaskId: ""`, `dodRevision: 0` setelah `reset()`.
- [ ] **Step 4: Perbarui 15 call-site lama** lewat helper `startTaskArgs(description, type, extra)` di `tests/test-helpers.js` yang menyisipkan `definitionOfDone: ["<default>"]`.
- [ ] **Step 5: Jalankan `npm test`, pastikan hijau.**
- [ ] **Step 6: Commit** — `feat(dod): require a definition of done when starting a task`

### Task 4: Tiga handler DoD

**Files:**
- Create: `tools/handler-modules/dod-handlers.js`
- Modify: `tools/definitions.js`, `tools/handler-modules/index.js`
- Test: `tests/dod-handlers.test.js`

**Interfaces:**
- Produces: `handleSetDefinitionOfDone(args, workflowState)`, `handleMarkDodItem(args, workflowState)`, `handleWaiveDodItem(args, workflowState)`.

- [ ] **Step 1: Tulis tes yang gagal** — `set_definition_of_done` saat idle ditolak; mengganti daftar yang punya item `done` ditolak dan menyebut `append`; `append: true` menambah tanpa membuang; `mark_dod_item` tanpa `evidence` ditolak; `evidence` 4 karakter ditolak; `mark_dod_item` pada item `waived` ditolak; `mark_dod_item` dua kali idempoten; `waive_dod_item` pada item `done` ditolak; `waive_dod_item` tanpa alasan ditolak; setiap mutasi mengosongkan `readyCheckCompleted`.
- [ ] **Step 2: Jalankan, pastikan gagal.**
- [ ] **Step 3: Implementasi** handler tipis + skema tool + case switch.
- [ ] **Step 4: Jalankan, pastikan lolos.**
- [ ] **Step 5: Commit** — `feat(dod): add tools to record, prove and waive items`

### Task 5: Gerbang ready-check, commit, complete

**Files:**
- Modify: `tools/handler-modules/status-handlers.js:46`, `tools/handler-modules/commit-handlers.js:115,304`, `tools/handler-modules/shared.js:30`
- Test: `tests/dod-handlers.test.js`

**Interfaces:**
- Produces: `handleReadyCheck` dua baris baru; `handleCommitAndPush` dan `handleCompleteTask` menolak saat ada item terbuka; `resetToCommitIfWorkingChanges` menaikkan `dodRevision`.

- [ ] **Step 1: Tulis tes yang gagal** — ready check gagal dengan `❌ Definition of done satisfied` saat satu item terbuka, dan lolos setelah `mark_dod_item`; `commit_and_push` mengembalikan teks yang menyebut id item dan tidak memanggil `git add`; `complete_task` menolak dengan item terbuka dan menerima setelah dibuktikan; `force_complete_task` tetap lolos dan mencatat `forced: true` + `dodSummary`; setelah `commitAndPushCompleted` lalu ada working changes, `resetToCommitIfWorkingChanges` menaikkan `dodRevision` sehingga item `done` jadi tidak memenuhi, sementara `waived` tetap memenuhi.
- [ ] **Step 2: Jalankan, pastikan gagal.**
- [ ] **Step 3: Implementasi.**
- [ ] **Step 4: Jalankan, pastikan lolos.**
- [ ] **Step 5: Commit** — `feat(dod): gate commit and completion on proven items`

### Task 6: Tampilan status, `rerun_workflow`, tarik dari papan

**Files:**
- Modify: `tools/handler-modules/status-handlers.js:4,138`, `tools/handler-modules/factory-handlers.js:108`
- Test: `tests/dod-handlers.test.js`

**Interfaces:**
- Consumes: `parseFactoryChecklist`, `renderChecklist`, `summarize`.
- Produces: `claim_factory_task` mengisi `definitionOfDone` dari papan sebagai `open`.

- [ ] **Step 1: Tulis tes yang gagal** — `get_workflow_status` menampilkan `DoD: 2/4 selesai, 1 dilewati, 1 terbuka`; `rerun_workflow` mempertahankan item yang sudah ada; `claim_factory_task` dengan checklist papan `- [x] sudah` tetap masuk sebagai `open` dan `dodSource: "factory"`; papan tanpa DoD menghasilkan peringatan.
- [ ] **Step 2: Jalankan, pastikan gagal.**
- [ ] **Step 3: Implementasi.**
- [ ] **Step 4: Jalankan `npm test` penuh, pastikan hijau.**
- [ ] **Step 5: Commit** — `feat(dod): show items in status and import them from the board`

### Task 7: Dokumentasi dan rilis

**Files:**
- Modify: `AGENTS.md`, `README.md`, `docs/software-factory.md`, `CHANGELOG.md`, `docs/PRD.md`
- Test: `npm test` (regresi)

- [ ] **Step 1: Perbarui `AGENTS.md`** — sepuluh langkah jadi dua belas, dengan DoD di `start_task` dan pencetakan bukti setelah implementasi.
- [ ] **Step 2: Perbarui `README.md`** — bagian tool baru + contoh `start_task` dengan `definitionOfDone`.
- [ ] **Step 3: Perbarui `docs/software-factory.md`** — paritas dengan papan Factory dan bedanya.
- [ ] **Step 4: Perbarui `CHANGELOG.md`** — entri `1.14.0`.
- [ ] **Step 5: Jalankan `npm test`**, pastikan masih 0 fail.
- [ ] **Step 6: Commit** — `docs(dod): document the per-item definition of done`
- [ ] **Step 7: Rilis** — `npm run release:minor`, lalu catat lewat `perform_release`.
