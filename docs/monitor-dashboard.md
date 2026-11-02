# Live dashboard (devwf-monitor)

Dashboard yang menampilkan sesi `dev-workflow` dari semua mesin secara
langsung, tanpa login, di jaringan Tailscale.

URL: `http://100.107.65.21:3100`

Berkas di `monitor-server/`:

| Berkas | Isi |
|---|---|
| `dashboard.cjs` | Server HTTP: `/`, `/health`, `/api/sessions`, `/api/events`, `POST /api/session`, `POST /api/event` |
| `sessions-query.cjs` | Penyusun SQL daftar sesi (tanpa jaringan, bisa diuji) |
| `devwf-monitor.service` | Unit systemd; kredensial dibaca dari `EnvironmentFile` |
| `devwf-monitor.env.example` | Contoh isi `/etc/devwf-monitor.env` |

## Mengapa proses terpisah

Server MCP di-spawn per sesi OpenCode dan ikut mati bersamanya. Dashboard dan
koneksi Postgres harus hidup lebih lama dari itu, jadi state **didorong** dari
server (tidak ditunggu) dan **dibaca** oleh proses ini.

Berkas di `monitor-server/`:

| Berkas | Isi |
|---|---|
| `dashboard.cjs` | Server HTTP: `/`, `/health`, `/api/sessions`, `/api/events`, `POST /api/session`, `POST /api/event` |
| `sessions-query.cjs` | Penyusun SQL daftar sesi (tanpa jaringan, bisa diuji) |
| `devwf-monitor.service` | Unit systemd; kredensial dibaca dari `EnvironmentFile` |
| `devwf-monitor.env.example` | Contoh isi `/etc/devwf-monitor.env` |

## Mengemudikan tablet lewat adb

Kedua tablet membuka adb TCP di port 5555 di alamat Tailscale-nya:

```powershell
adb connect 100.81.240.34:5555    # Xiaomi Pad 6 (p1pa)
adb connect 100.126.241.90:5555   # POCO Pad M1
adb -s 100.81.240.34:5555 shell am start -n com.android.chrome/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d http://100.107.65.21:3100
```

Baca isi layar tanpa screenshot (berguna untuk verifikasi otomatis):

```powershell
adb -s <ip>:5555 shell uiautomator dump /sdcard/ui.xml
adb -s <ip>:5555 shell cat /sdcard/ui.xml
```

Dua jebakan yang ditemui 1 November 2026:

1. **Jangan pakai `am start -a VIEW -d URL` tanpa paket di Xiaomi Pad 6.** Browser
   defaultnya Mi Browser, jadi intent itu memunculkan dialog "Open with", bukan
   halaman. Sebut paketnya eksplisit: `-n com.android.chrome/com.google.android.apps.chrome.Main`.
2. **Mi Browser dijaga App Lock Xiaomi** (`com.miui.securitycenter/…ConfirmAccessControl`,
   "Unlock via password"). Jangan coba menembusnya; pakai Chrome. Kalau dialognya
   tersangkut di atas aplikasi lain, `am force-stop com.miui.securitycenter`
   setelah dua `KEYCODE_BACK` mengembalikan fokus ke launcher.

## Mengapa hanya menyimak IP Tailscale

`HOST=100.107.65.21` mengikat server ke alamat Tailscale saja. Bind ke
`127.0.0.1` tidak bisa dijangkau tablet; bind ke `0.0.0.0` membuka dashboard ke
internet publik tanpa autentikasi. Dengan cara ini dashboard terbuka untuk
perangkat di tailnet dan tidak terlihat dari luar.

## Kredensial

Jangan menaruh `DATABASE_URL` di unit systemd: `systemctl cat` dapat dibaca
siapa pun yang punya akses baca ke unit. Kredensial ada di
`/etc/devwf-monitor.env` dengan mode `600`:

```
DATABASE_URL=postgres://devwf:SANDI@127.0.0.1:5432/devwf_monitor
DEVWF_MONITOR_TOKEN=<token acak panjang>
IDLE_TTL=30 minutes
EMPTY_IDLE_TTL=5 minutes
```

## Menulis butuh token, membaca tidak

Dashboard memang harus terbuka tanpa login — itu tujuannya. Tetapi **menulis**
berbeda: tanpa pemeriksaan, perangkat mana pun yang bisa menjangkau port 3100
di tailnet dapat mengirim `POST /api/session` dan memunculkan sesi palsu di
layar tablet.

`GET /`, `/api/sessions`, `/api/events`, dan `/health` tetap bebas.
`POST /api/session` dan `POST /api/event` wajib menyertakan:

```
Authorization: Bearer <DEVWF_MONITOR_TOKEN>
```

Tanpa `DEVWF_MONITOR_TOKEN` di server, **semua** penulisan ditolak dan server
menulis peringatan di log saat start. Itu pilihan sadar: monitor yang lupa
dikonfigurasi lebih baik berhenti menerima laporan daripada diam-diam menerima
laporan dari siapa saja.

Setiap mesin pengirim harus memakai token yang sama:

```
DEVWF_MONITOR_URL=http://100.107.65.21:3100
DEVWF_MONITOR_TOKEN=<token yang sama>
DEVWF_MACHINE=<nama mesin>
```

Kalau token belum diisi di mesin pengirim, pelaporannya ditolak `401` dan
dashboard tidak pernah bertambah — periksa `journalctl -u devwf-monitor`.

## Merotasi token

Token tulis bisa diganti dengan satu perintah, tanpa memutus mesin mana pun:

```bash
/root/command/rotate-monitor-token.sh            # mode kering: hanya melaporkan
/root/command/rotate-monitor-token.sh --apply    # benar-benar merotasi
/root/command/rotate-monitor-token.sh --revoke-previous   # cabut yang lama
```

Urutannya sengaja dibuat **tanpa downtime**:

1. Server diberi token baru, dan token lama disimpan sebagai
   `DEVWF_MONITOR_TOKEN_PREVIOUS` sehingga **masih diterima sementara**.
2. Mesin pengirim diperbarui satu per satu.
3. Setelah semua memakai yang baru, `--revoke-previous` mencabut yang lama.

Tanpa masa tenggang itu, setiap mesin yang belum diperbarui langsung ditolak
`401` dan kartunya hilang diam-diam — kegagalan yang baru ketahuan berhari-hari
kemudian.

Skrip **tidak pernah mencetak token**, dan membuat cadangan `.bak-<stamp>`
sebelum menulis. Cadangan itu memuat kredensial, jadi setelah rotasi diverifikasi
**hapus cadangannya** (`shred -u`).

Diuji 2 November 2026: token lama `401`, token baru `200`, tanpa token `401`,
`GET /api/sessions` tetap `200`. Ketiga mesin (`HELLOWORLD`, `MMCH`, `Mac`)
memakai token baru.

## Retensi: MATI secara bawaan

**Tidak ada data yang dihapus tanpa persetujuan eksplisit.** Aturan ini ada
karena penghapusan otomatis yang menyala sendiri adalah cara paling mudah
kehilangan riwayat tanpa ada yang menyadarinya.

Bawaan: `PRUNE_ENABLED` kosong → server menulis `retensi: MATI` di log saat
start dan tidak menjalankan satu pun `DELETE`. Diverifikasi dengan menanam
baris berumur 400 hari lalu restart: barisnya tetap ada.

Untuk menyalakannya, isi di `/etc/devwf-monitor.env`:

```
PRUNE_ENABLED=1
RETENTION_DAYS=30          # event lebih tua dari ini
SESSION_RETENTION_DAYS=7   # sesi idle lebih tua dari ini
PRUNE_EVERY_MS=21600000    # 6 jam
```

Hanya nilai `1`, `true`, atau `yes` yang menyalakan. Nilai lain tetap mati.

Saat aktif, pembersihan berjalan sekali saat start lalu tiap `PRUNE_EVERY_MS`:

| Tabel | Yang dibuang | Yang TIDAK pernah dibuang |
|---|---|---|
| `events` | baris lebih tua dari `RETENTION_DAYS` | — |
| `sessions` | `phase = 'idle'` lebih tua dari `SESSION_RETENTION_DAYS` | sesi yang masih bekerja |

Yang dihapus hanya **baris laporan di database dashboard**, bukan kode, git
history, atau state workflow. Data aslinya tetap di tiap mesin
(`.state/workflow-state.json`) dan di riwayat git.



## Dashboard yang mati tidak boleh tampak seperti dashboard yang sepi

Diukur 1 November 2026: dengan service `devwf-monitor` **dihentikan**, layar
tablet tidak berubah sama sekali — kartu yang sama, angka yang sama, tanpa satu
pun tanda ada yang salah. Diam bisa berarti dua hal yang sangat berbeda, dan
pemiliknya tidak punya cara membedakannya.

`/api/sessions` kini mengembalikan `health`:

```json
{ "lastReportAt": "2026-11-01T16:19:26.924Z", "ageMs": 22, "stale": false, "never": false }
```

Yang dihitung adalah **kapan laporan terakhir masuk** — bukan "apakah ada
pekerjaan". Berhentinya pekerjaan itu normal; berhentinya pelaporan itu
kerusakan. Bila tidak ada laporan lebih dari `STALE_AFTER_MS` (bawaan 10 menit),
halaman menampilkan peringatan kuning di atas daftar sesi.

`never: true` dibedakan supaya pesannya tepat: "belum pernah ada laporan"
mengarah ke konfigurasi `DEVWF_MONITOR_URL`/token, sedangkan laporan yang sudah
tua mengarah ke mesin pengirim atau service-nya.

Diverifikasi dua arah di kedua tablet lewat `uiautomator dump`: peringatan
muncul saat data sepi (`47m lalu`), dan hilang setelah ada laporan baru
(`ageMs: 22`).

## Status sesi: aktif, mungkin macet, berakhir

Diukur 1 November 2026: task yang **sudah selesai** (commit, rilis, deploy)
masih tampil sebagai kartu `CODING` 52 menit kemudian, karena penutupan manual
tidak selalu mengubah `phase` menjadi `idle`. Dashboard mengaku ada pekerjaan
hidup padahal tidak ada — kebohongan ke arah yang paling berbahaya, karena
pemiliknya menunggu sesuatu yang tidak akan datang.

Status kini **diturunkan dari umur laporan**, bukan diklaim dari `phase`:

| Status | Syarat | Tampilan |
|---|---|---|
| `idle` | `phase = 'idle'` | chip abu-abu |
| `live` | melapor ≤ 15 menit (`LIVE_MS`) | kartu biru |
| `possibly_stuck` | ≤ 2 jam (`STUCK_MS`) | kartu kuning + "mungkin berhenti di tengah jalan" |
| `ended` | > 2 jam | kartu redup + "kemungkinan sudah selesai tanpa penutupan" |

Kata "mungkin" dipakai sengaja: umur laporan **tidak dapat membuktikan** sesi
sudah mati, hanya bahwa kabarnya berhenti.

### Mengapa bukan pemeriksaan PID

Rencana awal adalah memeriksa `owner_pid` dari server. Itu **tidak bisa**
dilakukan: PID berlaku per mesin, dan server adalah mesin yang berbeda. Diuji
1 November 2026 — pid `11460` memang **hidup** di HELLOWORLD, tetapi
`kill -0 11460` di server gagal. Kalau diperiksa dari server, **setiap** sesi
akan tampak "sudah berakhir", bug yang lebih buruk daripada masalah aslinya.

Batasnya bisa diatur lewat `LIVE_MS` dan `STUCK_MS` di
`/etc/devwf-monitor.env`.

### Mengapa sesi berhenti melapor

Diperiksa 1 November 2026: sesi HELLOWORLD berhenti melapor setelah **74
menit** padahal prosesnya masih hidup. Itu **bukan kerusakan** — implementasi
ini memang hanya melapor saat `save()` dipanggil, jadi sesi yang menganggur
tidak mengirim apa pun. Tidak ada penolakan token di log, tidak ada error.

Konsekuensinya dulu: task yang sudah selesai tetap tampak "mungkin macet"
sampai jendela 2 jam habis, karena tidak ada kabar penutupan yang dikirim.

Sekarang snapshot dengan fase `idle` (yaitu penutupan task) **selalu dikirim
dan selalu ditunggu**, melewati aturan boot. Itulah satu-satunya kabar yang
membuat kartu di tablet hilang. Laporan rutin tetap mengikuti aturan boot agar
startup tetap di bawah 2 detik.

Diverifikasi dengan sesi sungguhan: `start_task` → kartu tampil `live`, lalu
`drop_task` → baris langsung menjadi `idle` dan kartunya hilang.

## Sesi `idle` yang basi disembunyikan
Proses MCP mati bersama sesi OpenCode-nya, jadi baris `idle` tinggal selamanya.
Tanpa filter, dashboard yang dipakai berhari-hari memenuhi layar tablet dengan
sesi yang sudah tidak ada prosesnya.

Ada **dua** batas umur, karena dua hal berbeda:

| Jenis sesi | Batas | Alasan |
|---|---|---|
| `idle` **tanpa** task | `EMPTY_IDLE_TTL` (5 menit) | Kartunya hanya berbunyi "IDLE (tanpa task)" — tidak memberi informasi, tetapi menempati satu slot penuh di layar tablet |
| `idle` **dengan** task | `IDLE_TTL` (30 menit) | Menyimpan riwayat pekerjaan yang baru selesai, masih berguna sesudah commit |
| `coding` dan fase lain | tanpa batas | Satu tugas panjang yang jarang menyimpan state tetap pekerjaan nyata |

```sql
WHERE NOT (
        phase = 'idle'
        AND (
          (task = '' AND updated_at < now() - $3::interval)   -- idle kosong
          OR updated_at < now() - $2::interval                -- idle bertask
        )
      )
```

Diukur 1 November 2026: kedua tablet hanya menampilkan satu kartu
"IDLE (tanpa task)" padahal dashboard penuh sesi nyata di mesin lain. Sesudah
perbaikan, `uiautomator dump` pada kedua tablet membaca judul, fase `CODING`,
nama task, dan progres rencana sekaligus.

Atur lewat `IDLE_TTL` dan `EMPTY_IDLE_TTL` di `/etc/devwf-monitor.env` (format
interval Postgres, mis. `2 hours`).

## Deploy

```bash
scp monitor-server/dashboard.cjs        root@100.107.65.21:/tmp/monitor.cjs
scp monitor-server/sessions-query.cjs   root@100.107.65.21:/tmp/sessions-query.cjs
scp monitor-server/devwf-monitor.service root@100.107.65.21:/tmp/devwf-monitor.service
ssh root@100.107.65.21
install -d -m 755 /opt/devwf-monitor
install -m 644 /tmp/monitor.cjs /tmp/sessions-query.cjs /opt/devwf-monitor/
install -m 644 /tmp/devwf-monitor.service /etc/systemd/system/devwf-monitor.service
install -m 600 /dev/null /etc/devwf-monitor.env   # isi DATABASE_URL
systemctl daemon-reload && systemctl restart devwf-monitor
curl -s http://100.107.65.21:3100/health
```

`dashboard.cjs` memerlukan paket `pg` di `/opt/devwf-monitor/node_modules`.

## Sisi klien

Setiap mesin mengirim laporan bila dua variabel ini diset di environment server
MCP:

```
DEVWF_MONITOR_URL=http://100.107.65.21:3100
DEVWF_MACHINE=<nama mesin>
```

Tanpa `DEVWF_MONITOR_URL`, pelaporan tidak aktif sama sekali dan tidak ada
permintaan jaringan keluar.

## Suite tes tidak boleh menulis ke dashboard

`tests/setup-env.js` mengosongkan `DEVWF_MONITOR_URL` untuk seluruh proses tes.

Tanpa itu, mesin yang memang memakai dashboard — variabelnya ada di environment
— akan mengirim setiap sesi palsu dari suite ke database **produksi** setiap
kali `npm test` dijalankan. Terjadi 1 November 2026: sembilan kartu
"Task sesi X", "Task tanpa metadata", dan "Task milik sesi A/B" muncul di layar
tablet, dan sesi sungguhan tenggelam di antaranya.

Isolasi state (`DEV_WORKFLOW_STATE_FILE`, `DEV_WORKFLOW_DB_PATH`) sudah ada
sebelumnya; yang terlupa adalah jalur keluar. Tes yang sengaja menguji
pelaporan mengisi variabel itu sendiri, jadi perilaku aslinya tetap teruji.
`tests/setup-env-isolation.test.js` menjaga keduanya: URL monitor kosong, dan
isolasi state tetap ada.

Untuk membersihkan baris yang sudah terlanjur masuk:

```sql
DELETE FROM sessions WHERE session_key IN ('ses-aaa','ses-bbb','ses_XXX','ses_YYY','ses_AAA','ses_BBB');
DELETE FROM events   WHERE detail LIKE 'Coba %' OR detail = 'feat: add feature';
```

Periksa dulu dengan `SELECT` — jangan hapus berdasarkan pola waktu saja, karena
sesi nyata bisa jatuh di jendela yang sama.

## Peringatan: monitor yang memberi tahu, bukan yang ditunggu

Sampai 2 November 2026 tablet hanya berguna kalau pemilik ingat melihatnya.
Sesi yang macet dan mesin yang berhenti melapor tidak pernah memberi tahu siapa
pun. `monitor-server/alerts.cjs` menutup itu.

| Kejadian | Ambang | Jenis |
|---|---|---|
| Sesi `possibly_stuck` makin lama diam | 30 menit | `sesi_macet` |
| Mesin tidak melapor | 24 jam (`MACHINE_SILENT_MS`) | `mesin_diam` |

Ambangnya bisa diatur lewat `STUCK_ALERT_MS` dan `MACHINE_SILENT_MS`.

Tiga aturan yang tidak boleh dilanggar:

1. **Tidak mengklaim lebih dari yang bisa dibuktikan.** Dari server, sesi yang
   diam tidak bisa dibedakan antara "macet" dan "task sudah ditutup lalu
   ditinggal". Karena itu labelnya "mungkin macet", dan mesin yang diam disebut
   "tidak melapor" — **bukan "mati"**. Dua kali kesalahan ini saya ulangi
   (ambang 30 menit, label `online`/`offline`) dan keduanya berbohong ke arah
   yang sama.

2. **Ambang harus longgar.** Peringatan yang berbunyi terlalu sering akan
   diabaikan, dan itu sama saja dengan tidak punya peringatan.

3. **`idle` tidak pernah diperingatkan.** `idle` berarti task DITUTUP. Diam
   adalah hasil yang benar, bukan masalah.

Peringatan dihitung server dari baris yang **sama** dengan yang tampil
(`sessions: tampil`), jadi angkanya tidak bisa berbeda dengan isi layar. Aturan
ini dijaga `tests/monitor-alert-wiring.test.js`.

Terbukti 2 November 2026: sesi yang sedang berjalan melewati ambang 30 menit dan
kotak "1 hal perlu dilihat" muncul sendiri di web dan kedua tablet, tanpa data
buatan.

## Riwayat tidak boleh kehilangan baris

`started_at` hanya dipakai untuk **menghitung** durasi, bukan untuk menyaring.
Sempat dijadikan syarat masuk riwayat, dan akibatnya 3 dari 9 sesi hilang: sesi
itu terlihat di tab Aktif lalu tidak ditemukan di Riwayat. Kalau `started_at`
kosong, durasinya "tidak tercatat" — bukan 0 detik, dan bukan alasan membuang
barisnya.

## Nama proyek tidak boleh hilang saat task ditutup

Sesi yang **sudah selesai** justru yang kehilangan `project_name` — 5 dari 9
sesi pada 2 November 2026. Sebabnya satu baris di UPSERT:

```sql
project_name=EXCLUDED.project_name   -- menimpa dengan '' saat complete_task
```

`complete_task` tidak mengirim `projectPath`, jadi nama proyek terhapus tepat
ketika pekerjaan itu selesai — saat catatannya paling berguna. `session_title`
sudah dijaga sejak awal; nama proyek terlewat.

Aturan yang sekarang dipegang (`monitor-server/session-upsert.cjs`):

| Kolom | Dilindungi dari kiriman kosong? | Alasan |
|---|---|---|
| `project_name`, `project_path` | **ya** | identitas, tidak boleh hilang |
| `session_title`, `agent_tool` | **ya** | datang belakangan, bisa kosong sementara |
| `started_at` | ya, ambil yang paling awal | lihat catatan `LEAST`/`GREATEST` |
| `task` | **tidak** | `task=''` adalah cara sah menutup task |

`agent_tool` butuh perhatian khusus: nilai bawaan `'unknown'` **bukan** string
kosong, jadi kalau dipakai sebagai nilai `EXCLUDED` ia akan menimpa label
`codex` yang sudah benar. Karena itu `'unknown'` ditempatkan sebagai pilihan
terakhir: `COALESCE(NULLIF(EXCLUDED.agent_tool,''), sessions.agent_tool, 'unknown')`.

Terbukti di produksi: kirim laporan dengan `projectName`, lalu kirim laporan
tanpa `projectName` — nama proyek dan `agent_tool` tetap ada.

## Rekap durasi per proyek

Timer per sesi tidak pernah dijumlahkan, jadi pemilik tahu satu sesi memakan 45
menit tetapi tidak tahu ke mana waktunya pergi. `project-summary.cjs` menutup
itu; tampil sebagai tab **Rekap** di aplikasi dan bagian "Waktu per proyek" di
web. Batas hari diatur `SUMMARY_DAYS` (bawaan 7).

Tiga keputusan:

1. **Hanya sesi yang sudah ditutup** (`phase = 'idle'`). Durasi sesi berjalan
   masih bertambah; memasukkannya membuat rekap berubah tiap 3 detik dan tidak
   bisa dibandingkan antar hari.
2. **`(tanpa proyek)` dipisah, tidak ditebak.** Sesi lama kehilangan namanya
   karena bug di atas. Menebak dari jalur atau judul berarti mengarang data.
3. **Rekap ini hanya mungkin setelah `project_name` diperbaiki.** Tanpa
   perbaikan itu, rekap selalu kosong.

## 'unknown' bukan nilai, dan bukan izin menimpa

Perbaikan pertama saya untuk `agent_tool` **lulus seluruh tes sambil tetap
salah**. Tesnya memeriksa *teks SQL*, dan teks itu memang benar adanya — tetapi
artinya tidak sesuai harapan, karena `'unknown'` **bukan string kosong**, jadi
ia lolos dari `NULLIF(..., '')` dan tetap menimpa label `codex` yang sudah benar.

Terbukti di produksi 2 November 2026:

```
laporan agentTool=codex    -> tersimpan codex
laporan agentTool=unknown  -> tersimpan unknown   <- codex HILANG
```

Akibatnya 4 dari 9 sesi berlabel `unknown`.

### Aturan yang sekarang

```sql
agent_tool = CASE
  WHEN NULLIF(EXCLUDED.agent_tool, '') IS NULL           -- tidak dikirim
    THEN COALESCE(NULLIF(sessions.agent_tool, ''), 'unknown')
  WHEN lower(EXCLUDED.agent_tool) = 'unknown'            -- dikirim, tapi tidak tahu
    THEN COALESCE(NULLIF(sessions.agent_tool, ''), 'unknown')
  ELSE EXCLUDED.agent_tool                               -- tool lain: ganti
END
```

`'unknown'` tetap **disimpan** untuk baris yang belum pernah punya label —
kalau dikosongkan, layar kehilangan kemampuan membedakan "belum tahu" dari
"kosong". Yang tidak boleh adalah ia **menimpa** label yang sudah ada.

### Mengapa tesnya sekarang menyentuh database

`tests/monitor-upsert-behavior.test.js` menjalankan SQL **sungguhan** ke
PostgreSQL dan memeriksa isi tabel. Ini pelajaran langsung: tes yang hanya
memeriksa bentuk SQL tidak akan pernah menangkap kelas kesalahan ini.

Butuh `DEVWF_TEST_PG` (atau PostgreSQL di `127.0.0.1:5599`). Bila tidak ada,
tes **dilewati dengan alasan yang terlihat** — bukan lulus diam-diam.

### Data lama

Dua sesi bisa dipulihkan dengan bukti: kuncinya berawalan `ses_` (berasal dari
meta `ai.opencode/sessionID`) **dan** kunci yang sama ada di `opencode.db`
mesin masing-masing. Dua sesi lain berawalan `pid-` dan **sengaja dibiarkan**
`unknown` — tidak ada bukti tool mana yang menjalankannya, dan menebak berarti
mengarang data.

## Audit: "nilai kosong / gagal dibaca dianggap hapus" (2 November 2026)

Audit seluruh jalur tulis repo — SQL, berkas, dan API — mencari pola di mana
data lama hilang karena kiriman baru kosong ATAU karena **bacaan gagal
disamakan dengan "kosong"**. Pola ini berakar dari 29 Oktober 2026: dua
proses MCP saling menimpa state, dan `agent_tool` menimpa label yang benar.
Setiap temuan di bawah ini punya bukti (uji nyata), bukan dugaan.

### Temuan, per jalur tulis

| Jalur tulis | Status | Alasan |
|---|---|---|
| `sessions` UPSERT (`session-upsert.cjs`) | ✅ aman | identitas dilindungi dari kosong-overwrite; `unknown` memakai CASE eksplisit (bagian di atas). |
| `events` INSERT (`dashboard.cjs`) | ✅ aman | append-only: tidak ada `UPDATE`/`DELETE` per baris. |
| Prune `events`/`sessions` (`retention.cjs`) | ✅ aman | DELETE hanya jalan bila `PRUNE_ENABLED=1` — default mati, teruji di `monitor-prune-default-off.test.js`. |
| history bersama (`workflow-state.js: writeHistoryFile`) | 🔴 → ✅ | Kegagalan baca (EBUSY/EMFILE) diperlakukan sebagai "tidak ada isi", lalu berkas ditulis ulang dari nol — **menghapus riwayat seluruh sesi lain**. Perbaikan: bacaan membedakan `missing/ok/corrupt/unreadable`; `unreadable` menolak penulisan, `corrupt` disalin ke `*.corrupt-*` dulu. |
| state sesi (`readDiskState` → `save`) | 🔴 → ✅ | Kegagalan baca membuat state memori menimpa state yang lebih baru milik proses lain. Perbaikan: percobaan ulang singkat; kalau tetap tidak terbaca, **gagal keras** — tidak menimpa. |
| state sesi rusak | 🟡 → ✅ | JSON rusak dulu ditimpa diam-diam. Sekarang disalin ke `*.corrupt-*` lalu `load()` gagal dengan pesan yang menyebut lokasi cadangan: state aktif tidak boleh diganti state kosong diam-diam. |
| identitas user (`user-id`, `resolveUserId`) | 🟡 → ✅ | Dua proses start bersamaan membuat dua ID berbeda; penulis terakhir menang dan riwayat sesi pertama terlepas dari pemiliknya. Perbaikan: pembuatan berkas memakai flag `wx`, lalu membaca ID pemenang. Berkas yang ada tetapi tidak terbaca TIDAK ditimpa. |
| pesan commit (`commit-handlers.js`) | 🟡 → ✅ | `getLastCommitMessage()` gagal membaca membuat `lastCommitMessage` terhapus menjadi string kosong. Perbaikan: nilai lama dipertahankan saat nilai baru kosong. |
| history DB upsert (`db/adapters/*`) | 🟡 tercatat | `commit_message`/`force_reason` ditimpa nilai kiriman saat entri yang sama disinkronkan ulang — tidak terbukti berbahaya karena entri history tidak berubah setelah tercatat; ditolak karena perubahan akan mengacaukan kunci baris. |
| state DB (`workflow_state`) | 🟡 tercatat | Baris `(user, proyek)` dimiliki bersama dua sesi; sesi yang idle menimpa state sesi aktif. Tidak bahaya nyata: baris ini tidak pernah DIBACA oleh kode apa pun (`getState` tak terpakai). |
| Factory `update_task` | ✅ aman | Field yang tidak dikirim tidak masuk payload; panjang minimal ditolak. |
| Factory `move_task`/`work start/finish/heartbeat` | ✅ aman | alasan/step kosong = field tidak dikirim, bukan string kosong. |
| `pinSessionProject`, proses lock, `release-wrapper`, `install` | ✅ aman | menulis path yang eksplisit dari pemanggil, bukan dari bacaan yang bisa kosong. |
| skrip `setup-stack.js` | ✅ aman | alat sekali jalan, menulis template config/AGENTS.md baru. |

### Aturan yang sekarang berlaku

1. **Gagal membaca bukan berarti kosong.** Fungsi pembaca selalu mengembalikan
   status eksplisit (`missing/ok/corrupt/unreadable`); pemanggil dilarang
   menyamaratakannya.
2. **Berkas aktif (state) tidak boleh ditimpa dari state basi**: gagal baca →
   percobaan ulang → gagal keras, tidak diam-diam.
3. **Berkas bersama (history) tidak boleh dihapus karena terkunci sesaat**:
   tulis ditolak; hanya `corrupt` yang disalin dulu ke `*.corrupt-*`.
4. **Identitas tidak pernah diciptakan ulang**: pembuatan memakai `wx` dan
   membaca pemenang.

### Diuji

- `tests/state-write-safety.test.js` — sembilan tes perilaku pada berkas
  SUNGGUHAN: history yang EBUSY/RUSAK, state yang EBUSY/RUSAK, identitas
  yang sudah ada/kosong/tidak terbaca.
- `tests/handlers-commit.test.js` — "pesan commit lama tidak dihapus saat
  git tidak bisa membacanya".

## Diuji

- `tests/monitor-sessions-query.test.js` — filter hanya menyentuh `idle`, limit
  tetap parameter SQL.
- `tests/monitor-report.test.js` — bentuk snapshot dan klien pelapor.
- `tests/monitor-events.test.js` — peristiwa terkirim dan monitor mati tidak
  mengubah hasil tool.
- `tests/monitor-boot.test.js` — boot tidak menunggu monitor yang menggantung.
- `tests/monitor-machines.test.js` — ambang mesin dalam HARI, bukan menit, dan
  teks `online`/`offline` tidak boleh kembali.
- `tests/monitor-history.test.js` — riwayat memuat semua status, dan baris tanpa
  `started_at` tidak hilang.
- `tests/monitor-alerts.test.js` — kapan peringatan menyala dan kapan TIDAK.
- `tests/monitor-alert-wiring.test.js` — server mengirim `alerts`, kedua layar
  menampilkannya, dan teksnya tidak pernah mengklaim mesin "mati".
- `tests/monitor-app-nav.test.js` — empat tab, filter status, dan penamaan sesi.
- `tests/monitor-app-grid.test.js` — dua kolom dan detail yang ikut data terbaru.
- `tests/monitor-session-upsert.test.js` — `project_name` tidak boleh terhapus
  oleh kiriman kosong, `task` tetap boleh, dan `agent_tool` tidak tertimpa
  `'unknown'`.
- `tests/monitor-project-summary.test.js` — rekap per proyek, hanya sesi
  selesai, dan `(tanpa proyek)` tidak ditebak.
- `tests/monitor-summary-wiring.test.js` — rekap dikirim server dan tampil di
  kedua layar.
- `tests/monitor-upsert-behavior.test.js` — **menjalankan SQL sungguhan ke
  PostgreSQL**: `unknown` tidak menimpa `codex`, tool baru tetap menggantikan,
  `project_name` bertahan, dan `started_at` tidak hilang.
