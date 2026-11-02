# Share satu sesi lewat domain publik — desain

Tanggal: 2 November 2026
Status: disetujui pemilik, menunggu review spec
Pemilik permintaan: pemilik repo (`programinglive`)

## Masalah

Dashboard sesi (`http://100.107.65.21:3100`) hanya bisa dibuka dari dalam
tailnet. Kalau pemilik ingin memberi tahu orang lain — di WhatsApp, di grup
tim — bahwa sebuah task sedang dikerjakan, satu-satunya cara adalah menyalin
teks secara manual atau mengirim tangkapan layar. Tangkapan layar memuat nama
mesin dan path proyek, jadi ia membocorkan lebih banyak daripada yang perlu.

Pemilik meminta: **setiap sesi punya tombol Share** yang menghasilkan tautan
`https://devworkflow.programinglive.com/...` yang bisa ditempel ke WhatsApp.

## Kendala nyata yang membentuk desain ini

Diperiksa 2 November 2026, bukan diasumsikan:

| Fakta | Bukti |
|---|---|
| `devworkflow.programinglive.com` adalah Netlify (A → `75.2.60.5`), proxied **off** | DNS Cloudflare API |
| Situs itu **static export** (`output: "export"`), tanpa runtime server | `web/next.config.ts` |
| Dashboard hidup di `100.107.65.21:3100`, bind hanya ke IP Tailscale | `ss -ltnp`, unit `devwf-monitor.service` |
| `api.devworkflow.programinglive.com` **tidak ada di DNS**; `nginx-api.conf` di repo menganggur | resolve gagal, nginx tidak punya `server_name` itu |
| `cloudflared` **tidak terpasang** di `bw-server-clean`; belum ada tunnel devworkflow | `which cloudflared` → kosong |
| Port 443 di `34.101.43.69` **tertutup** | `Test-NetConnection` |
| Akun Cloudflare yang dipakai sesi ini punya `argotunnel.read/write` | API |

Kesimpulan: situs statis tidak bisa membaca Postgres, jadi halaman share harus
dilayani proses lain. Proses itu harus terjangkau WhatsApp tanpa membuka port
di server, jadi jalurnya Cloudflare Tunnel.

## Keputusan pemilik

1. Isi halaman publik: **status kerja saja** — task, tipe, fase, rencana,
   progres DoD, waktu. Tanpa nama mesin, path proyek, nama proyek,
   `session_key`, dan `agent_tool`.
2. Tautan **permanen sampai dicabut**.
3. Tombol Share ada di **dashboard browser dan aplikasi tablet**.
4. Boleh menyentuh `bw-server-clean` untuk memasang tunnel.
5. Tautan yang dibagikan memakai **domain utama** `devworkflow.programinglive.com`.

## Arsitektur

```
Dashboard (browser / tablet)
   │  POST /api/share   (port 3100, Tailscale-only, X-Devwf-Share + cek Origin)
   ▼
devwf-monitor ──INSERT share_links──► Postgres devwf_monitor
   │  balas { token, url }
   ▼
pengguna menempel https://devworkflow.programinglive.com/s/<token>
   ▼
Netlify rewrite /s/*  ──►  https://share.devworkflow.programinglive.com/s/*
                                 │
                                 ▼
                     share-server :3200 (bind 127.0.0.1)
                                 │  SELECT sesi + share_links WHERE token=$1
                                 ▼
                     HTML publik + OG tag (tanpa field terlarang)
```

Mengapa dua hop (Netlify → tunnel) dan bukan langsung tunnel di domain utama:
domain utama sudah dimiliki Netlify dan tidak boleh dipindahkan tanpa memutus
situs marketing. Netlify rewrite berstatus 200 mem-proxy isi dari tunnel,
sehingga tautan yang dibagikan tetap domain utama. Subdomain `share.` tetap
hidup sebagai jalan kedua bila proxy Netlify bermasalah.

## Komponen

### Baru — `monitor-server/`

| Berkas | Tanggung jawab | Bisa diuji tanpa jaringan |
|---|---|---|
| `share-links.cjs` | Generate/validasi token, susun SQL insert/lookup/revoke, hitung URL publik | ya, murni |
| `share-page.cjs` | Render HTML publik + OG tag, escape semua field, `PUBLIC_DENY` | ya, murni |
| `share-server.cjs` | HTTP `:3200`, `GET /s/:token`, `HEAD`, `GET /health` | ya, dengan server palsu |
| `share-tunnel.yml` | Config Cloudflare Tunnel `devwf-share` → `127.0.0.1:3200` | — |
| `devwf-share.service` | Unit systemd | — |

`share-server.cjs` dipasang di **direktori yang sama** dengan monitor
(`/opt/devwf-monitor`) supaya memakai `node_modules/pg` yang sudah ada. Satu
ketergantungan lebih sedikit untuk salah.

### Diubah — `monitor-server/dashboard.cjs`

Tiga endpoint, semuanya hanya di port 3100 yang tidak terjangkau internet:

| Method | Path | Perilaku |
|---|---|---|
| `POST` | `/api/share` | body `{ sessionKey }` → `{ token, url, createdAt }`. Idempoten: bila sudah ada tautan hidup untuk sesi itu, kembalikan yang lama. |
| `DELETE` | `/api/share?token=…` | set `revoked_at`; balas `{ ok, revoked }` |
| `GET` | `/api/share?sessionKey=…` | tautan hidup milik sesi itu, atau `{ url: null }` |

Semua tiga wajib `X-Devwf-Share: 1` **dan** `Origin` yang dikenal. Bukan
autentikasi penuh — ini pertahanan terhadap halaman web lain yang mencoba
memanggil dashboard dari browser korban. Penulisan tetap hanya bisa dari
dalam tailnet.

### Diubah — `web/`

`web/netlify.toml` — tambahkan **sebelum** catch-all 404:

```toml
[[redirects]]
  from = "/s/*"
  to = "https://share.devworkflow.programinglive.com/s/:splat"
  status = 200
  force = true
```

`force = true` perlu supaya rewrite menang atas berkas statis. Urutan penting:
Netlify memakai aturan pertama yang cocok, jadi catch-all `/*` → 404 yang sudah
ada **harus tetap di bawah**, kalau tidak setiap tautan share menjawab 404 dan
gejalanya tampak seperti "server share mati".

`app/share/page.tsx` — halaman statis biasa yang menjelaskan apa itu tautan
share, dan memberi tombol kembali ke beranda. Ini hanya terpakai bila proxy
Netlify mati; bukan jalur utama.

Halaman ini **sengaja di `/share/`, bukan di `/s/`.** Static export dengan
`trailingSlash: true` menulis `/s/index.html` dari `app/s/page.tsx`, dan rewrite
`/s/*` juga cocok untuk `/s/` — dua aturan yang berebut satu path, dan yang
kalah bergantung pada urutan yang tidak terlihat. Memisahkan path menghapus
kemungkinan itu seluruhnya.

Isi halaman `/share/` harus tetap benar tanpa perlu diperbarui setiap kali
kode berubah: ia **tidak** menyebut token atau sesi, tidak mengambil data dari
mana pun, dan hanya menjelaskan bahwa tautan share dilayani server serta
menyediakan jalan kembali ke beranda. Halaman yang mengklaim sesuatu tentang
kondisi server akan berbohong begitu server mati — persis kegagalan yang sudah
pernah terjadi pada halaman `/login` lama.

### Diubah — `mobile-app/App.js`

Tombol **Bagikan** di modal detail memakai `Share.share` bawaan React Native
(sheet Android memunculkan WhatsApp). Tautan juga ditampilkan sebagai teks
`selectable` supaya bisa disalin manual. **Tidak ada dependensi native baru** —
menambah `expo-clipboard` berarti membangun ulang APK, dan itu biaya yang tidak
sepadan untuk satu tombol.

## Skema data

```sql
CREATE TABLE IF NOT EXISTS share_links (
  token        text primary key,
  session_key  text not null,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_view_at timestamptz,
  views        integer not null default 0
);

CREATE UNIQUE INDEX IF NOT EXISTS share_links_one_live_per_session
  ON share_links (session_key)
  WHERE revoked_at IS NULL;
```

Indeks unik parsial itulah yang membuat `/api/share` idempoten: satu tautan
hidup per sesi, sehingga menekan Share dua kali tidak menumpuk token dan tidak
membuat tautan lama diam-diam berhenti bekerja.

Tabel dibuat oleh `ensureShareTable()`, dipanggil `share-server` saat boot dan
oleh endpoint share saat pertama dipakai. `CREATE TABLE IF NOT EXISTS` bersifat
idempoten, jadi dua proses boleh memanggilnya. Kegagalan pembuatan tabel
dibalas **503 dengan pesan yang menyebut sebabnya**, bukan 500 kosong dan bukan
crash.

Token: 32 byte acak dari `crypto.randomBytes`, `base64url` (43 karakter).
Pembandingan token tidak rahasia terhadap waktu dalam arti kriptografis, tetapi
token tidak pernah dibandingkan dengan string rahasia lain — ia kunci database.

### Apa yang terjadi bila data sesinya sudah dibuang

Sesi `idle` lama boleh dibersihkan retensi. Tautan share-nya tidak ikut, karena
`PRUNE_ENABLED` tidak menyentuh tabel ini. Hasilnya: token sah, sesi tidak ada.

Jawabannya **404 dengan kalimat yang benar** ("sesi yang dibagikan sudah tidak
tersimpan"), bukan 410 (tautan tidak dicabut) dan bukan halaman kosong. Ini juga
sengaja agar pencabutan tidak dipalsukan oleh pembersihan data.

### Apa yang terjadi bila tabel belum ada

`ensureShareTable()` dipanggil saat `dashboard.cjs` boot (tidak ditunggu, gagal
tidak menghentikan dashboard) dan oleh `share-server` saat boot. Bila pembuatan
gagal — mis. user database tidak punya `CREATE` — dan sebuah permintaan tiba
sebelum tabelnya ada, jawabannya **503 dengan pesan yang menyebut sebabnya**,
bukan 500 kosong dan bukan crash. Perintah SQL untuk membuat tabel dicetak ke
stderr supaya operator bisa menjalankannya sendiri.

## Aturan yang dijaga tes

1. HTML publik **tidak memuat** `machine`, `project_path`, `project_name`,
   `session_key`, `agent_tool`, `owner_pid`. Tes memeriksa **HTML hasil
   render**, bukan kode sumber.
2. Token tak dikenal → **404**. Token dicabut → **410** dengan kalimat bahwa
   tautan sudah dicabut pemiliknya. 410 dipilih supaya orang membedakan
   "salah ketik" dari "sengaja dimatikan".
3. `share-server` hanya `GET`/`HEAD`. `POST`/`PUT`/`DELETE` → **405**, dan tidak
   ada jalur tulis apa pun di sana.
4. `POST /api/share` tanpa `X-Devwf-Share` → **403**; dengan `Origin` asing →
   **403**; preflight `OPTIONS` dari origin asing → **403**.
5. Share untuk `sessionKey` yang tidak ada → **404**, bukan baris yatim.
6. Escaping: task berisi `<script>alert(1)</script>` tampil sebagai teks, dan
   `</title>` tidak bisa memutus tag.
7. Membaca tautan menambah `views` dan `last_view_at`; **tidak pernah** mengubah
   atau menghapus data sesi.
8. Tidak ada `DELETE` pada `share_links` kecuali pencabutan eksplisit. Retensi
   otomatis tetap MATI (`PRUNE_ENABLED` tidak menyentuh tabel ini).
9. Header halaman publik: `Cache-Control: no-store`, `X-Robots-Tag: noindex`,
   `Referrer-Policy: no-referrer`, CSP `default-src 'none'` dengan
   `style-src 'unsafe-inline'` saja (halaman tidak punya JavaScript).

## Perilaku UI yang harus benar di http, bukan hanya di https

Dashboard dibuka lewat `http://100.107.65.21:3100` — bukan secure context. Dua
API browser yang biasa dipakai justru mati di sana:

- `navigator.share` tidak ada → tombol Share akan tampak berfungsi lalu gagal.
- `navigator.clipboard.writeText` juga ditolak karena bukan secure context.

Karena itu urutan fallback-nya eksplisit:

1. `navigator.share` bila tersedia.
2. `navigator.clipboard.writeText` bila tersedia.
3. `document.execCommand('copy')` lewat `<textarea>` sementara.
4. Bila ketiganya gagal: tautan ditampilkan di kotak teks yang sudah tersorot,
   dengan instruksi "salin manual". Tidak pernah gagal diam-diam.

Aplikasi tablet tidak terkena masalah ini karena `Share.share` adalah API
native, bukan API browser.

## Risiko dan cara menutupnya

| Risiko | Penanganan |
|---|---|
| Tautan hidup = siapa pun yang punya link bisa membaca progres | Sudah keputusan pemilik; isinya dibatasi ke status kerja, dan ada tombol Cabut. `views` membuat pemilik tahu tautan pernah dibuka. |
| Proxy Netlify mati / berubah perilaku | Subdomain `share.` tetap hidup sebagai jalan kedua dan ditampilkan di halaman share sebagai "tautan alternatif". Dicek di verifikasi deploy. |
| Cloudflare cache menyajikan versi basi setelah dicabut | `Cache-Control: no-store`; pencabutan diuji lewat `curl` dari luar. |
| Token tertinggal di riwayat browser orang lain | Sama seperti tautan publik mana pun; bisa dicabut kapan saja. |
| Dua sesi berbagi satu token | Dicegah indeks unik parsial. |
| Tabel baru menghapus data lama | Hanya `CREATE TABLE IF NOT EXISTS`; tidak ada `ALTER`/`DROP` pada tabel lama. |
| `share-server` mati dan dashboard ikut terganggu | Proses terpisah; dashboard tidak bergantung padanya. |

## Langkah deploy

1. `scp` berkas `share-*.cjs`, `devwf-share.service` ke `/opt/devwf-monitor/`.
2. `systemctl enable --now devwf-share` (bind `127.0.0.1:3200`).
3. Buat tunnel `devwf-share` via API Cloudflare; kredensial ke
   `/etc/cloudflared/devwf-share.json` mode 600.
4. CNAME `share.devworkflow.programinglive.com` → `<tunnel-id>.cfargotunnel.com`,
   **proxied ON**.
5. Pasang dan aktifkan `cloudflared-devwf-share.service`.
6. Tambahkan rewrite `/s/*` di `web/netlify.toml`, deploy lewat CI.
7. Verifikasi dari luar tailnet: `curl -I` tautan, periksa HTML bersih dari
   field terlarang, cabut lalu pastikan **410**.

## Rencana pengujian

Unit murni, tanpa jaringan dan tanpa Postgres:

- `tests/monitor-share-links.test.js` — bentuk token, panjang, karakter,
  idempotensi SQL, URL yang disusun, penolakan `sessionKey` kosong.
- `tests/monitor-share-page.test.js` — field terlarang tidak muncul untuk sesi
  yang SEMUA field-nya terisi; escaping `<script>` dan `</title>`; OG tag ada;
  header keamanan disusun benar.
- `tests/monitor-share-server.test.js` — routing 404/410/405, `HEAD`, rate limit,
  dan bahwa tidak ada metode tulis yang diterima.

Integrasi (dilewati bila `TEST_POSTGRES_URL` kosong, mengikuti pola tes yang
sudah ada):

- `tests/monitor-share-db.test.js` — insert, idempotensi lewat indeks unik,
  revoke, dan `views` bertambah.

Invarian lintas berkas:

- `tests/web-share-route.test.js` — `web/netlify.toml` memuat rewrite `/s/*` ke
  host share, dan tes lama "rute mati menjawab 404" tetap lulus (urutan redirect
  tidak boleh menelan catch-all).

## Kriteria selesai

1. `npm test` lulus seluruhnya.
2. Tautan sungguhan bisa dibuka dari luar tailnet dan menampilkan task, fase,
   rencana, dan progres DoD.
3. HTML publik tidak memuat satu pun field terlarang (dibuktikan oleh tes).
4. Mencabut tautan membuatnya menjawab 410 dalam satu permintaan.
5. Tombol Share berfungsi di dashboard browser, termasuk saat
   `navigator.share` tidak tersedia.
6. Tombol Bagikan membuka sheet Android di aplikasi tablet.
7. README punya bagian "Sharing a session" **dan** peta berkas repo.
8. `docs/monitor-dashboard.md` memuat endpoint, aturan keamanan, dan langkah deploy.
9. `infra-knowledge` mencatat domain, service, dan tunnel baru, dengan
   `updated:` dinaikkan.

## Di luar lingkup

Halaman daftar semua sesi publik, penyuntingan dari halaman publik, login untuk
pembaca tautan, gambar/screenshot dinamis, dan tautan berbatas waktu. Semuanya
bisa ditambahkan nanti tanpa membongkar desain ini.
