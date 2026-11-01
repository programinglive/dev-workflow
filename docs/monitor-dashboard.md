# Live dashboard (devwf-monitor)

Dashboard yang menampilkan sesi `dev-workflow` dari semua mesin secara
langsung, tanpa login, di jaringan Tailscale.

URL: `http://100.107.65.21:3100`

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

## Diuji

- `tests/monitor-sessions-query.test.js` — filter hanya menyentuh `idle`, limit
  tetap parameter SQL.
- `tests/monitor-report.test.js` — bentuk snapshot dan klien pelapor.
- `tests/monitor-events.test.js` — peristiwa terkirim dan monitor mati tidak
  mengubah hasil tool.
- `tests/monitor-boot.test.js` — boot tidak menunggu monitor yang menggantung.
