# Live dashboard (devwf-monitor)

Dashboard yang menampilkan sesi `dev-workflow` dari semua mesin secara
langsung, tanpa login, di jaringan Tailscale.

URL: `http://100.77.138.14:3100`

The monitor runs on **bw-tools**. It moved there from the database-only host
`bw-server-clean` on 2026-11-09; PostgreSQL itself still lives on
`bw-server-clean` (`100.107.65.21:5432`), so `DATABASE_URL` points across the
tailnet. Any client still pointing at the old `bw-server-clean` monitor port
reports to a host with no listener, so its sessions never appear here.

## Build execution location and Android visibility

`report_build_status` accepts `buildHost` for the machine that actually executes a build, test, scan, or deployment command. Set this field when the command runs on a remote builder. It is retained through progress and terminal updates for the same build and cleared when a new target begins. The reporting device (`machine`) remains separate from the executor. When `buildHost` is absent, the web and Android views say that the host was not reported and identify the reporting device instead of guessing where the command ran.

Build and test events include the same session key as the monitor snapshot, so recent event history can be attached to the correct session. Build event JSON is kept intact within a bounded payload instead of being cut mid-document; this preserves the reported host after a monitor restart.

The web monitor displays the location in its build summary and session detail. The Android app has a Build tab and a shortcut on the Active tab. Running builds appear first, followed by recent builds visible in the monitor session and event response. The mobile card shows status, target, location, stage, progress, project, and time; tapping it opens session detail. Android APKs must be rebuilt and reinstalled for native UI changes to appear on a device.

## Zettly Draw Mermaid Flow Preview

When an agent executes `create_feature_flow`, a canonical Zettly Draw canvas is created and linked to the active task. The DevWorkflow live monitor surfaces this diagram directly in session cards and modal details:
- **Inline Preview**: Session cards display an inline SVG thumbnail preview of the recorded architecture flow diagram fetched from `/api/drawings/:id/thumbnail`.
- **Flow Modal Lightbox**: Clicking the preview thumbnail opens an enlarged modal (`#modal-flow`) rendering the full vector diagram cleanly with high resolution.
- **Export & Navigation**: The modal provides a one-click "Download PNG" button that converts the vector diagram into a downloadable high-resolution PNG image without requiring navigation away from the dashboard, as well as a direct link to open and edit the drawing in Zettly Draw.
- **Server Endpoint**: `/api/drawings/:id/thumbnail` serves the cached SVG diagram with `image/svg+xml` content type directly from the Zettly database connection.

Berkas di `monitor-server/`:

| Berkas | Isi |
|---|---|
| `dashboard.cjs` | Server HTTP: `/`, `/health`, `/api/sessions`, `/api/events`, `/api/share`, `POST /api/session`, `POST /api/event` |
| `sessions-query.cjs` | Penyusun SQL daftar sesi (tanpa jaringan, bisa diuji) |
| `share-links.cjs` | Token, URL publik, dan SQL `share_links` (murni) |
| `share-page.cjs` | Halaman publik + OG tag + `PUBLIC_DENY` (murni) |
| `share-route.cjs` | Penjaga Origin/header dan handler create/revoke/list |
| `share-server.cjs` | Server publik `127.0.0.1:3200`, hanya `GET`/`HEAD` |
| `devwf-monitor.service` | Unit systemd; kredensial dibaca dari `EnvironmentFile` |
| `devwf-share.service` | Unit systemd untuk server publik |
| `cloudflared-devwf-share.service` | Unit systemd tunnel `devwf-share` |
| `share-tunnel.yml` | Config tunnel: `devwfshare.programinglive.com` -> `127.0.0.1:3200` |
| `devwf-monitor.env.example` | Contoh isi `/etc/devwf-monitor.env` |

## Mengapa proses terpisah

The MCP server is spawned per OpenCode session and exits with it. The dashboard
and its Postgres connection must outlive those processes, so MCP servers push
state without waiting and this service reads it. In addition to reports on
workflow changes, each connected MCP process sends a lightweight snapshot every
30 seconds. This keeps the client session visible before the agent calls a
`dev-workflow` tool; active task details still come from workflow state.

Taskless heartbeats contain session, machine, and agent metadata only. They stop
when the MCP process exits, after which the taskless idle card expires according
to `EMPTY_IDLE_TTL` (one minute). The default 30-second interval can be adjusted
with `DEVWF_MONITOR_HEARTBEAT_MS` (100–60000 ms). The server cannot report clients
that are not connected to the `dev-workflow` MCP.

## Mengemudikan tablet lewat adb

Kedua tablet membuka adb TCP di port 5555 di alamat Tailscale-nya:

```powershell
adb connect 100.81.240.34:5555    # Xiaomi Pad 6 (p1pa)
adb connect 100.126.241.90:5555   # POCO Pad M1
adb -s 100.81.240.34:5555 shell am start -n com.android.chrome/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d http://100.77.138.14:3100
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

## Baris `coding` yang tasknya sudah selesai

Kunci tabel `sessions` adalah `(session_key, task_id)`. Sebelum perbaikan
9 November 2026, laporan penutupan tidak membawa `task_id` sehingga menulis
baris baru dan meninggalkan baris aslinya di fase `coding`. Baris itu lalu
tampil sebagai `mungkin macet` walaupun Factory sudah melaporkan task `done`.

Cara memeriksa dan membersihkannya:

```bash
# 1. Lihat baris yang fasenya belum terminal
curl -s http://100.77.138.14:3100/api/sessions | jq '[.sessions[] | select(.state=="possibly_stuck")]'

# 2. Pastikan task-nya memang selesai di Factory sebelum menutup apa pun
#    (tools.factory.factory_get_task). Task yang masih berjalan TIDAK boleh
#    ditutup - monitor akan kehilangan pekerjaan yang benar-benar hidup.

# 3. Tutup lewat endpoint resmi, satu per satu
curl -s -X POST http://100.77.138.14:3100/api/session/close \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $DEVWF_MONITOR_TOKEN" \
  -d '{"sessionKey":"ses_...::card","reason":"Task finished in Factory"}'
```

Perbaikan pada pelapor (`workflow-state.js`) mencegah baris baru terbentuk.
Untuk baris lama, langkah di atas adalah satu-satunya jalur yang benar;
mengubah `phase` langsung di database akan melewati kolom turunan lain.

### Reopening the session close control

After a successful manual close, the detail modal's button becomes disabled and
shows a success state. Opening another session must reset that button before
binding the next session key. Otherwise the next stale card cannot be closed
from the dashboard even though its session is still active.

The machine list omits the retired synthetic `uji` report from
2026-11-03T10:10:45.095Z. The stored session remains in history. A newer
report from a machine with the same name is shown normally; the filter does
not use a broad age cutoff that could hide a real silent device.

### Membandingkan berkas yang terpasang dengan `main`

`/opt/devwf-monitor/monitor.cjs` ditulis di server dengan **CRLF**, sedangkan
repo memakai **LF**. Selisih ukuran berkas karena itu normal - pada 9 November
2026 jarak 2.212 byte ternyata persis sama dengan jumlah barisnya. Jangan
menyimpulkan ada kode yang hilang dari ukuran saja; bandingkan setelah
normalisasi:

```bash
ssh bw-tools "cd /opt/devwf-monitor && tr -d '\r' < monitor.cjs | sha256sum"
# lalu bandingkan dengan sha256 berkas repo yang sudah di-LF-kan
```

Pada 9 November 2026 hasil keduanya `7e870e32…`, jadi tidak pernah ada drift
kode - satu-satunya perbedaan semantik adalah baris `DEVWF_SHARE_ORIGINS`.

## Mengapa hanya menyimak IP Tailscale

`HOST=100.77.138.14` mengikat server ke alamat Tailscale saja. Bind ke
`127.0.0.1` tidak bisa dijangkau tablet; bind ke `0.0.0.0` membuka dashboard ke
internet publik tanpa autentikasi. Dengan cara ini dashboard terbuka untuk
perangkat di tailnet dan tidak terlihat dari luar.

## Kredensial

Jangan menaruh `DATABASE_URL` di unit systemd: `systemctl cat` dapat dibaca
siapa pun yang punya akses baca ke unit. Kredensial ada di
`/etc/devwf-monitor.env` dengan mode `600`:

```
DATABASE_URL=postgres://devwf:SANDI@100.107.65.21:5432/devwf_monitor
DEVWF_MONITOR_TOKEN=<token acak panjang>
IDLE_TTL=30 minutes
EMPTY_IDLE_TTL=1 minute
```

`100.107.65.21` here is PostgreSQL on `bw-server-clean`, not the monitor host.
The monitor process runs on `bw-tools` and reaches this database over the
tailnet, which is why the unit no longer depends on a local `postgresql.service`.

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
DEVWF_MONITOR_URL=http://100.77.138.14:3100
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

Pengecualian penting (7 November 2026): `closed`, `done`, `cancelled`, dan
`archived` adalah **fase terminal**, bukan tebakan dari umur. Keempatnya
langsung `ended` dengan penanda `terminal: true`, walau baru ditutup sedetik
lalu. Sebelum ini sesi yang ditutup manual tampil "aktif" di Riwayat dan masuk
filter **Live**, bukan **Selesai**, semata-mata karena `updated_at` baru.

Tab Aktif juga tidak lagi menyimpan sesi non-idle yang sudah "berakhir":
`buildSessionsQuery` membuang baris non-idle yang lebih tua dari `stuckTtl`
(bawaan `2 hours`). Sebelumnya dua kartu "berakhir" menetap selamanya di Aktif
karena filter hanya menyentuh `phase = 'idle'`.

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
| `idle` **tanpa** task | `EMPTY_IDLE_TTL` (1 menit) | Kartunya hanya berbunyi "IDLE (tanpa task)" — cepat disembunyikan agar layar fokus ke task nyata |
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

JavaScript dashboard berjalan di browser, terpisah dari konstanta Node pada
server. Referensi interval seperti `POLL_MS` harus diinterpolasi ke template
halaman (`${POLL_MS}`) agar browser menerima angka literal. Jika dibiarkan
sebagai `POLL_MS`, pembaruan halaman gagal dengan `terputus: POLL_MS is not
defined` setelah data pertama diterima.

Validasi juga JavaScript hasil render template, bukan hanya `dashboard.cjs`.
Escape seperti `\n` di template dapat berubah menjadi newline di dalam string
JavaScript browser; akibatnya server tetap menjawab HTTP 200 sementara polling
dashboard tidak pernah berjalan.

```bash
scp monitor-server/dashboard.cjs        root@100.77.138.14:/tmp/monitor.cjs
scp monitor-server/build-monitor.cjs    root@100.77.138.14:/tmp/build-monitor.cjs
scp monitor-server/sessions-query.cjs   root@100.77.138.14:/tmp/sessions-query.cjs
scp monitor-server/devwf-monitor.service root@100.77.138.14:/tmp/devwf-monitor.service
ssh root@100.77.138.14
install -d -m 755 /opt/devwf-monitor
install -m 644 /tmp/monitor.cjs /tmp/build-monitor.cjs /tmp/sessions-query.cjs /opt/devwf-monitor/
install -m 644 /tmp/devwf-monitor.service /etc/systemd/system/devwf-monitor.service
install -m 600 /dev/null /etc/devwf-monitor.env   # isi DATABASE_URL
systemctl daemon-reload && systemctl restart devwf-monitor
curl -s http://100.77.138.14:3100/health
```

`dashboard.cjs` memerlukan paket `pg` di `/opt/devwf-monitor/node_modules`.

## Sisi klien

Setiap mesin mengirim laporan bila dua variabel ini diset di environment server
MCP:

```
DEVWF_MONITOR_URL=http://100.77.138.14:3100
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

## Repository di kartu sesi (7 November 2026)

Kartu yang hanya berbunyi "clinic" tidak menjawab pertanyaan pemilik: *proyeknya
ada di mana?* Path lokal sudah tersimpan di `project_path` tetapi hanya muncul di
modal detail, dan remote git belum pernah diambil sama sekali.

Sekarang `start_task` menangkap identitas repository sekali per task
(`repository.js`), lalu menyimpannya di state:

```json
{ "repository": { "path": "D:/code/clinic", "remote": "https://github.com/org/clinic.git" } }
```

- `git rev-parse --show-toplevel` → `path`
- `git remote get-url origin` → `remote`

Keduanya best-effort: direktori yang bukan repo, `git` yang tidak ada, atau
perintah yang gagal menghasilkan `{ path: "", remote: "" }` dan **tidak pernah**
menggagalkan `start_task`. Hasil kosong tetap disimpan supaya setiap `save()`
tidak memanggil `git` berulang kali.

Alurnya: `monitor.js` mengirim `repositoryPath`/`repositoryRemote` di snapshot →
`session-upsert.cjs` menyimpannya di kolom `repo_path`/`repo_remote` →
`monitor-server/repo-link.cjs` mengubah remote menjadi alamat web →
`/api/sessions` mengirim `repo_url`/`repo_label` → kartu dan modal menampilkan
tautan `🔗 <owner>/<repo> ↗`, sedangkan path lokal tetap ada di modal.

`repo-link.cjs` menerima `git@github.com:org/repo.git` (bentuk scp),
`ssh://git@host/org/repo.git`, `git://…`, `http(s)://…`; hasilnya selalu
`https://…` tanpa sufiks `.git` dan tanpa kredensial yang tertanam di remote.
Skema selain web (mis. `javascript:` atau `file:`) **tidak pernah** dijadikan
tautan. Sesi yang remote-nya kosong tetap punya `repo_path`, hanya tanpa tautan —
alamatnya tidak ditebak.

Kolom baru ditambahkan oleh migrasi idempoten saat dashboard boot. Dashboard
berjalan sebagai user aplikasi yang **bukan** pemilik tabel, jadi migrasi
memeriksa `information_schema` lebih dulu dan hanya mencetak SQL bila kolomnya
benar-benar belum ada. SQL manualnya:

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repo_path text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repo_remote text NOT NULL DEFAULT '';
```

Sama seperti `project_name`, kedua kolom memakai
`COALESCE(NULLIF(EXCLUDED.repo_path,''), sessions.repo_path)`: laporan ringkas
saat task ditutup tidak boleh menghapus lokasi proyek yang sudah tercatat.

## Peringatan flow yang belum ada

Kartu task tanpa relasi `zettly_draw` sekarang menampilkan
`⚠ Flow belum ada — jalankan create_feature_flow`. Sebelumnya preview flow
hilang diam-diam, sehingga task yang melewati gerbang Mermaid tidak bisa
dibedakan dari task yang flow-nya gagal terkirim. `create_feature_flow` juga
melaporkan snapshot sekali lagi setelah drawing ditautkan, karena relasi itu
ditambahkan **sesudah** penyimpanan state.

## Rekap durasi per proyek

Timer per sesi tidak pernah dijumlahkan, jadi pemilik tahu satu sesi memakan 45
menit tetapi tidak tahu ke mana waktunya pergi. `project-summary.cjs` menutup
itu; tampil sebagai tab **Rekap** di aplikasi dan bagian "Waktu per proyek" di
web. Batas hari diatur `SUMMARY_DAYS` (bawaan 7).

Tiga keputusan:

1. **Hanya sesi yang sudah final** (`phase IN ('idle','closed','done','cancelled')`).
   Durasi sesi berjalan masih bertambah; memasukkannya membuat rekap berubah
   tiap 3 detik dan tidak bisa dibandingkan antar hari. Fase terminal ikut
   dihitung sejak 7 November 2026: sesi yang ditutup manual dulu hilang dari
   rekap karena query hanya menerima `idle`.
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


## Tautan berbagi sesi (share)

Setiap sesi bisa dibagikan lewat tautan publik di domain utama:

```
https://devworkflow.programinglive.com/s/<token>
```

Tautan ini **permanen sampai dicabut**. Siapa pun yang memegangnya bisa
membacanya tanpa login - itu memang tujuannya, supaya bisa ditempel ke
WhatsApp. Isinya dibatasi ke status kerja.

### Kenapa halaman publik dilayani proses KEDUA

Situs `devworkflow.programinglive.com` adalah static export Netlify: tidak ada
runtime, jadi ia tidak bisa membaca Postgres. Karena itu ada `share-server.cjs`
di `127.0.0.1:3200`, dan Netlify mem-proxy `/s/*` ke tunnel yang mengarah ke
sana.

Memisahkan prosesnya juga membagi wewenang dengan bersih:

| Port | Bind | Boleh menulis | Terjangkau |
|---|---|---|---|
| 3100 `dashboard.cjs` | IP Tailscale | ya (buat/cabut tautan) | tailnet saja |
| 3200 `share-server.cjs` | `127.0.0.1` | **tidak ada jalur tulis** | internet, lewat tunnel |

Kalau keduanya disatukan, satu kesalahan routing berubah menjadi "siapa pun di
internet bisa membuat tautan atas nama pemilik".

### Endpoint

| Method | Path (port 3100) | Isi |
|---|---|---|
| `POST` | `/api/share` | body `{ sessionKey }` -> `{ token, url, fallbackUrl, views }`. Idempoten: menekan Bagikan dua kali mengembalikan token yang sama. |
| `DELETE` | `/api/share?token=...` | setel `revoked_at`; balas `{ ok, revoked }` |
| `GET` | `/api/share?sessionKey=...` | tautan hidup sesi itu, atau `{ url: null }` |
| `GET` | `/api/share?all=1` | **semua** tautan hidup, termasuk yang sesinya sudah hilang; dipakai panel dashboard |
| `POST` | `/api/share?revoke-orphans=1` | cabut **hanya** tautan yang baris sesinya sudah tidak ada; balas `{ ok, revoked }` |

### Keputusan: TIDAK ada kedaluwarsa otomatis

Pemilik meminta tautan permanen sampai dicabut, jadi pertumbuhan data
diselesaikan dengan **membereskan**, bukan membunuh tautan diam-diam. Empat
alasan, dan yang keempat yang paling menentukan:

1. Tautan di grup WhatsApp yang tiba-tiba 404 membuat orang mengira sistemnya
   rusak, dan mereka akan bertanya kepada Anda - biaya yang lebih besar
   daripada satu baris database.
2. Kedaluwarsa memaksa tanggal yang harus ditebak: umur berapa yang benar?
   Tidak ada jawaban yang tidak sewenang-wenang.
3. `views` dan `last_view_at` tetap berguna sebagai catatan siapa pernah
   membaca; tautan mati menghapus gunanya.
4. **Umur adalah proksi yang salah.** Sesi `idle` hilang dari layar setelah 30
   menit, tetapi task yang selesai kemarin masih berguna dibagikan lagi besok.
   Yang benar-benar tidak berguna adalah tautan yang baris sesinya sudah
   **dihapus** - tidak ada lagi isi untuk ditampilkan.

Karena itu pembersihannya berbahan bakar **kehilangan sesi**, bukan umur:

```sql
UPDATE share_links l SET revoked_at = now()
 WHERE l.revoked_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_key = l.session_key)
```

Sesi `idle` yang berumur 3 jam **tidak** tersentuh, dan itu diuji dengan
PostgreSQL sungguhan (`monitor-share-db.test.js`), bukan hanya diperiksa dari
bentuk SQL-nya. Baris tidak pernah dihapus, hanya dicabut.

Panel menampilkan jumlah tautan hidup dan, bila ada yatim, tombol **Cabut yang
yatim**. Aksi itu sempit dengan sengaja: ia tidak akan pernah mematikan tautan
yang masih punya isi.

### Mengapa ada panel tautan terpisah

Kartu sesi hilang setelah 30 menit `idle`, sedangkan tautan **tidak** ikut
hilang - ia hidup sampai dicabut. Tanpa panel, tautan yang sudah tersebar ke
WhatsApp bisa bertahan tanpa jalan mencabutnya, dan itu tidak terlihat oleh
siapa pun. Panel memakai `LEFT JOIN sessions`, jadi tautan yatim tetap muncul
dan ditandai `sesinya sudah tidak tampil`, bukan dibuang.

Ketiganya wajib header `X-Devwf-Share: 1`. Origin diperiksa **bila ada**:
`DEVWF_SHARE_ORIGINS` (bawaan `http://100.77.138.14:3100,http://localhost:3100`).

Nilai itu dibaca **sekali saat proses start**, bukan tiap permintaan. Mengubahnya
berarti `systemctl restart devwf-monitor`; tanpa restart, origin baru tetap
ditolak 403 dan penyebabnya tidak terlihat dari pesan galat mana pun.

**Mengapa Origin kosong diloloskan:** aplikasi tablet React Native tidak punya
konsep origin dan tidak mengirim header itu. Menolaknya membuat tombol Bagikan
di tablet selalu 403 sementara dashboard browser tampak normal - kegagalan yang
paling sulit dilacak. Yang benar-benar diwajibkan adalah header penanda, dan
header itu memaksa preflight sehingga formulir HTML biasa tidak bisa memalsukannya.

### Kode status

| Kode | Arti | Kalimat di halaman |
|---|---|---|
| `200` | tautan sah | halaman sesi |
| `404` | token tidak dikenal | "Tautan tidak dikenal." |
| `404` | sesi sudah dibersihkan retensi | "Sesi yang dibagikan sudah tidak tersimpan." |
| `410` | dicabut pemilik | "Tautan ini sudah dicabut pemiliknya." |
| `503` | tabel `share_links` belum ada | menyebutkan perintah DDL-nya |
| `405` | metode selain GET/HEAD | `Allow: GET, HEAD` |

`404` dan `410` sengaja dipisah supaya salah ketik tidak tertukar dengan tautan
yang sengaja dimatikan. Sesi yang dibersihkan retensi juga `404`, bukan `410`,
supaya pencabutan tidak dipalsukan oleh pembersihan data.

### Aturan yang dijaga tes, bukan hanya niat

- `PUBLIC_DENY` (`machine`, `project_path`, `project_name`, `session_key`,
  `agent_tool`, `owner_pid`) diperiksa terhadap **HTML hasil render**.
  Konsekuensinya: kelas CSS di `share-page.cjs` sengaja tidak memakai nama field
  itu.
- Teks dari manusia di-escape; `<script>`, `</title>`, `"` dan `&` diuji dengan
  payload nyata.
- `PRUNE_ENABLED` tidak menyentuh `share_links`. Tidak ada `DELETE` sama sekali;
  pencabutan menyetel `revoked_at`.
- Indeks unik parsial `(session_key) WHERE revoked_at IS NULL` membuat "satu
  tautan hidup per sesi" jadi janji database, bukan janji kode.
- `dashboard.cjs` di-parse dengan `node --check` oleh tes. Ini bukan kehati-hatian
  berlebih: halaman dashboard adalah satu template literal, dan satu backtick di
  dalam komentar pernah menutupnya lebih awal sehingga **dashboard mati total di
  produksi sementara seluruh suite hijau** (2 November 2026).

### Deploy

```bash
# 1. Berkas proses publik
scp monitor-server/share-links.cjs monitor-server/share-page.cjs \
    monitor-server/share-route.cjs monitor-server/share-server.cjs \
    root@100.77.138.14:/tmp/
ssh root@100.77.138.14
install -m 644 /tmp/share-*.cjs /opt/devwf-monitor/
install -m 644 /tmp/devwf-share.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now devwf-share
curl -s http://127.0.0.1:3200/health

# 2. Tunnel (sekali saja)
#    cloudflared tunnel create devwf-share  -> kredensial ke /etc/cloudflared/devwf-share.json (600)
#    CNAME devwfshare.programinglive.com -> <tunnel-id>.cfargotunnel.com, proxied ON
install -m 644 monitor-server/share-tunnel.yml /etc/cloudflared/share-tunnel.yml
install -m 644 monitor-server/cloudflared-devwf-share.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now cloudflared-devwf-share
curl -sI https://devwfshare.programinglive.com/health

# 3. Rewrite Netlify: deploy lewat CI (.github/workflows/deploy-web.yml)
```

**Mengapa hostname tunnel-nya `devwfshare.programinglive.com`, bukan
`share.devworkflow.programinglive.com`:** sertifikat Universal SSL zona ini
hanya `programinglive.com` + `*.programinglive.com` - satu label.
`share.devworkflow...` adalah dua label di bawah titik wildcard, dan handshake
TLS-nya gagal (`sslv3 alert handshake failure`) sampai sertifikat tambahan
dipesan. Satu label langsung tercakup. Pembaca tidak pernah melihatnya: tautan
yang dibagikan tetap domain utama.

### Diuji

- `tests/monitor-share-links.test.js` - bentuk token, penolakan bentuk aneh,
  URL, dan SQL.
- `tests/monitor-share-page.test.js` - `PUBLIC_DENY` terhadap HTML hasil render,
  escaping, OG tag, header keamanan.
- `tests/monitor-share-route.test.js` - guard Origin/header, idempotensi,
  503 untuk tabel yang hilang.
- `tests/monitor-share-server.test.js` - 404/410/405/HEAD, rate limit, `views`
  dihitung sesudah balasan.
- `tests/monitor-share-db.test.js` - **PostgreSQL sungguhan**: indeks parsial,
  `DO NOTHING`, pencabutan, dan sesi yang dibersihkan.
- `tests/monitor-share-race.test.js` - balapan tiga tab tidak pernah menjadi
  500; `OPTIONS` dari origin asing ditolak, dari origin sah dijawab 204.
- `tests/monitor-share-orphans.test.js` - tautan yang sesinya sudah hilang
  tetap masuk daftar (`LEFT JOIN`), karena itulah yang paling perlu dicabut.
- `tests/monitor-share-panel.test.js` - nama sesi untuk panel, dua tautan tanpa
  task tetap bisa dibedakan, dan panel tetap 200 saat tabel belum ada.
- `tests/monitor-share-ratelimit.test.js` - kunci batas laju per pembaca:
  `CF-Connecting-IP` hanya dipercaya dari loopback, dan nilainya harus IP sah.
- `scripts/list-live-shares.sh` - daftar tautan hidup beserta sesinya, untuk
  memeriksa keadaan kapan saja tanpa menebak.
- `scripts/cleanup-probe-shares.sh` - mencabut tautan sisa pengujian.
  **Hanya token yang dicatat eksplisit** di dalamnya; token lain tidak pernah
  cocok, jadi tautan pemilik tidak bisa ikut tercabut oleh pembersihan
  otomatis. Baris tidak dihapus, hanya `revoked_at` diisi.
- `scripts/probe-rate-limit.sh` - mengukur batas laju langsung ke
  `127.0.0.1:3200`; lewat Cloudflare header karangan ditimpa sehingga
  hasilnya menyesatkan.
- `tests/monitor-share-views.test.js` - `HEAD` tidak menambah `views`, dan
  jumlah yatim dihitung database (bukan dari daftar yang dibatasi 200).
- `scripts/probe-views.sh` - membuktikan `views` benar-benar bertambah lewat
  jalur publik, dan `HEAD` tidak ikut dihitung.
- `tests/monitor-share-ratemap.test.js` - peta pembatas laju punya batas keras:
  20.000 IP berbeda tetap menyisakan <= 5000 kunci, dan pembaca sah tidak
  ikut terblokir. Tanpa batas ini, memutar IP adalah kebocoran memori.
- `tests/monitor-share-server.test.js` juga menempuh **HTTP sungguhan** dengan
  baris sesi yang semua field-nya terisi. Tes kebocoran yang hanya memanggil
  renderer tidak akan menangkap `share-server` yang meneruskan baris utuh.- `tests/monitor-share-parse.test.js` - `node --check` untuk seluruh modul
  monitor.
- `tests/monitor-share-mobile.test.js` - header penanda, `Share.share`, dan
  hook sebelum `return null`.
- `tests/web-share-route.test.js` - rewrite `/s/*` berada di ATAS catch-all 404.

## Tablet: build yang terpasang harus lebih baru dari App.js

Aplikasi tablet tidak memuat ulang dirinya dari jaringan - tombol baru hanya
ada di APK yang dibangun sesudah `App.js` berubah. Diperiksa 3 November 2026:
APK terpasang dibangun 2 Nov 10:48, sedangkan `App.js` diubah 2 Nov 21:03,
jadi **tombol Bagikan belum ada di tablet** meskipun seluruh tes hijau.

Selalu bandingkan kedua waktu sebelum menyimpulkan tombolnya rusak:

```powershell
Get-Item mobile-app\App.js | Select LastWriteTime
Get-Item mobile-app\android\app\build\outputs\apk\release\app-release.apk | Select LastWriteTime
```

Membangun dan memasang:

```powershell
cd mobile-app\android
.\gradlew.bat assembleRelease
adb -s <ip-tablet>:5555 install -r app\build\outputs\apk\release\app-release.apk
```

Verifikasi tanpa menyentuh layar:

```powershell
adb -s <ip-tablet>:5555 shell am start -n com.programinglive.devwfmonitor/.MainActivity
adb -s <ip-tablet>:5555 shell uiautomator dump /sdcard/ui.xml
adb -s <ip-tablet>:5555 shell cat /sdcard/ui.xml
```

Sheet bagikan Android memuat tautan di baris pertama, jadi `uiautomator dump`
cukup untuk membuktikan tombolnya bekerja tanpa membuka WhatsApp.

**Xiaomi Pad 6 bisa terkunci pola** dan menampilkan "Draw pattern" di atas
aplikasi. Itu kunci perangkat, bukan kerusakan aplikasi - jangan coba
menembusnya; verifikasi di tablet lain atau minta pemilik membukanya.

## Rantai kartu per topik (Zettelkasten)

Sejak 8 November 2026 satu sesi agen bisa memuat lebih dari satu kartu. Setiap
`start_task` membuat kartu baru yang menyimpan identitas kartu sebelumnya;
kartu lama ditandai `handed-off` sehingga pindah dari tab Aktif ke Riwayat.
Kartu penerus menampilkan `↩ lanjutan dari "..."` dan kartu lama menampilkan
`↪ dilanjutkan ke "..."`. Kotak build hanya muncul pada kartu yang benar-benar
memilikinya.

Skema `sessions` berubah (kolom `task_id`, `parent_task_id`,
`parent_task_title`, primary key komposit) dan harus dimigrasikan dengan
`node scripts/migrate-monitor-db.cjs`. Rincian alur, rollback, dan daftar
tesnya ada di [card-chaining.md](card-chaining.md).

### Penutupan task harus menutup baris yang benar

Kunci `(session_key, task_id)` punya satu konsekuensi yang tidak terlihat:
laporan penutupan wajib membawa `task_id` yang **sama** dengan baris yang tadi
dikerjakan. `complete_task` memanggil `reset()` lebih dulu, dan `reset()`
mengosongkan `workflowTaskId` - jadi laporan penutupan tanpa penanganan khusus
akan menulis baris baru bertanda `task_id` kosong, sementara baris aslinya
tertinggal di fase `coding` selamanya lalu berubah menjadi `mungkin macet`
setelah 15 menit.

Perbaikan 9 November 2026: `reportToMonitorSafe` menyimpan `task_id` terakhir
yang dilaporkan di tingkat modul dan memakainya kembali ketika state sudah
di-reset. Tesnya di `tests/monitor-closure-identity.test.js`. Bila penguncian
tabel berubah lagi, kontrak ini harus ikut ditinjau - tes itu membaca
`ON CONFLICT (session_key, task_id)` untuk memastikan keduanya sejalan.

## Connected development work

Each active development session keeps its original source distinct from its linked execution and planning records. The session detail shows the canonical Zettly Todo, the Factory task, any verified Sentry issue, and the Zettly Draw plan as separate links. Factory recording is enabled by default for a configured, matching repository. A failed Factory write is shown in the `start_task` result so the session cannot appear fully connected by accident. Create the Mermaid flow before marking implementation complete; the flow is also saved as editable shapes in Zettly Draw.
