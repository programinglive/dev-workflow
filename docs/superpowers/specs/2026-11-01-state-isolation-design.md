# Isolasi State per Sesi dan per Proyek — Design

**Tanggal:** 2026-11-01
**Status:** Selesai — diimplementasikan dan dirilis sebagai 1.17.0 (commit `7954504`)
**Repo:** `D:\code\dev-workflow-mcp-server`
**Rilis yang direncanakan:** 1.17.0 (minor)

## Ringkasan

State workflow disimpan dalam satu berkas per proyek. Itu tidak cukup: dua jendela OpenCode pada proyek yang sama tetap berbagi satu berkas, dan di mesin ini satu berkas bahkan dipakai bersama oleh proyek yang berbeda. Akibatnya `start_task` di satu sesi menghapus Definition of Done sesi lain yang masih berjalan.

Spec ini memindahkan state ke satu berkas **per sesi di dalam direktori proyek**, menyimpan history di tingkat proyek, dan membuat `start_task` menolak menghapus task hidup milik proses lain — termasuk saat `force: true`.

## Masalah

### Bukti 1: perbaikan per-proyek tidak memisahkan sesi

`resolveStateFile({ sessionId })` dengan `DEV_WORKFLOW_STATE_FILE` terpasang:

```js
const target = path.join(baseDir, PROJECTS_DIR, projectKey(projectRoot), STATE_FILENAME);
```

`sessionId` diterima sebagai parameter lalu **tidak dipakai**. Diukur pada 1 November 2026:

```
cwd=clinic (repo)
  sesi A -> .state\projects\clinic-27dfe19c80\workflow-state.json
  sesi B -> .state\projects\clinic-27dfe19c80\workflow-state.json
  SAMA BERKAS? true
```

Dua sesi, satu berkas. Perbaikan 1 November 2026 (`docs/2026-11-01-state-per-project.md`) memisahkan *proyek*, bukan *sesi*.

### Bukti 2: identitas sesi sudah tersedia dan sudah terbukti sampai ke disk

`handleToolCall` membaca `request.params._meta["ai.opencode/sessionID"]` (`workflow-state.js:535`) dan memanggil `workflowState.useSession(sessionId)` (`index.js:63`, `tools/handler-modules/index.js:248`). Ada tes e2e yang memaksa dua `_meta` berbeda menghasilkan dua berkas (`tests/session-metadata-e2e.test.js:81`), dan buktinya ada di disk:

```
.state/users/*/workflow-state.ses_e6f3f146fffdUkCQUiSxpb75W6.json
```

Jadi bahannya sudah ada; yang membuangnya hanya jalur pin.

### Bukti 3: `force: true` menghapus task hidup

Pada 1 November 2026 satu sesi kehilangan seluruh DoD-nya dua kali dalam satu jam. Penyebabnya bukan hanya tabrakan berkas:

- `start_task` memanggil `reset({ archive: true })` yang mengosongkan state, termasuk `definitionOfDone`, `documentationFiles`, dan `dodRevision`.
- Penjaga `activeForeignLock` **bisa dilewati** dengan `force: true`. Sesi yang memaksa tetap menghapus task proses lain yang sedang berjalan.
- `reconcileWithDisk` memang mengarsipkan task asing ke `history` sebagai `interrupted`, tetapi state aktifnya tetap hilang. Bukti DoD yang sudah dikumpulkan tidak bisa dipulihkan dari arsip itu.

### Bukti 4: penjaga akan kembali global kalau tata letak diubah tanpa hati-hati

`projectLockDir` mendeteksi tata letak per proyek hanya pada satu kedalaman:

```js
if (path.basename(path.dirname(current)) === "projects") {
  return current;
}
```

Dengan tata letak baru `<dasar>/projects/<proyek>/users/<user>/`, induk direktori bernama `users`, bukan `projects`. Fungsi ini akan jatuh ke loop dan naik sampai `.state` — satu lock untuk semua proyek, persis bug yang diperbaiki 1 November 2026. Hal yang sama berlaku untuk `resolveHistoryFile`, yang memakai penanda `users` untuk memutuskan apakah history dipisahkan.

### Bukti 5: restart tidak cukup — dua sebab

Setelah OpenCode di-restart pada 1 November 2026 pukul 14:11, masalahnya **masih ada**. Dua sebab, keduanya terukur:

**a. Proses MCP lama tidak mati.** OpenCode tidak membunuh proses anak saat restart. Pada 14:14 masih hidup dua proses `dev-workflow-mcp-server\index.js`:

```
PID 10696  mulai 10:29:10  ← kode lama, masih memegang koneksi sesi ini
PID 18476  mulai 14:11:15  ← kode baru, memegang mcp-process.lock
```

Sesi ini dilayani PID 10696: daftar tool-nya tidak memuat `waive_documentation` maupun `next_steps`, yang ada hanya di kode baru. Skrip `cleanup-stale-mcp.mjs` di repo `infra-knowledge-mcp-server` mengonfirmasi hal yang sama untuk tiga server sekaligus. Akibatnya restart memberi proses baru, tetapi sesi tetap memakai kode lama.

**b. Pin tidak mengisolasi saat cwd bukan repo.** Jalur pin hanya membentuk `projects/<proyek>/` bila `findProjectRoot(cwd)` menemukan repo. Direktori kerja sesi ini (`C:\Users\<username>\Documents\Default Project`) bukan repo, jadi fungsinya mengembalikan berkas pin apa adanya:

```
cwd = C:\Users\<username>\Documents\Default Project (bukan repo)
  sesi A -> .state\workflow-state.json
  sesi B -> .state\workflow-state.json
  SAMA BERKAS? true
```

Itu persis satu berkas bersama untuk seluruh mesin. Selama direktori kerja sesi bukan repo, isolasi per proyek tidak pernah aktif — berapa kali pun di-restart.

## Tujuan

- Dua sesi pada proyek yang sama tidak pernah berbagi berkas state.
- Dua proyek tidak pernah berbagi berkas state, bahkan bila keduanya berjalan dari direktori kerja yang sama.
- Isolasi per sesi tetap berlaku walau direktori kerja sesi bukan repo git — jalur cadangan tidak boleh mengembalikan satu berkas bersama.
- History tetap satu per proyek, sehingga rekomendasi dan riwayat terbaca lintas sesi.
- `start_task` tidak bisa menghapus task yang sedang berjalan di proses lain, termasuk dengan `force: true`.

## Non-tujuan

- Tidak ada UI atau perintah baru untuk "melihat state sesi lain". State yang terpisah berarti tidak perlu melihat.
- Tidak mengubah format isi state. Berkas tetap JSON dengan field yang sama.
- Tidak menyentuh `web/` atau database SQLite.
- Tidak menyelesaikan masalah commit salah arah (`projectDir`); itu sudah ditangani terpisah.

## Tata letak baru

```
<dasar>/projects/<proyek>-<hash>/
    workflow-state.json                      ← history bersama proyek
    project-summary.json                     ← ringkasan proyek
    mcp-process.lock                         ← penjaga per proyek
    users/<user>/
        user-id
        workflow-state.<sesi>.json           ← state per sesi
        project-summary.json
```

Aturan:

| Berkas | Cakupan | Alasan |
|---|---|---|
| `workflow-state.<sesi>.json` | sesi | DoD, fase, dan bukti tidak boleh saling menghapus |
| `workflow-state.json` (di akar proyek) | proyek | history dan rekomendasi harus terbaca sesi berikutnya |
| `mcp-process.lock` | proyek | penjaga "satu penulis" harus menyala untuk proyek yang sama, bukan untuk semua proyek |
| `project-summary.json` | proyek | ringkasan aktivitas lintas sesi |

## Perubahan kode

### `resolveStateFile` (`workflow-state.js:607`)

Ada dua jalur yang harus diperbaiki, bukan satu.

**Jalur A — proyek dikenali.** Berubah dari:

```js
const target = path.join(baseDir, PROJECTS_DIR, projectKey(projectRoot), STATE_FILENAME);
```

menjadi:

```js
const projectDir = path.join(baseDir, PROJECTS_DIR, projectKey(projectRoot));
const userDir = getUserScopedDir(projectDir);          // <proyek>/users/<user>
const target = path.join(userDir, sessionStateFilename(process.env, sessionId));
migrateProjectStateToSession(projectDir, target, projectRoot);
return target;
```

**Jalur B — proyek TIDAK dikenali** (`projectRoot` null, direktori kerja bukan repo). Sekarang ia mengembalikan `resolvedCustom` apa adanya — satu berkas untuk semua sesi. Aturan baru: tetap bentuk direktori proyek dari **direktori kerja**, dengan kunci yang stabil dan bisa ditebak:

```js
const fallbackRoot = path.resolve(process.env.INIT_CWD || process.cwd());
const projectDir = path.join(baseDir, PROJECTS_DIR, projectKey(fallbackRoot));
// lalu sama seperti jalur A
```

`projectKey` sudah menambahkan potongan hash dari path, jadi dua direktori kerja berbeda tidak bertabrakan. Komentar lama di `workflow-state.js:624` sengaja menolak jatuh ke direktori modul; aturan ini tidak melakukannya — ia memakai direktori kerja pemanggil, yang memang satu-satunya identitas yang tersedia.

`sessionStateFilename` sudah ada dan sudah dipakai jalur non-pin, jadi tidak ada nama berkas baru yang perlu diingat.

### Identitas user: satu berkas, satu jangkar

`getUserScopedDir(baseDir)` memanggil `resolveUserId(baseDir)`, dan `resolveUserId` **menulis** `user-id` ke `baseDir`. Kalau dipanggil dengan `baseDir = <proyek>`, berkasnya mendarat di `<proyek>/user-id`.

Sementara itu `getCurrentUserId(stateFile)` (`workflow-state.js:278`) membaca `user-id` dari `path.dirname(stateFile)` — untuk tata letak baru itu `<proyek>/users/<user>/user-id`. Dua jalur, dua lokasi, dua nilai yang bisa berbeda. Akibatnya `syncToDatabase` bisa mencatat baris dengan `user_id` yang bukan milik sesi itu — persis kelas bug 30 Oktober 2026 yang menghasilkan 150 baris duplikat.

Aturan yang dipakai: **satu `user-id` per proyek, di `<proyek>/user-id`.** `getCurrentUserId` naik satu tingkat dari `users/<user>/` ke `<proyek>` dan membaca berkas di sana; bila tidak ada, ia memanggil `resolveUserId(<proyek>)` yang menulisnya di tempat yang sama. `resolveStateFile` memakai jangkar yang sama, sehingga hanya ada satu sumber kebenaran.

### `resolveHistoryFile` (`workflow-state.js:571`)

Sekarang: bila induk direktori bernama `users`, kembalikan `dir/workflow-state.json` (history per user). Untuk tata letak baru itu salah — history harus di akar proyek. Aturan baru:

```
bila path cocok dengan `<...>/projects/<proyek>/users/<user>/<berkas>`
    -> `<...>/projects/<proyek>/workflow-state.json`
selain itu perilaku lama dipertahankan
```

Deteksi dilakukan dengan mencari segmen `projects` diikuti satu segmen proyek, bukan dengan menghitung `dirname` berkali-kali — alasan yang sama dengan `resolveProjectRootForState` (`workflow-state.js:589`): kedalaman berubah, dan angka `dirname` diam-diam menghasilkan root yang salah.

### `projectLockDir` (`process-lock.js:41`)

Deteksi `projects` harus bekerja pada kedalaman mana pun:

```js
// Naik sampai menemukan direktori yang induknya bernama "projects".
let current = path.dirname(path.resolve(stateFilePath));
while (true) {
  if (path.basename(path.dirname(current)) === "projects") return current;
  const parent = path.dirname(current);
  if (parent === current) break;
  current = parent;
}
// lalu aturan lama: cari ".state", kalau tidak ada pakai direktori berkas
```

Untuk `<proyek>/users/<user>/` ini berhenti di `<proyek>` — penjaga kembali sejauh proyek, bukan sejauh mesin.

### Migrasi

`migrateProjectStateToSession(projectDir, targetPath, projectRoot)`, dipanggil sekali saat resolusi:

1. Bila `<proyek>/workflow-state.json` tidak ada, atau `targetPath` sudah ada → tidak melakukan apa pun.
2. Baca berkas lama; bila `projectDir` di dalamnya bukan proyek ini → tidak melakukan apa pun (state milik proyek lain tidak boleh dipindahkan).
3. Bila `currentPhase === "idle"` dan `taskDescription` kosong → salin ke `targetPath`. State menganggur aman dipindahkan.
4. Bila ada task aktif → **jangan** salin. Biarkan berkas lama, dan catat di `history` bahwa ada state lama yang tidak dipindahkan beserta deskripsi task-nya. Pengguna melihatnya lewat `get_workflow_status`.

Berkas lama tidak pernah dihapus. Ia menyimpan riwayat era sebelumnya, dan menghapusnya adalah tindakan yang tidak bisa dibatalkan.

**Dua sesi menyalin serempak.** Dua sesi bisa memanggil migrasi pada saat yang sama untuk proyek yang sama. Karena isi yang disalin identik, penulis terakhir menang dan hasilnya tetap benar. Tetap dipakai `writeFileSync(targetPath, data, { flag: "wx" })`: penulisan gagal bila berkas sudah ada, dan kegagalan itu diabaikan. Tanpa `wx`, sesi kedua bisa menimpa state yang sudah mulai diisi sesi pertama.

### `start_task` menolak menghapus task hidup (`tools/handler-modules/workflow-handlers.js:91`)

Penjaga baru, diperiksa **sebelum** `reset()` dan **tidak bisa dilewati** `force`:

```
bila state di disk punya task aktif (phase !== "idle" dan taskDescription tidak kosong)
dan owner.processMarker di disk bukan milik proses ini
dan proses pemilik itu masih hidup
maka tolak, dan sebutkan:
   - deskripsi task yang sedang berjalan
   - fase terakhirnya
   - pid pemiliknya
   - tiga pilihan: tutup sesi itu, pakai worktree, atau drop_task dari sesi tersebut
```

`force: true` tetap berguna untuk satu kasus: proses pemilik sudah mati (penanda basi). Perilaku itu dipertahankan.

Perbedaan dengan penjaga `activeForeignLock` yang ada: penjaga itu membandingkan **berkas lock**, sedangkan penjaga baru membandingkan **isi state**. State adalah kebenaran; berkas lock hanya petunjuk. Kalau lock hilang atau rusak, penjaga baru tetap bekerja.

## Kompatibilitas

- Berkas state lama di `.state/users/<user>/` dan `.state/projects/<proyek>/` tetap terbaca. Migrasi hanya menyalin, tidak memindahkan.
- Sesi yang sedang berjalan saat versi baru dipasang: setelah restart, state menganggur dipindahkan; state dengan task aktif dibiarkan dan dilaporkan. Tidak ada DoD yang hilang diam-diam.
- `DEV_WORKFLOW_STATE_FILE` tetap berarti *direktori dasar*. Artinya berubah dari "satu berkas untuk semua" menjadi "akar tempat proyek dan sesi ditata", dan itu sudah begitu sejak 1 November 2026.

## Tes

| Berkas | Cakupan |
|---|---|
| `tests/state-per-session.test.js` | dua `sessionId` berbeda menghasilkan dua path berbeda; keduanya di bawah `projects/<proyek>/users/`; history keduanya menunjuk berkas yang sama |
| `tests/state-nonrepo-cwd.test.js` | dengan direktori kerja yang bukan repo, dua `sessionId` tetap menghasilkan dua berkas berbeda di bawah `projects/`, bukan satu berkas pin bersama |
| `tests/state-history-scope.test.js` | `resolveHistoryFile` mengembalikan berkas akar proyek untuk tata letak baru, dan perilaku lama untuk tata letak `.state/users/` |
| `tests/state-migration.test.js` | state idle disalin; state dengan task aktif tidak disalin dan dilaporkan; state milik proyek lain tidak disentuh; berkas lama tetap ada |
| `tests/process-lock-depth.test.js` | `projectLockDir` berhenti di `<proyek>` untuk `projects/<p>/users/<u>/`, untuk `projects/<p>/`, dan tetap benar untuk `.state/users/<u>/` |
| `tests/start-task-live-guard.test.js` | `start_task` menolak saat task aktif milik proses hidup; menolak walau `force: true`; mengizinkan saat pemilik sudah mati; mengizinkan saat phase `idle` |
| `tests/state-user-id-anchor.test.js` | `user-id` ditulis di `<proyek>/user-id`, dan `getCurrentUserId` untuk `<proyek>/users/<user>/...` mengembalikan nilai yang sama — bukan id baru yang berbeda |

## Risiko

| Risiko | Mitigasi |
|---|---|
| Semua orang kehilangan state saat upgrade | Migrasi hanya menyalin, berkas lama dipertahankan, dan state bertask aktif tidak dipindahkan |
| Penjaga jadi terlalu ketat dan memblokir sesi sah | Penjaga hanya menyala bila pemilik masih hidup **dan** phase bukan idle; `drop_task` dari sesi pemilik membuka jalannya |
| `projectLockDir` kembali global | Tes kedalaman khusus, karena ini regresi yang pernah terjadi |
| History terpecah per sesi | `resolveHistoryFile` punya tes sendiri yang menagih berkas akar proyek |
| Baris database tercatat dengan `user_id` salah | Satu jangkar `user-id` per proyek, dengan tes yang membandingkan kedua jalur pembacaan |
| Isolasi tidak aktif karena direktori kerja bukan repo | Jalur cadangan membentuk direktori proyek dari direktori kerja, dengan tes khusus |

## Definisi selesai untuk spec ini

- Dua sesi pada proyek yang sama menghasilkan dua berkas state, satu history.
- `projectLockDir` berhenti di direktori proyek untuk tata letak baru.
- `start_task` menolak menghapus task aktif milik proses hidup, termasuk dengan `force: true`.
- Migrasi tidak menghapus berkas lama dan tidak memindahkan state bertask aktif.
- `user-id` hanya punya satu lokasi per proyek, dan kedua jalur pembacaan sepakat.
- Direktori kerja yang bukan repo tetap menghasilkan berkas terpisah per sesi.
- `npm test` lulus seluruhnya.
