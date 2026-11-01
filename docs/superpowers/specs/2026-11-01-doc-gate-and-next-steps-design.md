# Gerbang Dokumentasi & Rekomendasi Pekerjaan Selanjutnya — Design

**Tanggal:** 2026-11-01
**Status:** Menunggu review spec
**Repo:** `D:\code\dev-workflow-mcp-server` (v1.15.1)
**Rilis yang direncanakan:** 1.16.0 (minor — dua tool baru, satu gerbang baru)

## Ringkasan

Dua perubahan pada dev-workflow MCP, keduanya soal apa yang terjadi setelah kode selesai ditulis, plus satu skrip pemeriksaan versi.

1. **Gerbang dokumentasi.** `create_documentation` berhenti menjadi klaim. Langkah dokumentasi baru lolos kalau ada berkas dokumentasi yang benar-benar berubah di working tree, atau kalau agen mengecualikannya dengan alasan tertulis yang tercatat.
2. **Rekomendasi pekerjaan selanjutnya.** `complete_task` dan tool baru `next_steps` melaporkan tindak lanjut yang berasal dari fakta sesi (item DoD yang dilewati, tes yang di-skip, TODO baru di diff, berkas yang tertinggal), ditambah slot saran dari agen.
3. **Pemeriksaan versi.** `npm run update:check` menjawab apakah clone ketinggalan dari `origin` atau ada versi npm yang lebih baru, dan menyebut perintah perbaikannya.

Spec ini satu; implementasinya dua fase, dirilis bersama sebagai 1.16.0.

## Masalah

### README tidak pernah diperbarui

`handleCreateDocumentation` (`tools/handler-modules/workflow-handlers.js:414`) hanya menyimpan apa yang dikirim agen:

```js
workflowState.state.documentationCreated = true;
workflowState.state.documentationType = args.documentationType;
workflowState.state.documentationSummary = args.summary;
```

`documentationType` adalah enum bebas pilih: `"inline-comments"` menutup langkah dokumentasi sama sahnya dengan `"README"`. Tidak ada satu pun pembacaan working tree. Satu-satunya pemeriksaan berkas, `ensurePrdExists()` (`tools/handler-modules/shared.js:187`), memeriksa `docs/PRD.md` **milik MCP server sendiri** — selalu ada, tidak pernah gagal, dan tidak ada hubungannya dengan repo yang sedang dikerjakan.

Akibatnya `check_ready_to_commit` (`status-handlers.js:82`) melaporkan "Documentation created ✅" untuk repo yang README-nya tidak tersentuh berbulan-bulan.

### Tidak ada tindak lanjut setelah task selesai

`handleCompleteTask` (`commit-handlers.js:378`) mengembalikan tiga baris lalu `reset()`. Padahal tepat sebelum reset, state memegang bahan yang paling berguna untuk sesi berikutnya:

- item DoD yang di-`waive` beserta alasannya — pekerjaan yang sengaja ditinggalkan
- `testsSkipped` + alasan — cakupan tes yang hilang
- TODO/FIXME yang baru masuk lewat commit ini
- berkas kotor yang sengaja tidak ikut di-commit (`foreignNote`, `commit-handlers.js:368`)
- riwayat tipe task

Semua itu dibuang. `view_history` hanya menyimpan deskripsi task dan pesan commit.

## Tujuan

- Agen tidak bisa lagi menutup langkah dokumentasi tanpa menyentuh berkas dokumentasi, atau tanpa alasan tertulis yang bisa dibaca kemudian.
- Setiap task selesai meninggalkan daftar tindak lanjut yang bisa ditunjuk sumbernya.
- Tidak ada klaim palsu: setiap butir bisa diperiksa ulang oleh manusia.

## Non-tujuan

- Tidak menebak apakah sebuah perubahan "layak didokumentasikan". Gerbang memakai aturan berkas yang bisa ditebak, dan menyediakan waiver.
- Tidak memeriksa kualitas isi README. Yang diukur hanya bahwa berkas dokumentasi berubah.
- Tidak menulis otomatis ke papan Factory.
- Tidak memanggil model bahasa untuk menyusun rekomendasi.
- Dashboard web (`web/`) tidak disentuh.

## Bagian 1 — Gerbang dokumentasi

### Model data

Empat field state baru, ditambahkan di tiga tempat yang membentuk state segar (`workflow-state.js` constructor, `useSession`, `reset`) dan dinormalkan di `load()`:

```js
documentationFiles: [],        // path dokumentasi yang DIBUKTIKAN berubah
documentationWaived: false,    // agen mengecualikan gerbang dengan alasan
documentationWaiverReason: "", // 5..500 karakter
lastCommitSha: "",             // HEAD setelah commit_and_push berhasil
```

### Klasifikasi path

Fungsi murni di modul baru `tools/handler-modules/docs.js`.

`isDocumentationPath(p)` benar bila salah satu:

- nama berkas diawali `readme`, `changelog`, `contributing`, `architecture`, `security`, `code_of_conduct`, `agents` (case-insensitive, diikuti `.` atau akhir nama)
- path berada di bawah direktori `docs/` atau `doc/`
- berekstensi `.md`, `.mdx`, `.rst`, `.adoc` dan **tidak** berada di direktori tes/fixture

`isSourcePath(p)` benar bila:

- berekstensi `.js .jsx .mjs .cjs .ts .tsx .vue .svelte .php .py .rb .go .rs .java .kt .kts .cs .c .h .cc .cpp .hpp .swift .dart .scala .sh .bash .ps1 .sql .graphql .proto .ex .exs .lua .r .pl .clj .elm .zig`
- bukan dokumentasi
- bukan berkas tes (aturan yang sudah ada di `git-helpers.js:56`)
- bukan di bawah `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`

Berkas konfigurasi dan data (`.json .yaml .yml .toml .ini .lock .env`) **tidak** dihitung sebagai source. Mengubah lockfile atau CI tidak menuntut README.

### Aturan gerbang

`evaluateDocGate({ changedPaths, dirtyAtStart, declaredFiles, hasDocumentation, waived })` mengembalikan:

```js
{
  status: "ok" | "needs-docs" | "waived" | "no-docs" | "unknown",
  sourceChanged: [],
  docsTouched: []
}
```

| Kondisi | `status` |
|---|---|
| `waived` benar | `"waived"` |
| `hasDocumentation` salah | `"no-docs"` |
| `sourceChanged` kosong | `"ok"` |
| `docsTouched` tidak kosong | `"ok"` |
| selain itu | `"needs-docs"` |

Dengan:

```
sourceChanged = changedPaths ∩ isSourcePath ∩ bukan dirtyAtStart
docsTouched   = (changedPaths ∩ isDocumentationPath ∩ bukan dirtyAtStart)
              ∪ (declaredFiles ∩ changedPaths ∩ isDocumentationPath)
```

**Berkas dokumentasi yang sudah kotor sebelum `start_task` tidak dihitung**, kecuali disebut eksplisit di `declaredFiles`. Alasannya sama dengan `foreignDirtyEntries` (`git-helpers.js:140`): berkas yang sudah kotor di baseline tidak bisa dibedakan dari pekerjaan sesi lain, dan `commit_and_push` justru menolak memasukkannya. Menghitungnya sebagai bukti akan menghasilkan laporan palsu. Menyebutkannya di `declaredFiles` adalah klaim eksplisit atas satu berkas tertentu, dan klaim itu tercatat.

`hasDocumentation` dihitung dari repo root menurut `git.getToplevel()`, memeriksa keberadaan salah satu dari: `README.md`, `readme.md`, `README`, `README.rst`, `README.txt`, `docs/README.md`, atau direktori `docs/`.

`status: "unknown"` dipakai bila `git` tidak tersedia (mis. handler dipanggil tanpa context). Ia **tidak memblokir**, dan pesannya menyebut terus terang bahwa gerbang tidak bisa diperiksa. Gerbang yang diam-diam mati lebih buruk daripada gerbang yang mengaku tidak tahu.

### Permukaan tool

**`create_documentation`** — tambah parameter opsional:

```js
files: { type: "array", items: { type: "string" }, maxItems: 20 }
```

Verifikasi: setiap path di `files` harus (a) `isDocumentationPath` dan (b) muncul di `changedPaths`. Path yang gagal ditolak dengan pesan yang menyebut berkas mana yang benar-benar berubah. Path yang lolos disimpan ke `documentationFiles`.

`documentationType` tetap wajib seperti sekarang, tetapi berhenti menjadi penentu: ia hanya label untuk dibaca manusia. Yang menentukan lolos atau tidak adalah `files` yang terverifikasi, atau waiver.

Tanpa `files`, panggilan tetap berhasil (kompatibilitas), dan pesan suksesnya menyebut apakah gerbang akan lolos atau tidak. Respons sukses **wajib dimulai dengan `✅`**, bukan `⚠️`, karena `isErrorResponse` (`shared.js:27`) memperlakukan awalan `⚠️` sebagai kegagalan dan `run_full_workflow` akan berhenti.

**`waive_documentation`** — tool baru:

```js
reason: string   // wajib, 5..500 karakter
```

Prasyarat sama dengan `create_documentation` (tes sudah lulus atau di-skip). Mengisi `documentationWaived` dan `documentationWaiverReason`. Memanggil ulang mengganti alasan. Waiver muncul di output `commit_and_push`, di entri history, dan di rekomendasi.

**`check_ready_to_commit`** — satu baris checklist baru:

```
✅/❌ Documentation updated for code changes
```

`done` bila status `ok`, `waived`, `no-docs`, atau `unknown`. Signature berubah menjadi `handleReadyCheck(workflowState, context)`; `context.git` diteruskan dari kelima pemanggil: `index.js` (dispatch dan `run_full_workflow`), `commit-handlers.js:144`, dan `status-handlers.js:139`.

**`commit_and_push`** — tidak ada gerbang baru. Ia sudah memanggil `handleReadyCheck` (`commit-handlers.js:143`), jadi gerbang otomatis menutup commit. Perubahan: meneruskan `git`, dan menyimpan `lastCommitSha = pushed.head`.

**`run_full_workflow`** — dua argumen baru: `documentationFiles` (array) dan `documentationWaiverReason` (string). Gerbang diperiksa **di depan**, sebelum langkah pertama, mengikuti pola `dodEvidence` (`handler-modules/index.js:53-95`): bila `needs-docs` dan tidak ada `documentationFiles` maupun `documentationWaiverReason`, panggilan ditolak dengan daftar berkas source yang berubah. Tidak ada state yang diubah.

### Gaya pesan galat

```
❌ Documentation updated for code changes

3 berkas source berubah, tidak satu pun berkas dokumentasi:
   M  src/auth/login.js
   A  src/auth/session.js
   M  src/api/routes.js

README di repo ini: README.md — commit terakhir 14 hari lalu

Pilih satu:
 1. Perbarui README/docs, lalu:
    create_documentation { documentationType: "README",
                           files: ["README.md"], summary: "..." }
 2. Kalau perubahan ini memang tidak mengubah apa pun yang didokumentasikan:
    waive_documentation { reason: "..." }   ← alasan masuk history, bukan hilang

Tidak ada yang di-commit.
```

Baris "commit terakhir N hari lalu" berasal dari `git.getLastCommitForPath()` (helper baru, best-effort, kosong bila gagal). Ia ada karena alasan sebenarnya README tertinggal adalah tidak ada yang pernah menyadari sudah berapa lama.

Bila task dimulai sebelum gerbang ini ada (`documentationCreated: true` tetapi README tidak tersentuh), pesan menambahkan:

```
ℹ️ Task ini mungkin dimulai sebelum gerbang dokumentasi ada.
   Kalau README memang sudah benar, kecualikan dengan waive_documentation.
```

## Bagian 2 — Rekomendasi pekerjaan selanjutnya

### Prinsip

Fakta dan opini dipisah. MCP tidak pernah mengarang saran: setiap butir "fakta" punya sumber yang bisa ditunjuk. Saran agen diberi label sendiri dan tidak pernah dicampur ke daftar fakta.

### Sinyal

`collectSignals({ state, commitInspection, statusOutput, dirtyAtStart })` di `tools/handler-modules/next-steps.js`:

| Sinyal | Sumber | Prioritas |
|---|---|---|
| Item DoD berstatus `waived` | `state.definitionOfDone` | tinggi |
| Tes di-skip | `state.testsSkipped` + alasan | tinggi |
| Dokumentasi di-waive | `state.documentationWaived` + alasan | tinggi |
| Berkas kotor tertinggal (bukan milik kita) | `foreignDirtyEntries` | tinggi |
| TODO/FIXME/HACK baru di diff, maks 5, `path:line` | `commitInspection` | sedang |
| ≥3 dari 5 task terakhir bertipe `bugfix` | `state.history` | sedang |
| Diff menyentuh >15 berkas | `commitInspection` | rendah |
| Rilis di-skip | `state.releaseSkipped` + alasan | rendah |
| Dokumentasi tidak pernah bertipe README/API-docs | `state.documentationType` | rendah |

`inspectCommitDiff(sha)` adalah helper git baru: satu panggilan `git show --unified=0 --no-color` yang menghasilkan `{ paths: [], todos: [{ path, line, text }] }`. Satu panggilan, dua sinyal. Dipanggil dengan `state.lastCommitSha`; bila kosong dipakai `HEAD`. Bila gagal, sinyal diff dilewati dan output menyebut alasannya — bukan diam-diam kosong.

`buildRecommendations({ signals, aiSuggestions })` mengurutkan menurut prioritas (`tinggi` → `sedang` → `rendah`), membuang duplikat berdasarkan judul, memotong pada 6 butir, lalu menambahkan saran agen setelahnya dengan sumber `"ai"`.

### Bentuk data

Satu butir:

```js
{
  priority: "high" | "medium" | "low",
  source: "signal" | "ai",
  title: "DoD \"halaman login terverifikasi\" dilewati: butuh akun staging"
}
```

Entri history bertambah:

```js
{
  // field lama tetap
  documentation: { type, files, waived, waiverReason },
  recommendations: [ /* butir di atas */ ],
  aiSuggestions: [ "..." ]
}
```

### Permukaan tool

**`complete_task`** — parameter opsional `nextSteps: string[]`, 1..5 butir, masing-masing 10..200 karakter. Array kosong diperlakukan sebagai "tidak dikirim". Argumen yang tidak valid **ditolak dengan penjelasan**, tidak dibuang diam-diam. Handler menerima `context` untuk membaca diff commit; tanpa `git`, sinyal diff dilewati dan alasannya disebut. Respons memuat blok rekomendasi dan menyimpannya ke entri history.

**`next_steps`** — tool baru, tanpa argumen. Membaca entri history terakhir yang punya `recommendations` dan menampilkannya. Bila tidak ada: menampilkan ringkasan proyek dan menyebut terus terang bahwa belum ada rekomendasi tersimpan. History adalah berkas bersama per proyek (`workflow-state.js:908`), jadi rekomendasi terbaca dari sesi berikutnya.

Supaya agen tidak terkejut ditanya di akhir, `get_workflow_status` dan `getContinueGuidance` (`shared.js:164`) di fase `ready_to_complete` menambahkan satu baris: *"Sebelum complete_task, siapkan 'nextSteps'."*

### Bentuk render

```
🔮 Saran pekerjaan selanjutnya

Dari fakta sesi ini:
 1. [tinggi] DoD "halaman login terverifikasi" dilewati: butuh akun staging
 2. [sedang] 2 TODO baru masuk diff: src/auth/login.js:88, src/api/routes.js:41
 3. [rendah] Diff menyentuh 18 berkas — task berikutnya sebaiknya dipecah

Saran sesi ini:
 4. refreshToken belum menangani clock skew — perlu tes manual
```

Bila tidak ada sinyal sama sekali:

```
🔮 Saran pekerjaan selanjutnya

Tidak ada sinyal yang perlu ditindaklanjuti dari sesi ini.
```

Kalimat pengganti seperti "tambahkan lebih banyak tes" tidak dipakai. Rekomendasi yang selalu muncul untuk semua task akan diabaikan, dan itu merusak kepercayaan pada butir yang benar-benar penting.

## Bagian 3 — Pemeriksaan update

### Masalah

Tidak ada cara mengetahui apakah dev-workflow MCP yang sedang dipakai sudah ketinggalan versi. Dua jalur instalasi yang didukung `README.md` punya arti "update" yang berbeda, dan keduanya diam:

- instalasi lewat `git clone` (`README.md:74`) — update berarti `origin` punya commit yang belum ada di lokal
- instalasi lewat npm — update berarti `latest` di registry lebih tinggi dari `package.json`

Pada 1 November 2026 clone di mesin pemilik proyek berada di 1.15.1 sementara npm `latest` di 1.15.0: arahnya bisa dua-duanya, jadi skrip harus melaporkan keduanya, bukan menyimpulkan salah satu.

### Tujuan

Satu perintah yang menjawab "apakah saya perlu memperbarui?" dan menyebut perintah persisnya.

### Non-tujuan

- Tidak ada pemeriksaan jaringan otomatis saat MCP berjalan, dan tidak ada baris di `get_workflow_status`. Jalur tool yang dipanggil paling sering tidak boleh menunggu jaringan.
- Tidak ada pembaruan otomatis. Skrip hanya melapor.
- Tidak ada telemetri keluar.

### Kontrak skrip

`scripts/check-update.mjs`, hanya modul bawaan Node:

| Sumber | Perintah / URL | Arti |
|---|---|---|
| versi terpasang | `package.json` → `version` | yang sedang dipakai |
| clone | `git rev-parse HEAD` vs `git ls-remote origin HEAD` | SHA berbeda = clone tidak sinkron dengan remote |
| npm | `GET https://registry.npmjs.org/@programinglive/dev-workflow-mcp-server/latest` | `version` terbaru yang dirilis |

Aturan:

- Pemeriksaan git dilewati bila `.git` tidak ada (instalasi lewat npm). Pemeriksaan npm dilewati bila `fetch` tidak tersedia.
- Setiap sumber punya batas waktu 5 detik (`AbortSignal.timeout`). Kegagalan dilaporkan sebagai "tidak bisa diperiksa", tidak pernah dilempar dan tidak pernah menggantung.
- `--json` mencetak objek tunggal; tanpa flag mencetak ringkasan yang bisa dibaca manusia.
- Exit code: `0` tidak ada update, `1` ada update, `2` tidak ada satu pun sumber yang berhasil diperiksa. Exit code dipakai bila skrip dijalankan dari cron atau hook.
- Inti keputusan berupa fungsi murni `buildReport({ localVersion, npmVersion, localSha, remoteSha, errors })` yang diekspor, sehingga bisa diuji tanpa jaringan. `main()` hanya berjalan bila berkas dieksekusi langsung — pola yang sama dengan `index.js:299`.

### Format output

```
dev-workflow MCP — pemeriksaan versi

Terpasang : 1.15.1
npm latest: 1.15.0

✅ npm: versi terpasang lebih baru dari rilis publik (belum dirilis?)
✅ clone: sinkron dengan origin/main (38be409)

Tidak ada yang perlu diperbarui.
```

Bila ada update:

```
⚠️ Clone tertinggal dari origin.

Terpasang : 1.15.1
Remote    : a1b2c3d (HEAD)
Lokal     : 38be409

Perbarui:
  cd D:\code\dev-workflow-mcp-server
  git pull
  npm install
  lalu restart proses MCP (kode lama tetap di memori sampai proses mati)

Exit code 1.
```

## Tata letak modul

| Berkas | Perubahan |
|---|---|
| `tools/handler-modules/docs.js` | **baru** — klasifikasi path, `evaluateDocGate`, penyusun pesan |
| `tools/handler-modules/next-steps.js` | **baru** — `collectSignals`, `buildRecommendations`, `renderRecommendations` |
| `tools/handler-modules/next-steps-handlers.js` | **baru** — `handleNextSteps` |
| `git-helpers.js`, `git-facade.js` | `getLastCommitForPath`, `inspectCommitDiff` |
| `tools/handler-modules/workflow-handlers.js` | `handleCreateDocumentation` verifikasi `files`; `handleWaiveDocumentation`; `start_task` mengosongkan field baru |
| `tools/handler-modules/status-handlers.js` | `handleReadyCheck` terima `context`; baris checklist baru; nudge `nextSteps` |
| `tools/handler-modules/commit-handlers.js` | teruskan `git`; rekam `lastCommitSha`; `complete_task` dengan `nextSteps` |
| `tools/handler-modules/shared.js` | `getContinueGuidance` menyebut `nextSteps` |
| `tools/handler-modules/index.js` | dispatch dua tool baru; `run_full_workflow` |
| `tools/definitions.js` | `create_documentation.files`, `waive_documentation`, `next_steps`, `complete_task.nextSteps`, `run_full_workflow` |
| `workflow-state.js` | 4 field baru di tiga blok state + `load()` |
| `scripts/check-update.mjs` | **baru** — pemeriksaan clone + npm, inti murni `buildReport` |
| `package.json` | script `update:check` |

Aturan penempatan mengikuti yang sudah dipakai `dod.js`: aturan gerbang adalah fungsi murni tanpa MCP dan tanpa filesystem, supaya bisa diuji tanpa menyalakan server. Handler hanya memvalidasi, mengubah state, dan menyimpan.

## Kompatibilitas dan migrasi

- Berkas state lama tidak punya field baru → dinormalkan di `load()` seperti `dodRevision` (`workflow-state.js:885`).
- Task yang sedang berjalan saat versi baru dipasang dan sudah `documentationCreated: true` akan terblokir bila README tidak tersentuh. Pesannya menyebut kemungkinan itu dan menawarkan waiver.
- `next_steps` saat idle atau tanpa history jatuh ke ringkasan proyek, bukan error.
- `create_documentation` tanpa `files` tetap berhasil; yang berubah hanya hasil ready check.
- Pemanggil yang memanggil `handleReadyCheck(workflowState)` tanpa context mendapat status `unknown` — tidak memblokir, dengan catatan.

## Tes

| Berkas | Cakupan |
|---|---|
| `tests/docs-gate.test.js` | klasifikasi path; matriks `evaluateDocGate` (hanya source, hanya doc, keduanya, tanpa README, waived, doc kotor sejak awal, doc kotor disebut eksplisit, hanya config, hanya tes, hanya lockfile) |
| `tests/docs-gate-handlers.test.js` | `create_documentation` menolak `files[]` yang tidak nyata atau bukan dokumentasi; `waive_documentation` menolak alasan kosong/pendek; ready check memblokir; `commit_and_push` ikut memblokir; waiver tercatat di history; `run_full_workflow` menolak di depan |
| `tests/next-steps.test.js` | pengumpulan sinyal; urutan prioritas; batas 6; dedupe; kasus tanpa sinyal; kasus belum pernah commit |
| `tests/next-steps-handlers.test.js` | blok muncul di `complete_task`; validasi `nextSteps`; bentuk entri history; `next_steps` dengan dan tanpa history |
| `tests/check-update.test.js` | `buildReport` untuk keenam kombinasi versi/SHA; exit code 0/1/2; kegagalan sumber dilaporkan tanpa melempar |
| Diperbarui | `tool-definitions.test.js`, `handlers.test.js`, `handlers-workflow.test.js`, `handlers-commit.test.js`, `workflowState.test.js` |

Seluruh suite dijalankan dengan `npm test`.

## Dokumentasi yang ikut berubah

- `README.md` — tabel tool, langkah workflow, bagian gerbang dokumentasi, dan bagian pemeriksaan versi (`npm run update:check`)
- `AGENTS.md` — langkah 7 dan langkah baru untuk `next_steps`
- `.agent/workflows/dev-workflow-{feature,bugfix,refactor,full-cycle}.md` — empat berkas yang menyebut `create_documentation`
- `docs/WORKFLOW-BEST-PRACTICES.md`

## Risiko

| Risiko | Mitigasi |
|---|---|
| Gerbang memblokir repo yang dokumentasinya bukan `README*`/`docs/` | Waiver dengan alasan; pola path mencakup `.md`/`.mdx`/`.rst`/`.adoc` di mana pun kecuali direktori tes |
| Repo tanpa README tidak pernah dicek | Disengaja: status `no-docs` tidak memblokir, dan dicatat di output |
| Agen me-waive setiap task | Waiver muncul di output commit, entri history, dan rekomendasi sesi berikutnya — pola me-waive jadi terlihat, bukan tersembunyi |
| Saran menjadi derau | Maksimal 6 butir, hanya dari sinyal yang bisa ditunjuk, dan tidak ada kalimat pengisi |
| `run_full_workflow` berhenti di tengah | Gerbang diperiksa sebelum langkah pertama, seperti `dodEvidence` |
| Skrip pemeriksaan menggantung karena jaringan lambat | batas 5 detik per sumber; kegagalan jadi "tidak bisa diperiksa" dengan exit 2 |
| Skrip salah menyimpulkan arah (clone justru lebih maju dari npm) | hanya membandingkan, tidak menyimpulkan; kedua sisi dan SHA-nya disebut |

## Definisi selesai untuk spec ini

- Gerbang memblokir `check_ready_to_commit` saat source berubah tanpa berkas dokumentasi berubah, dan lolos saat berkas dokumentasi berubah atau waiver tercatat.
- `waive_documentation` menolak alasan kosong dan menyimpan alasannya di history.
- `create_documentation` menolak `files[]` yang tidak muncul di working tree.
- `next_steps` mengembalikan rekomendasi tersimpan; `complete_task` menampilkan dan menyimpannya.
- `npm run update:check` melaporkan keadaan clone dan npm, dengan exit code 0/1/2 sesuai kontrak.
- `npm test` lulus seluruhnya.
- `README.md`, `AGENTS.md`, dan empat `.agent/workflows/` menyebut perilaku baru.
- Rilis 1.16.0 tercatat.
