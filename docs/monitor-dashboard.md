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
IDLE_TTL=30 minutes
```

## Sesi `idle` yang basi disembunyikan

Proses MCP mati bersama sesi OpenCode-nya, jadi baris `idle` tinggal selamanya.
Tanpa filter, dashboard yang dipakai berhari-hari memenuhi layar tablet dengan
sesi yang sudah tidak ada prosesnya.

Filter hanya menyentuh `idle`:

```sql
WHERE NOT (phase = 'idle' AND updated_at < now() - $2::interval)
```

Sesi yang masih bekerja **tidak** punya batas umur: satu tugas panjang yang
jarang menyimpan state tetap pekerjaan nyata. Ubah batasnya lewat `IDLE_TTL`
(format interval Postgres, mis. `2 hours`).

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

## Diuji

- `tests/monitor-sessions-query.test.js` — filter hanya menyentuh `idle`, limit
  tetap parameter SQL.
- `tests/monitor-report.test.js` — bentuk snapshot dan klien pelapor.
- `tests/monitor-events.test.js` — peristiwa terkirim dan monitor mati tidak
  mengubah hasil tool.
- `tests/monitor-boot.test.js` — boot tidak menunggu monitor yang menggantung.
