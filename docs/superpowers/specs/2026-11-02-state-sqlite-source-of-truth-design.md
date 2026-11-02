# State Hidup di SQLite sebagai Sumber Kebenaran — Design

**Tanggal:** 2026-11-02
**Status:** Menunggu review
**Repo:** `D:\code\dev-workflow-mcp-server`
**Rilis yang direncanakan:** 1.20.0 (minor — mengubah janji penyimpanan)

## Ringkasan

State hidup workflow (task aktif, DoD, plan, riwayat langkah) disimpan di berkas
JSON. Isolasi per sesi sudah dipasang 1 November 2026, tetapi masih bergantung
pada tiga hal yang tidak selalu benar: metadata `ai.opencode/sessionID` yang
harus dikirim OpenCode, protokol penguncian berkas yang harus dipatuhi semua
penulis, dan penjaga `detectStaleOverwrite` yang sifatnya **mendeteksi lalu
memperbaiki** — bukan mencegah.

Spec ini memindahkan state hidup ke SQLite lokal sebagai satu-satunya sumber
kebenaran. Tabrakan berhenti menjadi sesuatu yang dideteksi dan dibereskan,
menjadi sesuatu yang **tidak bisa terjadi**: kunci baris memuat identitas sesi,
dan versi baris menolak tulis ganda. Postgres tidak lagi berada di jalur tulis;
ia menerima salinan best-effort untuk dashboard.

## Masalah

### Bukti 1: penjaga tabrakan bekerja, dan itu justru buktinya

Saat proses MCP lama dihentikan pada 2 November 2026, stderr-nya memuat:

```
State workflow tidak bertahan: yang ditulis ""
tetapi di disk "Room mic Timeless Bintaro tiba-tiba offline: ..."
Proses MCP lain menimpanya. Muat ulang state sebelum melanjutkan.
```

Itu `verifyPersisted` (`workflow-state.js:1650`) bekerja **benar** — ia menolak
mengaku berhasil. Tetapi tugasnya adalah memberi tahu bahwa kerusakan sudah
terjadi, bukan mencegahnya. Yang diinginkan adalah pesan itu tidak pernah punya
alasan untuk muncul.

### Bukti 2: isolasi bergantung pada metadata yang bisa hilang

`resolveSessionKey` (`workflow-state.js:660`) berakhir di:

```js
return `pid-${process.pid}`;
```

Satu proses MCP melayani beberapa jendela OpenCode. Bila metadata tidak sampai,
dua jendela memakai kunci yang sama dan kembali berbagi satu state. Di disk
mesin ini jejaknya ada: `.state/users/*/workflow-state.pid-11524.json`,
`pid-17924`, `pid-22460`, `pid-25112`, `pid-25272`, `pid-25296`.

### Bukti 3: tabel `workflow_state` yang sudah ada tidak menolong

`db/adapters/sqlite.js:88` sudah punya tabel `workflow_state`, tetapi kuncinya:

```sql
PRIMARY KEY (user_id, project_path)
```

Tanpa sesi. Kalau tabel itu dijadikan sumber kebenaran apa adanya, dua sesi pada
proyek yang sama akan saling menimpa **lebih sering** daripada sekarang, karena
tidak ada lagi berkas terpisah yang kebetulan menyelamatkan.

`saveState` juga hanya dipanggil dari `syncToDatabase` (`workflow-state.js:1919`)
sebagai **salinan** setelah berkas JSON ditulis. Ia tidak pernah dibaca kembali
sebagai kebenaran.

### Bukti 4: Postgres tidak pernah memperbaiki tabrakan

Tabrakan state adalah masalah **penguncian**, bukan masalah **sentralisasi**.
Memindahkan state ke Postgres membuat tabrakan mustahil, tetapi menukarnya
dengan ketergantungan jaringan pada jalur terpanas di seluruh sistem: `save()`
dipanggil setiap langkah workflow. Postgres atau Tailscale mati berarti tidak
bisa `start_task`, tidak bisa `commit_and_push`.

## Keputusan yang sudah disepakati

1. **SQLite lokal menjadi sumber kebenaran.** Postgres hanya replika.
2. **Migrasi penuh sekarang**, jalur JSON tidak lagi dibaca sebagai kebenaran.
3. **SQLite gagal dibuka berarti tolak tulis** dengan pesan jelas. Tidak jatuh
   ke JSON: jalur itu tidak teruji dan membuka tabrakan lagi.

## Non-tujuan

- Dashboard dan `monitor-server/` tidak berubah cara bacanya (tetap Postgres).
  Yang ditambahkan hanya penanda "replika tertinggal N detik" — satu kolom
  tampilan, bukan perubahan jalur baca.
- Retensi data tidak berubah: tetap mati secara bawaan.
- Tidak ada perubahan pada integrasi Factory.
- Riwayat antar-mesin (MMCH ↔ Mac ↔ HELLOWORLD) tidak digabung. Tiap mesin punya
  SQLite sendiri; penggabungan tetap lewat dashboard.

## Desain

### Lapisan penyimpanan

| Lapisan | Isi | Sifat | Kalau mati |
|---|---|---|---|
| SQLite lokal `<proyek>/.state/dev-workflow.db` | state hidup per sesi, history, ringkasan | **sumber kebenaran**, wajib | tulis ditolak, pesan jelas |
| Antrean `sync_queue` (di SQLite yang sama) | baris yang belum terkirim ke Postgres | wajib | — |
| Postgres `devwf_monitor` | salinan untuk dashboard | replika, best-effort | workflow jalan, dashboard basi |
| JSON di `.state/` | ekspor cadangan, ditulis atomik | keluaran saja | dicatat, tidak menggagalkan simpan |

Prinsipnya satu kalimat: **tidak ada operasi workflow yang menunggu jaringan.**

### Skema

```sql
CREATE TABLE workflow_state (
  user_id      TEXT NOT NULL,
  project_path TEXT NOT NULL,
  session_key  TEXT NOT NULL,
  state_json   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, project_path, session_key)
);

CREATE TABLE state_writer (
  user_id      TEXT NOT NULL,
  project_path TEXT NOT NULL,
  session_key  TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  process_token TEXT NOT NULL,
  key_source   TEXT NOT NULL,   -- request-metadata | env | process-random
  last_write_at TEXT NOT NULL,
  PRIMARY KEY (user_id, project_path, session_key)
);

CREATE TABLE sync_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,      -- state | history | summary
  dedupe_key    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_attempt_at TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (kind, dedupe_key)
);

CREATE TABLE schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

`workflow_history` dan `project_summary` tetap seperti sekarang. Kuncinya sudah
`(user_id, project_path)` — untuk history itu memang benar, karena history
memang milik proyek, bukan milik sesi.

`session_key` pada `workflow_state` inilah yang membuat tabrakan mustahil: dua
sesi tidak pernah berbagi baris.

### Identitas sesi

Urutan `resolveSessionKey` berubah di satu titik saja:

| Sumber | Kunci | Dicatat sebagai |
|---|---|---|
| `request.params._meta["ai.opencode/sessionID"]` | `ses_...` | `request-metadata` |
| `DEV_WORKFLOW_SESSION_ID` / `OPENCODE_SESSION_ID` / `CLIENT_SESSION_ID` | apa adanya | `env` |
| tidak ada | `proc-<uuid4>`, dibuat sekali per proses | `process-random` |

Dua perubahan penting dibanding sekarang:

- Cadangan **bukan** `pid-<pid>` lagi, melainkan UUID acak per proses. Satu
  proses = satu kunci, sehingga dua jendela dalam satu proses tidak lagi
  kebetulan berbagi kunci yang sama karena `pid` sama. (Catatan jujur: ini tetap
  tidak memisahkan dua jendela dalam satu proses MCP — tidak ada cara
  memisahkannya tanpa metadata. Yang berubah: keadaannya tercatat
  `process-random` di `state_writer`, terlihat di dashboard, bukan diam-diam.)
- Setiap kali sumbernya bukan `request-metadata`, alasannya dicatat dan
  dilaporkan sekali per proses lewat `safeLog`. Tidak ada tebakan senyap.

### Jalur tulis

`WorkflowState.save()` menjadi:

```
1. assertSafeKnowledge(state)
2. BEGIN IMMEDIATE
3. baca version sekarang untuk (user, project, session_key)
4. UPDATE workflow_state
     SET state_json = ?, version = version + 1, updated_at = ?
     WHERE user_id=? AND project_path=? AND session_key=? AND version=?
5. kalau 0 baris berubah:
     - baca ulang; kalau task di disk memang task lain -> StateConflict
     - kalau sama -> coba SEKALI lagi dengan version baru
     - masih gagal -> lempar StateConflict (tidak pernah menimpa diam-diam)
6. upsert entri history baru
7. segarkan project_summary
8. COMMIT
9. tulis ekspor JSON secara atomik (tmp + rename); gagal -> dicatat, tidak melempar
10. enqueue baris replika ke sync_queue
11. kuras antrean, berbatas waktu ~1,2 detik, gagal -> dibiarkan mengantre
12. verifyPersisted: baca ulang dari SQLite dan bandingkan
```

Yang **hilang** dari jalur ini, dan itu tujuannya: `reconcileWithDisk`,
`detectStaleOverwrite`, `adoptDiskState`. Ketiganya ada untuk menambal berkas
bersama; dengan kunci baris per sesi tidak ada lagi yang perlu ditambal.

`mergeMonotonicProgress` dan `mergeDefinitionOfDone` **tidak hilang, tetapi
berpindah tempat**: keduanya menjadi langkah di dalam transaksi, dijalankan
terhadap baris yang barusan dibaca dengan `version` yang cocok. Alasan aslinya
masih berlaku — dua proses bisa melayani satu sesi yang sama, dan langkah
workflow bersifat monoton — tetapi sekarang penggabungan terjadi di atas data
yang sudah dikunci, bukan di atas dua salinan berkas yang mungkin sudah basi.

### Replika ke Postgres

```
enqueue(kind, dedupeKey, payload)
  -> INSERT ... ON CONFLICT(kind, dedupe_key) DO UPDATE payload=excluded.payload
     (baris yang sama tidak menumpuk; yang terbaru menang)

drain(limit, budgetMs)
  -> ambil WHERE next_attempt_at IS NULL OR next_attempt_at <= now
     ORDER BY id LIMIT ?
  -> kirim satu per satu
  -> sukses: DELETE
  -> gagal: attempts++, next_attempt_at = now + backoff(attempts), last_error
```

Backoff: 1, 2, 4, 8, 16, 32, 64 detik, lalu tetap 5 menit. Baris tidak pernah
dibuang karena umur; yang `attempts > 20` dilaporkan sebagai peringatan di
`get_workflow_status`. Membuang diam-diam berarti dashboard kehilangan data
tanpa ada yang tahu.

`drain` dipanggil di akhir `save()` dengan batas waktu keras. Kalau Postgres
mati, setiap `save()` menambah paling banyak ~1,2 detik — angka yang sama
dengan laporan monitor sekarang, yang sudah terbukti tidak mengganggu.

### Kalau SQLite gagal

| Keadaan | Perilaku |
|---|---|
| direktori tidak bisa dibuat | tolak tulis, `StateUnavailable` |
| berkas tidak bisa dibuka / terkunci | tolak tulis, `StateUnavailable` |
| `state_json` rusak saat dibaca | tolak tulis **dan** baca; salin ke `*.corrupt-<stamp>` dulu |
| disk penuh saat COMMIT | tolak tulis, `StateUnavailable`, transaksi di-rollback |

`StateUnavailable` dan `StateConflict` dikembalikan handler sebagai jawaban tool
yang menyebut sebabnya, bukan sebagai crash proses. Aturan yang sudah dipegang
sejak `870d495` tetap: **gagal membaca tidak pernah berarti kosong.**

### Migrasi

Sekali jalan, idempoten, berjalan saat `WorkflowState.load()` pertama kali
menemukan database kosong:

1. Kumpulkan `workflow-state.<sesi>.json` di `<proyek>/users/<user>/`,
   `workflow-state.pid-*.json`, dan history bersama `<proyek>/workflow-state.json`.
2. Untuk tiap berkas: hitung `session_key` dari nama berkas, `user_id` dari
   direktori, baca isinya.
3. `INSERT OR IGNORE` ke `workflow_state` / `workflow_history`, dengan
   `state_writer.key_source = 'legacy-file'`.
4. Hitung ulang: jumlah baris `workflow_state` harus ≥ jumlah berkas state yang
   berhasil dibaca. Kalau kurang, migrasi **gagal keras** dan tidak menandai
   `schema_version` — lebih baik menolak jalan daripada kehilangan task.
5. Pindahkan berkas JSON lama ke `.state/legacy-json/<stamp>/`, jangan dihapus.
6. Tulis `schema_version = 1`.

Berkas lama dipindah, bukan dihapus, supaya bisa dibandingkan bila ada yang
janggal. Setelah migrasi, tidak ada jalur baca yang menyentuhnya.

### Yang berubah di kode

| Berkas | Perubahan |
|---|---|
| `db/index.js` | tambah `getLocalAdapter()` (SQLite wajib) dan `getReplicaAdapter()` (opsional). `getAdapter()` yang lama dipertahankan sebagai alias lokal. |
| `db/adapters/sqlite.js` | skema baru, `saveStateVersioned`, `readStateVersioned`, `enqueue`, `drain`, `migrateLegacyJson` |
| `db/replicate.js` (baru) | backoff, drain, pelaporan antrean |
| `workflow-state.js` | `load`/`save`/`writeHistoryFile`/`syncToDatabase` dialihkan ke SQLite; `reconcileWithDisk`, `detectStaleOverwrite`, `adoptDiskState` dihapus; `resolveSessionKey` berubah |
| `tools/handler-modules/*` | meneruskan `StateConflict`/`StateUnavailable` sebagai jawaban tool |
| `tests/*` | stub `db/index.js` di `workflowState.test.js` diganti adapter SQLite sungguhan di tmpdir |

### Strategi pengujian

Tes perilaku terhadap SQLite sungguhan (berkas sementara), bukan tiruan:

1. **Dua sesi berbeda menulis bersamaan** → dua baris, keduanya utuh, tidak ada
   yang hilang.
2. **Dua proses memakai `session_key` yang sama** → tepat satu menang, yang lain
   menerima `StateConflict`; isi pemenang tidak rusak.
3. **Postgres mati** → `save()` tetap berhasil, `sync_queue` bertambah, state
   terbaca benar; setelah Postgres hidup, antrean terkuras dan baris hilang dari
   antrean.
4. **Antrean gagal berulang** → `attempts` naik, backoff terlihat,
   `get_workflow_status` melaporkan peringatan; tidak ada baris yang dibuang.
5. **SQLite tidak bisa dibuka** → `save()` melempar `StateUnavailable` dengan
   pesan yang menyebut sebabnya; `load()` juga menolak, tidak mengaku kosong.
6. **`state_json` rusak** → disalin ke `*.corrupt-*` dulu, lalu ditolak.
7. **Migrasi** → susun pohon `.state` lama (8 berkas sesi + history bersama),
   migrasi, jumlah baris cocok, berkas lama pindah ke `legacy-json/`, jalan kedua
   tidak menggandakan apa pun.
8. **Cadangan identitas** → tanpa metadata, kunci berawalan `proc-`, bukan `pid-`,
   dan `key_source = 'process-random'`.
9. Seluruh suite lama tetap hijau (850 tes).

## Risiko

| Risiko | Penanganan |
|---|---|
| `workflow-state.js` sudah 2.500+ baris; `save()` jalur terpanas | tes perilaku ditulis lebih dulu, `save()` dipecah jadi `persistState()` + `exportJson()` + `replicate()` |
| `better-sqlite3` sinkron; COMMIT bisa memblokir | operasi per simpan kecil (satu baris + beberapa entri); diukur sebelum dan sesudah |
| WAL antar-proses di Windows | `busy_timeout = 5000`, `BEGIN IMMEDIATE`; diuji dengan dua proses sungguhan, bukan dua promise |
| Dashboard membaca Postgres yang kini bisa tertinggal | dashboard sudah punya "terakhir melapor"; tambah penanda "replika tertinggal N detik" |
| Alat lain yang membaca `.state/workflow-state.json` langsung akan melihat data beku | disebut di CHANGELOG sebagai perubahan yang memutus; berkas tetap ditulis sebagai ekspor |
| Migrasi salah dan kehilangan task | langkah 4 gagal keras; berkas lama tidak pernah dihapus |

## Pertanyaan terbuka

1. Kalau dua jendela OpenCode berada dalam satu proses MCP dan metadata tidak
   dikirim, keduanya tetap berbagi `proc-<uuid>`. Apakah cukup dilaporkan, atau
   harus menolak tulis? Rekomendasi: laporkan dulu, tolak setelah terlihat
   frekuensinya.
2. Perlukah `sync_queue` ikut dilaporkan ke dashboard sebagai metrik? Rekomendasi:
   ya, satu angka "tertunda N".
