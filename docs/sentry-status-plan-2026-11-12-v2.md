# Status & rencana — ERP / Sentry, 12 Nov 2026 (pasca v2.41.43)

Dokumen ini menggantikan rencana sebelumnya. Semua angka di sini berasal dari
pemeriksaan langsung, bukan dari handover.

## Status terverifikasi

### Produksi ERP

| Item | Nilai | Cara diperiksa |
|---|---|---|
| Versi terpasang | `2.41.43` | `package.json` di webroot |
| Commit webroot | `145289e0` | `git log -1` di `/var/www/erp.beautyworld.co.id` |
| Marker deploy | `v2.41.43`, 04:00:24 UTC | `/var/lib/deploy-tags/deployed/erp.beautyworld.co.id` |
| Trait bulk insert | `and extra not like ?` (bind) | baris 51, mtime 04:00:19 UTC |

Artinya perbaikan `auto_increment` **sudah terpasang**. Error di log yang
bercap `10:59:33` terjadi pada 10:59 waktu server (WIB), sedangkan file trait
ditulis 04:00:19 UTC = 11:00:19 WIB. Seluruh 9 kejadian berada di jam 10,
yaitu **sebelum** perbaikan terpasang. Tidak ada kejadian di jam 11 atau 12.

### Sentry: 8 terbuka

| Issue | Level | Kejadian | Terakhir | Sifat |
|---|---|---|---|---|
| ERP-85, ERP-83, ERP-84 | error | 4 / 4 / 1 | 12 Nov | konstanta `auto_increment` — semuanya pra-deploy |
| ERP-82 | error | 6 | 12 Nov | kolom `rowid` dianggap wajib — diperbaiki oleh rilis yang sama |
| ERP-37 | info | 166 | 12 Nov | N+1 `transferStock`, fix sudah live |
| ERP-81 | warning | 1 | 12 Nov | `TSBTB_Tgl` pada objek kosong |
| FRONTEND_ERP-4Y | info | 126 | 11 Nov | HTTP/1.1 overhead, situs sudah HTTP/2 |
| ERP-7T | warning | 1 | 11 Nov | query 301 ms, EXPLAIN rows=1 |

### Infrastruktur

| Item | Status |
|---|---|
| Kunci deploy runner | Dipasang di `/root/.ssh/erp-ci` (job berjalan sebagai root), `known_hosts` dari `ssh-keyscan` |
| Auth bridge | Terverifikasi sebagai root |
| `erp-deploy` di bw-app | Ada (4213 byte) — sempat saya hapus, sudah pulih |
| Sesi aktif | 7, dua di antaranya masih di area BTB |

## Rencana

### Fase 1 — Tutup regresi yang sudah berhenti (tanpa kode)

Sasaran: ERP-85, ERP-84, ERP-83, ERP-82.

- [ ] Tunggu jendela tenang sampai 13 Nov 04:00 UTC (24 jam sejak deploy)
- [ ] Pastikan tidak ada kejadian baru setelah 04:00 UTC
- [ ] Tutup keempatnya dengan komentar: commit `cf0fffd1`, tag `v2.41.43`,
      marker deploy 04:00:24 UTC, dan 0 kejadian setelahnya

**Gate:** kalau ada satu kejadian baru sesudah 04:00 UTC, jangan tutup —
berarti masih ada jalur yang memakai `columnSpec` versi lama.

### Fase 2 — Buktikan dan tutup N+1 yang sudah live

Sasaran: ERP-37 (`transferStock`).

- [ ] Pastikan `storeMsStockTrans` di host memakai satu `insert`
- [ ] Tunggu 24 jam tanpa kejadian
- [ ] Tutup dengan bukti commit + versi

### Fase 3 — Diagnosis, bukan tebakan

Sasaran: ERP-81 (`TSBTB_Tgl` pada objek kosong).

- [ ] Ambil stack trace dari Sentry, cari pemanggil sebenarnya
- [ ] Perbaiki hanya kalau penyebabnya jelas; kalau tidak, catat sebagai
      kebutuhan investigasi terpisah

### Fase 4 — Tutup yang tidak dapat ditindak, dengan alasan tertulis

- [ ] FRONTEND_ERP-4Y: situs sudah HTTP/2, overhead berasal dari klien lama →
      tutup dengan alasan teknis
- [ ] ERP-7T: EXPLAIN rows=1, satu kejadian, cache dingin → tutup dengan
      alasan teknis

### Fase 5 — Perbaikan data (WAJIB bergerbang backup)

- [ ] Backup penuh baru, `Dump completed`, gzip valid, ukuran + sha256 dicatat
- [ ] Salin ke `gs://bw-server-backups-377312/server_backups_v2/pre-repair/`
- [ ] Laporkan path, ukuran, checksum sebelum penulisan pertama
- [ ] Baru perbaiki baris lama

Tanpa langkah 1–3, fase ini tidak dijalankan.

### Fase 6 — Keputusan terpisah

- [ ] `approveInBatch` (jalur BTB sebagian) belum menetapkan flag aktif.
      Perlu keputusan produk, bukan perbaikan cepat.
- [ ] Rapatkan dua sesi `erp-btb-stock-del-fix` menjadi satu pemilik

## Aturan yang berlaku sepanjang pengerjaan

1. Cek `list_active_sessions` sebelum menyentuh file yang dipakai sesi lain
2. `git log -1 -- <file>` sebelum menulis perbaikan
3. `php -l` **tidak** membuktikan SQL benar — jalankan query sungguhan
4. Jangan tutup issue tanpa commit + versi terpasang + jendela tenang
5. Jangan menulis ke database produksi tanpa backup terverifikasi dan off-host

## Definisi selesai

Sentry berisi nol issue, atau setiap sisa issue punya salah satu: commit yang
memperbaikinya, atau alasan teknis tertulis yang bisa diperiksa ulang.
