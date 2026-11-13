# Definition of Done Lokal untuk dev-workflow MCP — Design

**Tanggal:** 2026-10-31
**Status:** Menunggu review spec
**Repo:** `C:\Users\<username>\Documents\code\dev-workflow-mcp-server` (v1.13.16, salinan yang benar-benar dijalankan MCP server)
**Rilis yang direncanakan:** 1.14.0 (minor)

## Ringkasan

Factory (`factory.programinglive.com`) sudah punya `definitionOfDone` per task: checklist kondisi konkret yang wajib ada sebelum task boleh `done`. dev-workflow MCP belum punya padanannya — gerbangnya masih boolean yang di-set sendiri oleh agen (`tools/handler-modules/status-handlers.js:46`).

Spec ini menambah DoD lokal: item per item, bukti wajib, jalan waive dengan alasan, dan penguncian pada `check_ready_to_commit`, `commit_and_push`, serta `complete_task`.

## Masalah

`handleReadyCheck` memutuskan kesiapan dari enam baris boolean yang di-set agen untuk dirinya sendiri: feature flow, bug fixed, tests created, tests passed, documentation created. Tidak satu pun menyebut *apa* yang harus benar. Agen bisa sampai ke `commit_and_push` padahal kondisi konkret task-nya (build lulus, halaman login terverifikasi di tenant nyata, migrasi bisa di-rollback) belum pernah dinyatakan, apalagi dibuktikan.

Papan Factory sudah menyelesaikan ini untuk task papan: `definition_of_done` adalah kolom terpisah, wajib saat pembuatan, dan `move_task → done` ditolak selama kosong (`app/api/factory/route.ts:112` di `D:\code\factory`). dev-workflow MCP hanya meniru itu untuk tool Factory *remote* (`create_factory_task`, `update_factory_task`) — workflow lokal tidak punya apa pun.

Celah yang perlu disebut: `handleCompleteTask` (`tools/handler-modules/commit-handlers.js:304`) saat ini tidak melakukan pemeriksaan apa pun. Ia menutup task pada panggilan apa saja.

## Tujuan

Setiap task lokal membawa daftar kondisi konkret. Tiap kondisi **dibuktikan** (ditandai dengan bukti) atau **dikecualikan** (dengan alasan tertulis). Ready check, commit, dan complete menolak berjalan selama ada kondisi yang belum terpenuhi.

## Non-tujuan

- Tidak ada fase workflow baru. DoD adalah prasyarat di dalam ready check yang sudah ada.
- Tidak ada push balik DoD lokal ke papan Factory. Hanya tarik (`claim_factory_task`), karena penulisan ke papan sudah punya jalur resmi (`update_factory_task`).
- Tidak ada UI persetujuan manusia. `force_complete_task` tetap menjadi jalan keluar yang tercatat.
- Dashboard web (`web/`) tidak disentuh pada versi ini.

## Model data

Field state baru, ditambahkan di tiga tempat yang membentuk state segar (`workflow-state.js:637` constructor, `:682` `useSession`, `:1251` `reset`):

```js
definitionOfDone: [],   // item, lihat di bawah
dodSource: "",          // "" | "manual" | "factory"
dodFactoryTaskId: "",   // recordId Factory saat ditarik dari papan
dodRevision: 0,         // naik saat ada perubahan kerja baru setelah commit
```

Satu item:

```js
{
  id: "dod-1",          // stabil: 1 + suffix numerik tertinggi yang ada
  text: "build lulus",  // 3..300 karakter setelah trim
  status: "open",       // "open" | "done" | "waived"
  evidence: "",         // wajib (5..500) saat status "done"
  waivedReason: "",     // wajib (5..500) saat status "waived"
  revision: 0,          // dodRevision saat item dibuktikan/dikecualikan
  updatedAt: "2026-10-31T10:00:00.000Z"
}
```

Satu definisi cukup untuk semua konsumen:

```
isSatisfied(item) := item.status === "waived"
                  || (item.status === "done" && item.revision === state.dodRevision)
```

Batas: 1–20 item per task; teks 3–300 karakter setelah trim; duplikat ditolak case-insensitive; daftar kosong tidak pernah sah.

### Normalisasi dan migrasi

`load()` sudah menormalkan field skalar (`workflow-state.js:762`). Perlakuan sama untuk DoD: bukan array → `[]`; entri yang bukan objek atau teksnya kosong dibuang; status asing → `"open"`; `evidence` / `waivedReason` hilang → `""`; `dodRevision` bukan angka → `0`; id duplikat atau hilang diberi ulang berurutan.

Berkas state yang ditulis sebelum rilis ini tidak punya field DoD, sehingga dinormalkan ke default kosong. Itu kasus legacy: task yang sudah berjalan tampil dengan nol item dan diblokir gerbang sampai `set_definition_of_done` mengisinya. Tidak ada yang diberikan diam-diam.

## Kebasian: aturan revisi

`resetToCommitIfWorkingChanges` (`tools/handler-modules/shared.js:30`) sudah mendeteksi perubahan kerja baru setelah commit tercatat dan mengembalikan workflow ke `commit`. Perluas: **naikkan `dodRevision`** pada transisi itu. Setiap item `done` lalu berhenti memenuhi `isSatisfied`, sehingga agen harus mengonfirmasi ulang terhadap kode yang benar-benar di-commit. Item `waived` bertahan melewati kenaikan revisi, karena waiver adalah keputusan, bukan bukti.

Alasan memakai penghitung revisi alih-alih mengembalikan item ke `open`:

- `mergeMonotonicProgress` (`workflow-state.js:863`) menggabungkan kemajuan **maju-saja** antar-proses MCP untuk task yang sama. Mengubah status ke bawah akan melawan merge itu, dan aturan "status tertinggi menang" di bawah akan membangkitkan `done` lama.
- Penghitung tingkat task dibandingkan dengan nilai yang tersimpan di item, jadi tidak ada yang perlu ditulis ulang dan tidak ada bukti yang dihancurkan.
- Tampilan tetap jujur: item mempertahankan status `done` *dan* bukti lamanya, lalu dilaporkan sebagai `perlu konfirmasi ulang` sampai ditandai lagi.

Menandai ulang item yang hanya basi adalah panggilan yang sudah dipakai agen: `mark_dod_item`. Tidak ada transisi lain yang menaikkan `dodRevision`; `mark_bug_fixed`, `run_tests`, dan `create_documentation` tidak menyentuh DoD, karena keduanya adalah langkah *di dalam* badan pekerjaan yang sama, bukan perubahan baru setelah commit.

Merge antar-proses: tambahkan `mergeDefinitionOfDone(reconciled)` di samping `mergeMonotonicProgress`, hanya diterapkan bila deskripsi task di disk sama dengan milik kita. Per id, pertahankan entri yang lebih tinggi menurut `(statusRank, revision)`, dengan `done = 2, waived = 1, open = 0`. Item yang hanya ada di memori tetap disimpan; item yang hanya ada di disk juga disimpan. Ini mencegah proses basi menghapus bukti yang baru dicatat proses lain.

## Permukaan tool

| Tool | Perubahan |
|---|---|
| `start_task` | Field **wajib** baru `definitionOfDone: string[]` (1–20 item). Divalidasi `validateItems`; kegagalan mengembalikan daftar aturan dan contoh dua baris. Perilaku `projectDir` tidak berubah. |
| `set_definition_of_done` **(baru)** | `{ items: string[], append?: boolean, reason?: string }`. Ditolak saat workflow idle. Default (`append` false) mengganti seluruh daftar dan **ditolak** bila ada item `done` atau `waived` — pesannya menawarkan `append: true` atau waive, bukan membuang bukti diam-diam. `append: true` menambah item sampai batas 20. Mengisi `dodSource: "manual"` kecuali sumbernya sudah `"factory"`, dalam hal mana `dodFactoryTaskId` dipertahankan. Mengosongkan `readyCheckCompleted`. |
| `mark_dod_item` **(baru)** | `{ id, evidence }`. `evidence` wajib, 5–500 karakter. `open → done`. Menandai ulang item `done` idempoten dan menyegarkan evidence plus `revision` (inilah jalur konfirmasi ulang item basi). Item `waived` ditolak: kembalikan lewat `set_definition_of_done` dengan `append: true` bila memang urgen lagi. Mengosongkan `readyCheckCompleted`. |
| `waive_dod_item` **(baru)** | `{ id, reason }`. `reason` wajib, 5–500 karakter. `open → waived`. Item `done` ditolak (`sudah terbukti, tidak ada yang perlu dikecualikan`). Mengosongkan `readyCheckCompleted`. |
| `get_workflow_status` | Blok baru: `DoD: 2/4 selesai, 1 dilewati, 1 terbuka`, lalu satu baris per item dengan bukti atau alasan waiver. Sumber ditampilkan bila berasal dari papan. |
| `check_ready_to_commit` | Dua baris baru: `Definition of done recorded (>= 1 item)` dan `Definition of done satisfied (0 outstanding)`. |
| `commit_and_push` | Guard eksplisit sebelum `git add .`: tolak dengan id dan teks item yang masih terbuka. Panggilan ready check yang sudah ada memang menutupi ini secara transitif; guard eksplisit ada supaya pesannya menyebut itemnya, bukan hanya "NOT READY". |
| `complete_task` | Guard baru: tolak selama ada item terbuka atau daftarnya kosong. `force_complete_task` tetap menjadi bypass dan mencatat `forced: true` plus `dodSummary`. |
| `claim_factory_task` | Parse `definitionOfDone` papan menjadi item: `dodSource: "factory"`, `dodFactoryTaskId: recordId`, `dodRevision: 0`. Baris pemberitahuan di respons menyebut berapa item yang diimpor. |
| `run_full_workflow` | Menerima dan meneruskan `definitionOfDone`, karena ia memandu langkah yang sama. |
| `rerun_workflow` | Saat ini memanggil `reset()` dan hanya memulihkan deskripsi serta tipe task (`status-handlers.js:138`), yang akan diam-diam membuang setiap item DoD dan mengunci task selamanya. Perilaku baru: bawa `definitionOfDone`, `dodSource`, `dodFactoryTaskId`, dan `dodRevision` melewati reset, dan sebutkan di respons bahwa item yang sudah terbukti dipertahankan. |

Saat task ditutup, `complete_task`, `force_complete_task`, dan `drop_task` mencatat `dodSummary: { total, done, waived, open, waivedReasons }` pada entri `history`, sehingga project summary dan `view_history` bisa menunjukkan apa yang benar-benar dibuktikan.

### Baris gerbang setelah perubahan

```
Task started
Feature flow described
Definition of done recorded (>= 1 item)          <- baru
Feature/bug fixed
Tests created / Tests passed
Documentation created
Definition of done satisfied (0 outstanding)     <- baru
```

`allDone` membutuhkan kedua baris baru. DoD tidak pernah memindahkan `currentPhase` sendiri; ia hanya memutuskan lolos atau tidaknya ready check.

## Tarik dari Factory

`claim_factory_task` sudah membaca `task.definitionOfDone` untuk ditampilkan (`factory-handlers.js:153`). Ganti tampilan itu dengan import nyata lewat `parseFactoryChecklist`:

- `^\s*[-*+]\s*\[[ xX]\]\s*(.+)$` → item, **selalu diimpor sebagai `open`**. Checklist papan adalah rencana, bukan bukti; agen tetap harus membuktikan tiap baris secara lokal.
- `^\s*[-*+]\s+(.+)$` → item.
- Heading `^#{1,6}\s`, baris kosong, dan paragraf prosa → diabaikan.
- Teks di-trim, dipotong 300 karakter, dibatasi 20 item. Bila pemotongan terjadi, respons menyebutkannya secara eksplisit alih-alih membuang diam-diam.
- Hasil kosong → `dodSource: ""` dan peringatan bahwa task papan tidak punya DoD, sehingga agen harus menjalankan `set_definition_of_done`.

`sync_task_status` sudah membaca ulang checklist papan setelah perubahan status; tidak perlu perubahan.

## Tata letak modul

- `tools/handler-modules/dod.js` — fungsi murni, tanpa MCP dan tanpa filesystem: `validateItems`, `normalizeItems`, `parseFactoryChecklist`, `renderChecklist`, `summarize`, `openItems`, `isSatisfied`, `nextItemId`, `mergeDefinitionOfDone`.
- `tools/handler-modules/dod-handlers.js` — `handleSetDefinitionOfDone`, `handleMarkDodItem`, `handleWaiveDodItem`. Tipis: validasi, mutasi `workflowState.state`, `save()`, kembalikan `textResponse`.
- Penyambungan: `tools/definitions.js` (skema), `tools/handler-modules/index.js` (case switch), `workflow-state.js` (field, normalisasi, merge, kenaikan revisi), `status-handlers.js` (baris gerbang, tampilan status), `commit-handlers.js` (guard, ringkasan history), `factory-handlers.js` (import saat claim).

## Gaya pesan galat

Setiap penolakan bisa ditindaklanjuti dan memakai suara yang sudah dipakai server (Indonesia, konkret): sebut aturannya, tampilkan nilai yang bermasalah, dan tunjuk panggilan berikutnya.

```
⚠️ Item DoD "dod-3" masih terbuka: "migrasi bisa di-rollback".
Buktikan dengan 'mark_dod_item' { id: "dod-3", evidence: "..." },
atau kecualikan dengan 'waive_dod_item' { id: "dod-3", reason: "..." }.
```

## Tes

Baseline terukur sebelum perubahan: `npm test` → 450 tes, 448 pass, 2 skipped, 0 fail.

Baru:

- `tests/dod.test.js` — fungsi murni: parse checklist Factory untuk `- [ ]`, `- [x]`, `* [ ]`, butir tanpa kotak, heading, prosa, baris kepanjangan, lebih dari 20 baris; deteksi duplikat case-insensitive; pemberian ulang id; `isSatisfied` untuk semua kombinasi status × revisi; `renderChecklist` bolak-balik.
- `tests/dod-handlers.test.js` — seluruh cerita gerbang: `start_task` dengan DoD kosong/hilang/duplikat; `mark_dod_item` tanpa evidence; `waive_dod_item` pada item `done`; `set_definition_of_done` menolak membuang item terbukti; ready check gagal karena satu item terbuka dan lolos setelah dibuktikan; `commit_and_push` menolak sebelum staging; `complete_task` menolak saat ada item terbuka; `force_complete_task` lolos dan mencatat `forced: true` plus `dodSummary`; `claim_factory_task` mengimpor dari client Factory yang di-mock; state lama tanpa field DoD terblokir lalu lolos setelah `set_definition_of_done`; kenaikan revisi memaksa konfirmasi ulang sementara waiver bertahan.

Diperbarui: 15 pemanggilan `start_task` yang ada di `tests/project-dir-resolution.test.js` (3), `tests/shared-state.test.js` (3), `tests/session-metadata.test.js` (5), `tests/session-metadata-e2e.test.js` (2), dan `tests/security-boundaries.test.js` (2) — lewat satu helper di `tests/test-helpers.js` supaya daftar fixture ada di satu tempat. Assertion yang mencocokkan teks checklist ready-check mendapat dua baris baru.

`npm test` harus hijau sebelum commit; server MCP sendiri yang menegakkannya, dan itu memang intinya.

## Dokumentasi

`AGENTS.md` (repo) — sepuluh langkah menjadi dua belas: DoD disuplai di `start_task`, item dibuktikan selama implementasi. `README.md`, `docs/software-factory.md` (paritas dengan papan Factory, dan di mana keduanya berbeda: DoD lokal per item dan berbasis bukti), `CHANGELOG.md`, `docs/PRD.md` (wajib untuk `create_documentation`).

Salinan aturan di `C:\Users\<username>\Documents\Default Project\AGENTS.md` juga menjelaskan sepuluh langkah. Berkas itu di luar repo ini; memperbaruinya adalah tindak lanjut terpisah yang perlu disetujui eksplisit.

## Risiko

- **Gesekan.** Gerbang per item yang ketat bisa memperlambat pekerjaan sepele. Mitigasi sudah ada di desain: `waive_dod_item` dengan alasan, dan `force_complete_task` yang mencatat `forced: true`.
- **Churn tes.** 15 call-site berubah; memakai satu helper menjaga diff tetap mekanis.
- **Kualitas bukti.** Evidence adalah teks bebas; tidak ada yang memverifikasi perintah yang dikutip benar-benar dijalankan. Gerbang menaikkan biaya klaim palsu dan meninggalkan jejak di `history`, yang merupakan plafon realistis untuk server MCP lokal. Verifikasi otomatis akan butuh worker, bukan server ini.
- **Dua proses MCP, task sama.** Ditangani `mergeDefinitionOfDone`; alternatifnya (array digabung last-write) bisa menghapus bukti.

## Definisi selesai untuk spec ini

- `npm test` hijau dengan suite baru disertakan.
- `start_task` tanpa `definitionOfDone` gagal dengan pesan yang menyebut field dan aturannya.
- Task dengan satu item terbuka tidak bisa lolos `check_ready_to_commit`, tidak bisa `commit_and_push`, dan tidak bisa `complete_task`.
- Menjalankan waive pada item itu dengan alasan membuka ketiganya, dan waiver muncul di `get_workflow_status`, di `dodSummary` entri `history`, dan di langkah dokumentasi task.
- Task yang di-claim dari papan datang dengan item DoD yang diimpor sebagai `open`.
- Perubahan kerja baru setelah commit membuat setiap item yang sudah dibuktikan menjadi basi, dan ready check menyebutkannya.
