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

Pada proyek `C:\Users\DHIKA\Documents\Default Project`, state memuat 150 entri
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
