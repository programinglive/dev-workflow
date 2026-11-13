> **Catatan (2 November 2026):** dokumen ini merekam keadaan saat ditulis dan
> **sudah tidak berlaku lagi**. Sejak rilis 1.20.0, sumber kebenaran state
> adalah SQLite lokal (`.state/dev-workflow.db`), dan berkas JSON hanya menjadi
> ekspor cadangan. Tata letak yang berlaku ada di `docs/state-storage.md`.
>
> Catatan sebelumnya (1 November 2026): sejak 1.17.0/1.18.0 state dipisah per
> SESI di bawah `projects/<proyek>/users/<user>/`, dan rencana kerja ikut
> disimpan.

# State workflow dipakai bersama antar sesi: apa yang diperbaiki

Tanggal: 27 Oktober 2026

## Masalah

Berkas state workflow disimpan **per user OS**, bukan per sesi agen:

```
<root>/.state/user-id                                  -> user-1a171645d22-788e41b9
<root>/.state/users/<user-id>/workflow-state.json      -> satu untuk SEMUA sesi
```

Dua sesi OpenCode di mesin yang sama berbagi berkas itu. Akibatnya:

1. `start_task` di sesi B memanggil `reset()` yang **mengganti seluruh state**
   sesi A. Pekerjaan A hilang.
2. `history` hanya ditulis saat task **ditutup** (`complete_task`,
   `force_complete_task`, `drop_task`). Task yang ditinggalkan di tengah jalan
   **tidak pernah masuk history** — lenyap tanpa jejak.
3. `taskDescription` dan `lastCommitMessage` dipakai `commit_and_push`, sehingga
   sesi B bisa membuat commit dengan pesan milik sesi A, atau menutup task A.

### Kejadian nyata

26–27 Oktober 2026, saat resize `docker-alma`:

- Task `Kecilkan RAM docker-alma...` dijalankan, semua langkah selesai
  (60 tes lulus, dokumentasi, ready check).
- `get_workflow_status` menampilkan task **milik orang lain**:
  "Portal Beautyworld: halaman Temuan".
- Task docker-alma itu **tidak pernah muncul** di `view_history`.

Kejadian serupa berulang tiga kali dalam dua hari.

## Yang diperbaiki

### 1. Pekerjaan yang tertimpa tidak hilang

`save()` sekarang merekonsiliasi dengan isi berkas di disk **sebelum** menulis:

- `history` dari proses lain **digabungkan**, tidak ditimpa.
- Kalau berkas di disk memuat task yang **sedang berjalan** milik proses lain,
  task itu diarsipkan ke `history` sebagai `interrupted: true` sebelum ditimpa.

`start_task` memakai `reset({ archive: true })` sehingga task sendiri yang belum
selesai juga diarsipkan, bukan dibuang.

### 2. `reset()` sengaja OPT-IN

`complete_task`, `force_complete_task`, dan `drop_task` sudah memanggil
`addToHistory()` lalu `reset()`. Kalau `reset()` mengarsipkan secara default,
entri akan **ganda**.

Karena itu `reset()` hanya mengarsipkan bila dipanggil dengan
`{ archive: true }`. Perilaku lama tidak berubah.

### 3. Agen diberi tahu, bukan dibiarkan menebak

Setiap penulisan mencap identitas proses:

```json
"owner": { "token": "proc-<pid>-<acak>", "pid": 1234, "updatedAt": "..." }
```

- `start_task` menampilkan peringatan bila ada task proses lain yang hampir
  tertimpa, dan menyebut nama task itu.
- `get_workflow_status` menampilkan peringatan bila berkas terakhir ditulis
  proses lain, termasuk apa yang sedang dikerjakan proses itu.

## Yang TIDAK diperbaiki

**Isolasi penuh per sesi belum ada.** Dua sesi masih berbagi satu berkas.
Yang berubah: tidak ada pekerjaan yang hilang tanpa jejak, dan agen diberi tahu.

Kalau isolasi penuh diinginkan, opsinya:

| Opsi | Isi |
|---|---|
| a | Kunci state per sesi: `userId` + session id / pid |
| b | Kunci per task: `.state/users/<id>/tasks/<taskId>.json` |

Opsi (a) paling tepat sasaran. Kendalanya: server MCP perlu identitas sesi yang
stabil, yang belum tersedia sekarang.

## Cara memverifikasi

```bash
node --no-deprecation --test tests/shared-state.test.js
```

15 tes mengunci tiga janji di atas, termasuk:

- `reset()` tanpa opsi **tidak** menambah history (kompatibilitas `complete_task`)
- `save()` menyelamatkan task berjalan milik proses lain
- `save()` menggabungkan history proses lain
- arsip tidak dobel walau `save()` dipanggil berulang
- `start_task` dan `get_workflow_status` benar-benar menampilkan peringatan

## Untuk pekerjaan sehari-hari (sampai isolasi penuh ada)

1. **Selalu** periksa baris `Task:` di `get_workflow_status` sebelum
   `commit_and_push`. Kalau bukan task Anda, batalkan dan commit manual.
2. Kalau melihat peringatan "state dipakai bersama", artinya ada sesi lain aktif
   di direktori kerja yang sama.

---

# Isolasi penuh per sesi (opsi a, dikerjakan 28 Oktober 2026)

Bagian di atas adalah **mitigasi**. Bagian ini adalah perbaikannya.

Kendala yang dulu disebut di sini - "server MCP perlu identitas sesi yang
stabil, yang belum tersedia" - ternyata sudah tidak berlaku: OpenCode
menyuntikkan `OPENCODE_SESSION_ID` ke environment server MCP. Buktinya papan
Factory mencatat `clientSession.id = ses_...` dari variabel itu.

## Tata letak berkas sekarang

```
<root>/.state/users/<user-id>/workflow-state.json                  -> history PROYEK
<root>/.state/users/<user-id>/workflow-state.<sesi>.json           -> task SESI
```

- **State sesi** memuat task yang sedang dikerjakan beserta gerbangnya
  (`testsPassed`, `readyCheckCompleted`, `documentationCreated`, dan seterusnya).
- **History bersama** memuat catatan task yang sudah selesai, dari sesi mana pun.

Identitas sesi diambil dari **request metadata** yang dikirim OpenCode pada
setiap panggilan tool:

```
CallToolRequest.params._meta["ai.opencode/sessionID"]
```

Itu sumber yang benar karena melekat pada panggilan, bukan pada proses. Satu
proses MCP bisa melayani beberapa sesi bergantian, jadi identitas per proses
tidak cukup.

Cadangan berurutan bila metadata tidak ada: `DEV_WORKFLOW_SESSION_ID`,
`OPENCODE_SESSION_ID`, `CLIENT_SESSION_ID`, lalu `pid-<pid>`.

### Koreksi: percobaan pertama memakai env dan tidak bekerja

Versi pertama hanya membaca env. OpenCode tidak menjamin variabel itu ada di
proses MCP, sehingga hampir semua berkas jatuh ke `pid-<pid>`. Karena satu
proses dipakai bergantian, sesi-sesi itu **tetap** berbagi satu berkas dan
saling menimpa. Gejalanya: task milik sesi lain muncul di `get_workflow_status`
milik sesi sendiri.

Sekarang identitas datang dari metadata, dan `handleToolCall` memanggil
`workflowState.useSession(sessionId)` sebelum menangani tool apa pun.
`tests/session-metadata-e2e.test.js` membuktikannya lewat transport stdio
sungguhan: dua sesi pada satu server menghasilkan dua berkas state terpisah,
tanpa jatuh ke `pid-`.

## Apa yang berubah

| Sebelum | Sesudah |
|---|---|
| Dua sesi berbagi satu task | Tiap sesi punya task sendiri |
| Gerbang kualitas dibagi, sesi B bisa memakai `readyCheckCompleted` sesi A | Gerbang milik sesi, tidak bisa dipinjam |
| `start_task` mengganti task sesi lain | Tidak menyentuh berkas sesi lain |
| History terancam terpecah kalau state dipisah | History digabung dua arah, tanpa duplikat |

## Kompatibilitas

Pemanggil yang memberi path eksplisit (mis. `new WorkflowState("/tmp/x.json")`)
tetap memakai satu berkas: `resolveHistoryFile()` hanya memisahkan history bila
berkas berada di tata letak `.state/users/<id>/`. 15 tes `shared-state.test.js`
lulus tanpa perubahan, dan mekanisme `interrupted` tetap ada sebagai jaring
pengaman untuk pemakaian satu-berkas itu.

## Cara memverifikasi

```bash
node --no-deprecation --test tests/session-metadata.test.js      # 7 tes metadata
node --no-deprecation --test tests/session-metadata-e2e.test.js  # 1 tes lewat stdio
node --no-deprecation --test tests/session-state.test.js         # 11 tes isolasi sesi
node --no-deprecation --test tests/shared-state.test.js          # 15 tes mitigasi lama
```

Yang dikunci tes baru: dua sesi memakai berkas berbeda; task sesi A tidak
tertimpa sesi B; gerbang kualitas tidak bisa dipinjam; history bertemu dua arah;
history tidak berganda; identitas stabil dalam satu proses; `OPENCODE_SESSION_ID`
dipakai; path eksplisit tetap satu berkas; history bersama ada di berkas kanonik;
`projectRoot` dikenali dari letak `.state` dan tidak bergantung pada kedalaman.

## Sisa risiko

Dulu `syncToDatabase` menghitung `projectRoot` dengan empat `dirname` berurutan.
Itu hanya benar selama tata letaknya tepat `<root>/.state/users/<user>/<berkas>`.
Begitu kedalaman berubah, angka itu diam-diam menghasilkan root yang salah dan
baris database tercatat di proyek lain.

Sekarang diganti `resolveProjectRootForState()`: naik sampai menemukan
direktori `.state`, lalu ambil induknya. Tidak bergantung pada kedalaman.

```
<root>/.state/users/u/workflow-state.json                  -> <root>   (sama)
<root>/.state/users/u/sessions/s1/workflow-state.json      -> <root>   (lama: <root>/.state/users, SALAH)
```

Untuk berkas di luar tata letak `.state` (mis. path eksplisit untuk tes),
projectRoot adalah direktori yang memuat berkas itu.

Sisa risiko yang masih ada: `resolveHistoryFile()` menganggap berkas berada di
tata letak user bila induk dari induknya bernama `users`. Itu benar untuk
kedalaman sekarang; kalau struktur user berubah, aturan itu perlu ditinjau.


---

# Penulis basi tidak boleh menang (dikerjakan 29 Oktober 2026)

Bagian sebelumnya memisahkan state **per sesi**. Itu belum cukup: satu sesi bisa
dilayani **lebih dari satu proses MCP** sekaligus, dan proses yang memegang state
lama masih bisa menimpa task yang lebih baru.

## Masalah

Kejadian 29 Oktober 2026, saat mencatat evaluasi Scion:

1. `start_task` menjawab `✅ Task Started: Pindahkan klien Factory ke tools...`
   dengan deskripsi yang benar.
2. `get_workflow_status` berikutnya menampilkan task **yang sama sekali lain**
   (`[a5124498] Siapkan runner Factory rootless...`).
3. `create_tests` menjawab sukses, lalu `run_tests` menjawab
   *"Please mark your feature/bug as fixed first"* - padahal
   `mark_bug_fixed` sudah sukses.

Gejalanya bukan "history hilang", melainkan **dua panggilan berurutan membaca
task yang berbeda**.

### Bukti

Di mesin ini ada **tiga** proses `node ...dev-workflow-mcp-server\index.js`
dengan induk yang sama (`13220`), dijalankan 12:53 dan 19:35. Berkas state sesi
yang sama ditulis bergantian oleh proses-proses itu:

```
ses_e78531efdffdTwpNXPlkD2X322 | coding | '[a5124498] Siapkan runner Factory rootless...'
ses_e9e08865dffd6fT72KVGYg4n6F | coding | '[db4468aa] Perbaiki TypeError Livewire...'
```

Proses yang memegang state dari pukul 13:01 menulis lagi pukul 20:20, menimpa
task yang baru dibuat.

### Reproduksi

Dua proses pada satu berkas state, tanpa MCP:

```
holder: loaded phase=idle task=""
worker: saved task="[NEW] task yang benar-benar dikerjakan"
holder: saved. reconciled={"preservedTask":"[NEW] task yang benar-benar dikerjakan","foreignToken":"proc-26236-..."}
holder: final on-disk task="[STALE] task dari proses basi"     <-- penulis basi MENANG
```

Task yang tertimpa memang masuk `history` sebagai `interrupted`, tetapi:

- task yang lebih baru **tetap hilang** dari state aktif, dan
- pemanggil tetap diberi tahu **"berhasil"**.

## Akar masalah

`save()` menulis seluruh state di memori tanpa memeriksa apakah isi disk berubah
sejak terakhir dimuat. Rekonsiliasi yang ada hanya menyelamatkan `history` dan
mengarsipkan task asing; ia **tidak mencegah** penimpaan, dan tidak ada
verifikasi sesudah menulis.

## Yang diperbaiki

### 1. Penulis basi tidak menang

`WorkflowState` mengingat `loadedTask` - task yang terakhir dibaca dari atau
ditulis ke disk. `save()` menolak menimpa bila **semua** ini benar:

- disk memuat task yang sedang berjalan (`currentPhase !== "idle"`),
- task di disk **bukan** task yang terakhir kita muat (jadi ditulis orang lain
  sesudah kita membaca),
- task di disk **bukan** task yang akan kita tulis,
- pemanggil tidak menyatakan maksud mengganti task.

Saat konflik, instance yang basi **mengadopsi** state dari disk, sehingga langkah
berikutnya tidak lagi memakai task usang.

### 2. `start_task` tetap boleh mengganti task

Mengganti task adalah maksud `start_task`, jadi ia memakai
`save({ allowReplaceRunningTask: true })`. Task yang diganti tetap diarsipkan
`reconcileWithDisk` sebagai `interrupted`, bukan dihapus.

### 3. Sukses palsu dihapus

Sesudah menulis, `save()` membaca ulang berkas dan membandingkan
`taskDescription`. Kalau berbeda, ia **melempar**:

```
State workflow tidak bertahan: yang ditulis "<X>" tetapi di disk "<Y>".
Proses MCP lain menimpanya. Muat ulang state sebelum melanjutkan.
```

Lebih baik gagal terang-terangan daripada melaporkan "berhasil" untuk state yang
sudah ditimpa.

### 4. Semua tool memberi tahu, bukan sebagian

`handleToolCall` menempelkan peringatan ke respons tool mana pun bila
penyimpanan terakhir kalah. Peringatan ditaruh **di depan**, dan menyebut terus
terang bahwa aksinya tidak berlaku:

```
⚠️ AKSI TIDAK BERLAKU - proses MCP lain memulai task yang lebih baru.
   Task di disk : "<task di disk>"
   Task Anda    : "<task Anda>"
   State Anda sudah dimuat ulang dari disk, jadi langkah berikutnya mengikuti task di disk.
   Jalankan ulang aksi ini bila memang untuk task tersebut, atau 'start_task' untuk menggantinya.

--- pesan asli tool (TIDAK tersimpan) ---
```

Urutannya penting. Versi pertama menempelkan peringatan **sesudah** pesan tool,
sehingga yang terbaca lebih dulu adalah `✅ Feature/Bug marked as fixed!` -
agen membaca baris pertama lalu melanjutkan seolah semuanya tersimpan.

## Cara memverifikasi

```bash
node --no-deprecation --test tests/stale-write-guard.test.js   # 7 tes
node --no-deprecation --test                                    # 325 tes
```

Yang dikunci `tests/stale-write-guard.test.js`:

1. penulis basi tidak menimpa task berjalan yang lebih baru;
2. setelah konflik, instance basi memakai state dari disk;
3. `start_task` tetap boleh mengganti task dan mengarsipkan yang lama;
4. `verifyPersisted()` melempar kalau isi disk bukan yang kita tulis;
5. penulisan berurutan di sesi yang sama **tidak** dianggap konflik;
6. tool memberi tahu "AKSI TIDAK BERLAKU", dan peringatannya mendahului pesan
   asli tool;
7. tool yang tidak menyimpan tidak menampilkan peringatan.

## Sisa risiko

**Beberapa proses MCP untuk satu sesi masih terjadi.** Perbaikan ini membuatnya
aman (tidak ada penimpaan diam-diam), tetapi tidak menguranginya. Penyebabnya di
luar kode ini: OpenCode menjalankan lebih dari satu instance server MCP yang
sama. Selama itu terjadi, setiap tool bisa mendarat di proses yang berbeda.

**Cadangan identitas sesi masih memakai env.** Bila
`_meta["ai.opencode/sessionID"]` tidak ada, `resolveSessionKey()` memakai
`OPENCODE_SESSION_ID`, lalu `pid-<pid>`. Keduanya milik **proses**, bukan
panggilan. Pada mesin dengan beberapa proses, panggilan tanpa metadata bisa
masuk ke berkas sesi lain. Guard di atas tidak menangkapnya karena kedua pihak
menganggap dirinya benar. Belum ada bukti kejadian ini, tetapi belum tertutup.

**Rotasi setelah selesai.** `commit_and_push` dan `complete_task` masih membaca
`taskDescription` dari state di memori. Kalau konflik terjadi tepat di antara
`check_ready_to_commit` dan `commit_and_push`, commit bisa memakai pesan task
yang salah. Peringatan di respons adalah jaringnya, bukan pencegahan.

# Sinkronisasi database berhenti total karena entri lama tanpa `task_type` (dikerjakan 30 Oktober 2026)

## Masalah

Log server berulang kali menulis:

```text
{"level":"error","values":["Database sync failed:","NOT NULL constraint failed: workflow_history.task_type"]}
```

Pesan itu terlihat seperti gangguan kosmetik karena `syncToDatabase()` menangkap
error-nya sendiri. Kenyataannya seluruh sinkronisasi berhenti: riwayat proyek
tidak lagi masuk ke database, ringkasan proyek tidak pernah diperbarui, dan
state workflow tidak pernah disimpan ke SQLite.

## Bukti

Pada proyek `C:\Users\<username>\Documents\Default Project`, state memuat 150 entri
tetapi tabel `workflow_history` hanya berisi **25 baris**. Dua puluh lima itu
tepat entri indeks 0–24; entri indeks 25 adalah entri lama tanpa `taskType`,
sehingga loop berhenti di situ dan 125 entri sesudahnya tidak pernah dicoba.

## Reproduksi

```js
const stmt = db.prepare("INSERT INTO workflow_history (user_id, project_path, task_description, task_type) VALUES (?,?,?,?)");
stmt.run("u", "p", "x", undefined); // => SqliteError: NOT NULL constraint failed: workflow_history.task_type
```

`better-sqlite3` mengubah `undefined` menjadi `NULL`, dan kolom
`task_type` dideklarasikan `NOT NULL`.

## Akar masalah

Penanda `dropped` versi lama (`reset()`/`start_task` sebelum perbaikan 26–27
Oktober) ditulis **tanpa** `taskType` sama sekali, dan sebagian entri `forced`
menyimpan string kosong. `insertHistoryEntry()` meneruskan nilai itu apa adanya
ke driver.

## Yang diperbaiki

### 1. Normalisasi di batas database

`normalizeTaskType()` di `db/adapters/base.js` mengubah nilai yang bukan string
atau string kosong menjadi `"other"`, dan dipakai oleh adapter SQLite, MySQL,
serta PostgreSQL. Entri lama tetap dapat disinkronkan tanpa menebak isi
aslinya.

### 2. Satu entri gagal tidak menghentikan sisanya

`syncToDatabase()` sekarang membungkus setiap `insertHistoryEntry()` dengan
`try/catch` sendiri, mencatat berapa entri yang dilewati, lalu **tetap**
menjalankan `updateSummaryForUser()` dan `saveState()`. Fungsi ini juga menerima
`options.db` supaya dapat diuji tanpa monkeypatch modul ESM.

## Cara memverifikasi

`npm test` menjalankan `tests/legacy-task-type.test.js` dan
`tests/sync-resilience.test.js`:

1. entri tanpa `taskType`, `null`, dan string kosong dapat disimpan;
2. nilai tersimpan adalah `other`, dan tidak ada `task_type` NULL/kosong;
3. entri sesudah entri yang gagal tetap disimpan;
4. ringkasan proyek dan state tetap ditulis walau semua insert gagal.

Pada data nyata, setelah server dimuat ulang: 150 → 151 baris, 0 `task_type`
NULL, `project_summary.total_tasks` ikut terisi.

## Sisa risiko

**Entri lama tetap tercatat sebagai `other`.** Tipe aslinya tidak tersimpan di
mana pun, jadi tidak dapat dipulihkan. Ini pilihan sadar: menebak dari
`taskDescription` akan mengarang data.

**`user_id` bergantung konteks.** Menjalankan sinkronisasi dari `cwd` berbeda
menghasilkan `user_id` berbeda untuk proyek yang sama (`default` vs
`user-…`). Belum diperbaiki di sini; saat mereparasi data lama, jalankan dari
`cwd` proyek yang benar.

> Diperbarui 30 Oktober 2026: sudah diperbaiki. Lihat bagian berikutnya.

# `commit_and_push` melaporkan sukses palsu saat git tidak bisa dijalankan (dikerjakan 30 Oktober 2026)

## Masalah

Dari sesi OpenCode di `C:\Users\<username>\Documents\Default Project`, delapan berkas
sudah diubah dan siap di-commit. `commit_and_push` menjawab:

```text
ℹ️ No changes detected. Assuming commit and push already completed.
Last commit: fix(db): normalisasi taskType dan jangan hentikan sync saat satu entri gagal
```

Padahal `git status` di repo menunjukkan delapan berkas belum di-commit, dan
`git log` tidak bergerak. Tool menandai `commitAndPushCompleted = true` sehingga
workflow melangkah ke fase rilis seolah semuanya beres.

## Bukti

```text
$ node -e "..."   # cwd = Documents\Default Project
cwd: C:\Users\<username>\Documents\Default Project
getStatusOutput -> ""
hasWorkingChanges -> false    <-- false di sini adalah kebohongan
```

## Akar masalah

`exec()` sudah benar: untuk perintah `git` ia memanggil `resolveWorkingDirectory()`
dan **melempar** bila tidak menemukan repo proyek.

Yang salah ada di `git-helpers.js`. Setiap helper membungkus `exec` dengan
`try/catch` yang mengembalikan nilai jinak:

```js
export async function hasWorkingChanges() {
  try {
    const { stdout } = await exec("git status --porcelain");
    return stdout.split("\n").some(...);
  } catch (error) {
    return false;   // <-- "tidak tahu" disamakan dengan "tidak ada perubahan"
  }
}
```

`handleCommitAndPush` membaca `false` sebagai "sudah ter-commit", lalu masuk ke
cabang sukses palsu. Penyebab `git` gagal: server MCP dijalankan dengan `cwd`
direktori sesi OpenCode, dan direktori itu bukan repo git.

## Yang diperbaiki

### 1. Helper tidak lagi berbohong

`hasWorkingChanges()`, `hasStagedChanges()`, `getStatusOutput()`,
`getStagedChanges()`, `getLastCommitMessage()`, `getCurrentBranch()`, dan
`hasTestChanges()` sekarang meneruskan error. "Tidak tahu" bukan "tidak ada
perubahan".

`getPrimaryBranch()` tetap punya fallback `main → master → current branch`,
karena branch yang belum ada adalah kondisi normal, bukan kegagalan. Bila repo
sama sekali tidak dapat diresolusi, fallback terakhirnya (`getCurrentBranch()`)
ikut melempar.

### 2. Handler melaporkan penyebabnya

`handleCommitAndPush` dan `handlePerformRelease` membungkus preflight git dan
menjawab:

```text
❌ Tidak bisa memeriksa repository Git, jadi tidak ada yang di-commit.

Penyebab: Tidak bisa menentukan repo proyek: ...
Set WORKFLOW_PROJECT_DIR ke direktori proyek, atau jalankan server MCP dari dalam direktori proyek.
```

State workflow **tidak** dimajukan, jadi `commitAndPushCompleted` tetap `false`.

## Cara memverifikasi

`npm test` menjalankan `tests/commit-false-success.test.js`:

1. `hasWorkingChanges()` melempar saat repo tidak dapat diresolusi;
2. `commit_and_push` tidak pernah menjawab "No changes detected" atau
   "Commit and push completed" ketika git gagal, dan menjelaskan cara
   memperbaikinya;
3. `commitAndPushCompleted` tetap `false` setelah kegagalan itu;
4. tree yang benar-benar bersih **tetap** dilaporkan "No changes detected"
   (jalur lama tidak rusak);
5. di repo git sungguhan, helper tetap menjawab `false` untuk tree bersih dan
   `true` setelah ada berkas baru.

Verifikasi end-to-end pada repo sementara dengan remote bare: dengan
`WORKFLOW_PROJECT_DIR` diarahkan ke repo itu, `commit_and_push` benar-benar
membuat commit `feat: add feature` dan mendorongnya ke remote.

## Sisa risiko

**`WORKFLOW_PROJECT_DIR` harus di-set sendiri** bila server MCP berjalan dari
direktori yang bukan repo. Tanpa itu, tool gagal dengan pesan jelas — perilaku
yang disengaja, karena menebak repo tujuan jauh lebih berbahaya daripada
menolak.

**`getPrimaryBranch()` masih menelan dua error pertama.** Bila `git rev-parse`
gagal karena alasan lain (mis. repo korup), kegagalan itu baru terlihat di
`getCurrentBranch()`. Pesannya tetap sampai, tetapi bukan dari sumber aslinya.

# `commit_and_push` mustahil dipakai di repo server MCP sendiri (dikerjakan 30 Oktober 2026)

## Masalah

Setelah perbaikan sukses palsu, `commit_and_push` menolak dengan benar saat git
tidak bisa dijalankan. Tetapi penolakan itu juga muncul saat sesi OpenCode
dibuka **di dalam repo server MCP sendiri** - jadi `commit_and_push` tidak
pernah bisa dipakai untuk mengembangkan server ini.

```text
❌ Tidak bisa memeriksa repository Git, jadi tidak ada yang di-commit.
Penyebab: Tidak bisa menentukan repo proyek: satu-satunya kandidat adalah
repo paket server MCP.
```

## Akar masalah

`resolveWorkingDirectory()` membuang `PACKAGE_DIR` dari kandidat `cwd` tanpa
syarat:

```js
const usable = found.find((dir) => !samePath(dir, PACKAGE_DIR));
if (usable) return usable;
throw new Error("... satu-satunya kandidat adalah repo paket server MCP ...");
```

Aturan itu benar untuk bug 29 Oktober: server pernah menjalankan git di repo
paket saat `cwd` proyek gagal diresolusi, lalu melaporkan "No changes detected"
sementara perubahan proyek tidak pernah ter-commit. Tetapi mengecualikannya
tanpa syarat berarti kandidat yang **memang berada di dalam** repo paket pun
dibuang.

Pesan errornya juga menyesatkan: ia selalu menyalahkan repo paket, bahkan saat
tidak ada repository git sama sekali di direktori yang diperiksa.

## Yang diperbaiki

### 1. Repo paket diterima bila kandidatnya memang di dalamnya

`found` berisi akar repo hasil resolusi setiap kandidat. Bila akar itu adalah
`PACKAGE_DIR`, berarti `cwd` benar-benar berada di dalam repo paket - pilihan
sadar, bukan fallback diam-diam. Kandidat seperti itu sekarang diterima, dan
repo proyek lain tetap menang bila ada.

```js
const projectRepo = found.find((dir) => !samePath(dir, PACKAGE_DIR));
if (projectRepo) return projectRepo;

if (found.some((dir) => samePath(dir, PACKAGE_DIR))) return path.resolve(PACKAGE_DIR);
```

Bug lama tidak kembali: `found` hanya berisi repo yang benar-benar ditemukan
dari kandidat, jadi tidak ada jalan bagi `cwd` proyek untuk "jatuh" ke repo
paket.

### 2. Pesan error yang akurat

Bila tidak ada repo sama sekali, pesannya menyebut direktori yang diperiksa,
bukan menyalahkan repo paket:

```text
Tidak bisa menentukan repo proyek: tidak ada repository git pada
"C:\...\no-repo-iyURBK". Set WORKFLOW_PROJECT_DIR ke direktori proyek, ...
```

## Cara memverifikasi

`npm test` menjalankan `tests/package-repo-working-directory.test.js` dan
`tests/exec-repo-resolution.test.js`:

1. `cwd` di akar maupun subdirektori repo paket resolve ke repo paket;
2. repo proyek lain tetap dipilih saat repo paket juga menjadi kandidat;
3. `cwd` di dalam repo proyek tidak pernah dialihkan ke repo paket;
4. direktori tanpa git memberi pesan yang menyebut sebab sebenarnya.

Verifikasi pada mesin nyata, tanpa `WORKFLOW_PROJECT_DIR`:

```text
cwd = repo paket              -> C:\...\dev-workflow-mcp-server
cwd = repo proyek lain        -> C:\...\other-project-1kc3Pf
cwd = direktori tanpa git     -> error yang menyebut direktori itu
```

## Sisa risiko

**Repo paket kini bisa menjadi target commit.** Itu memang tujuannya, tetapi
berarti membuka sesi di dalam repo server MCP membuat `commit_and_push` bekerja
di sana. Bila kamu ingin memaksa repo lain, set `WORKFLOW_PROJECT_DIR` - jalur
itu tetap diperiksa lebih dulu dan tidak terpengaruh aturan ini.

# Rilis menulis `version: null` dan tag `vnull` (dikerjakan 30 Oktober 2026)

## Masalah

Setelah `commit_and_push` berhasil, `perform_release` menjalankan rilis dan
menghasilkan:

```text
chore(release): null 🚀
```

`package.json` menjadi `"version": null`, dan repo mendapat tag `vnull`.
Kerusakan ini sempat ter-push ke `main` dan harus di-revert.

## Akar masalah

`release.cjs` mengirim `--release-as` **dua kali** ke standard-version.

```js
// perform_release menyusun perintah
npm run release -- --release-as patch

// getCliArguments: argumen pertama diawali '-', jadi dianggap flag
{ releaseType: 'patch', extraArgs: ['--release-as', 'patch'] }

// buildStandardVersionArgs: menambah dari releaseType, LALU menambah extraArgs
['--release-as', 'patch', '--release-as', 'patch']
```

yargs memperlakukan opsi yang muncul dua kali sebagai array, dan:

```text
semver.inc('1.13.2', 'patch')            -> '1.13.3'
semver.inc('1.13.2', ['patch','patch'])  -> null
```

standard-version memakai hasil itu apa adanya, sehingga menulis `null` sebagai
versi.

## Yang diperbaiki

### 1. `--release-as` diambil sekali, lalu dibuang dari `extraArgs`

`getCliArguments()` sekarang mencari `--release-as` (baik bentuk terpisah maupun
`--release-as=patch`), memakai nilainya sebagai `releaseType`, dan mengeluarkan
pasangan itu dari `extraArgs`. Bila `--release-as` tidak punya nilai, fungsinya
melempar pesan jelas - `--release-as` tanpa nilai membuat yargs memberinya
`true`, dan `semver.inc(version, true)` juga menghasilkan `null`.

### 2. `stripReleaseAs()` sebagai lapis kedua

`buildStandardVersionArgs()` membuang setiap `--release-as` yang masih ada di
`extraArgs` sebelum menyusun argumen akhir, sehingga satu jalur pemanggilan pun
tidak bisa menggandakannya.

## Cara memverifikasi

`npm test` menjalankan `tests/release-args.test.js`:

1. `--release-as patch` di CLI menghasilkan tepat satu `--release-as`;
2. semua bentuk pemanggilan (`--release-as patch|minor|major`, `1.14.0`,
   `patch`, tanpa argumen) menghasilkan tepat satu opsi dengan nilai benar;
3. `--first-release` tidak digandakan dan tidak diteruskan;
4. argumen lain seperti `--dry-run` tetap diteruskan;
5. tipe rilis tak dikenal dan `--release-as` tanpa nilai ditolak.

Verifikasi end-to-end di clone repo (dengan berkas yang diubah disalin ke
dalamnya, karena `git clone` hanya membawa commit):

```text
version before: 1.13.2
command       : npm run release -- --release-as patch
version after : "1.13.3"
head          : chore(release): 1.13.3 🚀
tag at HEAD   : ["v1.13.3"]
```

## Sisa risiko

**standard-version tetap menerima nilai aneh tanpa protes.** Perbaikan ini
mencegah bentuk yang kita hasilkan sendiri, bukan semua kemungkinan. Kalau
`release.cjs` dipanggil langsung dengan argumen yang tidak lazim, validasi di
`buildStandardVersionArgs` adalah satu-satunya penjaga.

**Tidak ada pemeriksaan hasil rilis.** Tidak ada yang memverifikasi bahwa
`package.json` berisi semver sah setelah rilis berjalan. Pemeriksaan seperti itu
akan menangkap kerusakan ini lebih cepat - belum dikerjakan di sini.

> Diperbarui 30 Oktober 2026: pemeriksaan itu sekarang ada. Lihat bagian
> berikutnya.

# Guard versi setelah rilis (dikerjakan 30 Oktober 2026)

## Masalah

Insiden `version: null` di atas tidak terdeteksi sampai tag `vnull` ter-push.
`SEMVER_REGEX` sudah ada di `release.cjs`, tetapi hanya dipakai memvalidasi
**tipe rilis masukan**:

```js
const isValid = VALID_RELEASE_TYPES.has(normalized) || SEMVER_REGEX.test(normalized);
```

Hasil rilis - isi `package.json` setelah standard-version berjalan - tidak pernah
diperiksa. Selama standard-version keluar dengan kode 0, `perform_release`
menganggap semuanya beres lalu mem-push tag.

## Yang diperbaiki

`verifyReleaseVersion()` membaca `package.json` setelah standard-version selesai
dan menolak bila `version` bukan semver sah. `runRelease()` memanggilnya sebelum
melaporkan sukses, sehingga rilis yang rusak berakhir dengan status 1:

```js
if (!releaseResult || releaseResult.error || releaseResult.status !== 0) {
  return { ...releaseResult, status: releaseResult?.status || 1 };
}

let releasedVersion;
try {
  releasedVersion = verifyReleaseVersion({ cwd });
} catch (error) {
  safeLog('error', error.message);
  return { status: 1, error };
}
```

Karena `perform_release` berhenti ketika perintah rilis gagal, tag tidak pernah
di-push. Pesan errornya menyebut nilai yang didapat dan langkah pemulihan:

```text
Rilis gagal: package.json berisi version null, bukan semver yang sah.
Tag tidak boleh di-push. Periksa argumen --release-as, lalu pulihkan dengan
"git tag -d vnull" dan "git reset --hard HEAD~1" bila perlu.
```

## Cara memverifikasi

`npm test` menjalankan dua berkas:

`tests/release-version-guard.test.js` - fungsi guard sendiri:

1. menerima `1.13.3`, `0.0.1`, `2.0.0`, `1.0.0-beta.1`;
2. menolak `null` (bentuk kerusakan yang sebenarnya), versi yang hilang,
   nilai non-string, dan string bukan semver (`""`, `"1.13"`, `"v1.13.3"`,
   `"latest"`, `"null"`);
3. menolak `package.json` yang tidak ada atau bukan JSON;
4. pesan errornya menyebut nilai yang bermasalah.

`tests/release-run-guard.test.js` - guard terpasang di dalam `runRelease`:

1. bila standard-version "berhasil" tetapi meninggalkan `version: null`,
   `runRelease` mengembalikan status 1 beserta error;
2. hal yang sama untuk versi bukan semver;
3. versi sah tetap lolos;
4. kegagalan standard-version sendiri diteruskan apa adanya tanpa pemeriksaan.

Verifikasi end-to-end di clone repo, dengan guard dipaksa menolak:

```text
version before : 1.13.3
version after  : 1.13.4      (standard-version sempat menaikkan versi)
head after     : chore(release): 1.13.4 🚀
tags           : 111 -> 112  (tag lokal dibuat)
exit code      : 1           <- perform_release berhenti, tag TIDAK di-push
```

## Sisa risiko

**Rilis yang gagal meninggalkan commit dan tag lokal.** Guard mencegah tag
keluar dari mesin, tetapi tidak membersihkannya: standard-version sudah menulis
commit rilis dan tag sebelum pemeriksaan berjalan. Pesan error menyebutkan
perintah pemulihannya. Pembersihan otomatis sengaja tidak dilakukan karena
`git reset --hard` jauh lebih berbahaya daripada sisa yang terlihat jelas.

**Guard hanya berjalan lewat `release.cjs`.** Bila `perform_release` diberi
perintah rilis lain yang tidak memakai skrip ini, tidak ada yang memeriksa
hasilnya. Jalur itu tidak dipakai sehari-hari, tetapi belum ditutup.

# Identitas user jatuh ke "default" saat state memakai path eksplisit (dikerjakan 30 Oktober 2026)

## Masalah

Saat mereparasi riwayat proyek yang gagal tersinkron, 150 baris masuk ke
database dengan `user_id = "default"`, padahal pemakaian normal memakai
`user-1a171645d22-788e41b9`. Baris duplikat itu harus dibersihkan manual.

Pada mesin yang sama ditemukan tiga identitas berbeda:

```text
C:\Users\<username>                              -> user-19ac630d828-982a39ab
C:\Users\<username>\Documents\Default Project    -> user-1a171645d22-788e41b9
C:\Users\<username>\Documents\code\dev-workflow-mcp-server -> user-1a17163e109-757756e5
```

## Akar masalah

`syncToDatabase()` memanggil `getCurrentUserId()`, yang hanya membaca cache
modul `cachedUserId`:

```js
function getCurrentUserId() {
  if (cachedUserId) return cachedUserId;
  if (cachedUserStateDir) return resolveUserId(cachedUserStateDir);
  return "default";
}
```

Cache itu terisi lewat `resolveUserId()`, dan `resolveUserId()` hanya dipanggil
dari `resolveStateFile()`. Pemanggil yang membuat `WorkflowState` dengan path
**eksplisit** - skrip perbaikan, CLI, tes - tidak pernah memicunya. Dalam keadaan
itu fungsinya diam-diam mengembalikan `"default"`.

Jadi bukan `cwd` yang menentukan identitas, melainkan **cara state dibuat**. Itu
lebih buruk, karena hasilnya bergantung pada urutan pemanggilan di dalam proses
dan mudah bocor antar proyek saat satu proses melayani beberapa location.

## Yang diperbaiki

`getCurrentUserId(stateFile)` sekarang menerima path state dan membaca
identitas dari proyek itu langsung:

```js
if (stateFile) {
  const stateDir = path.dirname(path.resolve(stateFile));
  const userIdFile = path.join(stateDir, USER_ID_FILENAME);

  try {
    const stored = readFileSync(userIdFile, "utf-8").trim();
    if (stored) return stored;
  } catch { /* belum ada, lanjut */ }

  try { return resolveUserId(stateDir); } catch { /* lanjut */ }
}
```

Cache modul tetap dipakai sebagai cadangan, tetapi tidak lagi menjadi sumber
utama. Hasilnya tidak bergantung pada direktori kerja, tidak bergantung pada
urutan pemanggilan, dan tidak bocor antar proyek.

## Cara memverifikasi

`npm test` menjalankan `tests/stable-user-id.test.js`:

1. `WorkflowState` dengan path eksplisit memakai `user-id` dari direktori
   `.state`-nya, bukan `"default"`;
2. dua proyek berbeda dalam **satu proses** memakai identitas masing-masing,
   tanpa saling mewarisi.

Pada database nyata `C:\Users\<username>\Documents\Default Project\.state\dev-workflow.db`:

```text
  161  user-1a171645d22-788e41b9  <-  C:\Users\<username>\Documents\Default Project
proyek dengan lebih dari satu user_id: tidak ada
```

## Sisa risiko

**Baris lama tidak dimigrasikan otomatis.** Data yang terlanjur tertulis dengan
`"default"` tetap di sana sampai dibersihkan manual. Perbaikan ini mencegah
kerusakan baru, bukan menyembuhkan yang lama.

**Masih ada tiga user-id berkas di mesin ini.** Satu per proyek, dan itu memang
desainnya: identitas mengikuti proyek, bukan mesin. Yang diperbaiki adalah agar
identitas itu benar-benar dibaca, bukan agar semua proyek memakai satu id.
