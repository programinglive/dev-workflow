# Kredensial Factory basi dan proses MCP ganda (31 Oktober 2026)

Dua kegagalan berbeda yang terlihat seperti satu: otomasi Factory menolak login
padahal password di konfigurasi sudah benar, dan tool yang sama menjawab berbeda
antar pemanggilan.

## Gejalanya

```
Could not read the Factory queue: Factory login failed (HTTP 400).
Check FACTORY_EMAIL and FACTORY_PASSWORD, or set FACTORY_TOKEN.
```

Yang sudah dicoba dan tidak menolong: memeriksa ulang password (benar),
login manual di browser (berhasil). Yang akhirnya menolong: restart OpenCode.

## Sebab 1: proses MCP tidak pernah memuat ulang environment

Proses MCP mewarisi environment saat ia di-spawn. Kalau password di
`~/.config/opencode/opencode.json` diubah setelah itu, proses yang sedang hidup
tetap memakai password LAMA. Login manual di browser tidak menyentuh proses ini
sama sekali, jadi "bisa login di browser" dan "MCP tidak bisa login" sama-sama
benar.

Bukti pada 31 Oktober: record akun Factory terakhir diubah 31 Okt 00:07,
sementara proses MCP hidup sejak 30 Okt.

**Perbaikan.** Saat login ditolak, `factory-client.js` membaca ulang berkas
konfigurasi dan mencoba sekali lagi dengan kredensial terbaru
(`factory-credentials.js`). Perubahan password langsung terpakai tanpa restart.

Bila percobaan kedua juga ditolak, pesannya sekarang menyebut:

- kapan proses ini hidup, sehingga terlihat bahwa environment-nya sudah usang;
- apakah kredensial di berkas berbeda dari yang dipakai;
- bahwa restart OpenCode diperlukan bila password baru saja diubah.

Membaca ulang hanya terjadi di jalur GAGAL. Jalur normal tidak menyentuh berkas
sama sekali, jadi tidak ada biaya tambahan dan tidak ada perilaku baru saat
semuanya sehat.

### Dua bentuk konfigurasi yang harus didukung

```
{ "mcp": { "dev-workflow": { "environment": {...} } } }            # bentuk lama
{ "mcp": { "servers": { "dev-workflow": { "environment": {...} } } } }  # dipakai mesin ini
```

Bentuk kedua awalnya terlewat. Akibatnya penyegaran kredensial diam-diam tidak
pernah terjadi - kegagalan yang justru ingin dicegah modul ini. Karena itu ada
tes khusus untuk bentuk `mcp.servers.<nama>`.

Yang **tidak** diambil: blok server lain. Memakai kredensial proyek lain lebih
buruk daripada tidak memakai apa pun, jadi `extractFactoryEnv` mengembalikan
`null` bila blok server kita tidak ada.

### Tidak ada rahasia baru di disk

Alternatifnya adalah menyimpan token hasil login ke berkas. Itu ditolak: ia
menambah rahasia baru yang harus dijaga, dan tetap basi saat token kedaluwarsa.
Membaca berkas yang sudah berisi rahasia itu tidak menambah permukaan baru.

## Sebab 2: dua proses MCP hidup bersamaan

Pada 31 Oktober ada dua proses `dev-workflow` MCP (PID 23528 dan 3988). Yang
lebih tua memegang password lama, yang lebih muda memegang yang baru, sehingga
tool yang sama menjawab berbeda tergantung proses mana yang melayaninya.
Keduanya juga menulis berkas state workflow yang sama.

**Perbaikan.** `process-lock.js` menulis `.state/mcp-process.lock` berisi PID dan
waktu mulai. Proses kedua tidak dibunuh - membunuh proses secara otomatis
berbahaya dan sudah punya guard tersendiri - tetapi dilaporkan:

```
Proses dev-workflow MCP lain (PID 23528, hidup sejak ...) masih berjalan dan
memakai direktori state yang sama. ... Tutup OpenCode lalu buka lagi ...
```

Lock milik proses yang sudah mati diambil alih otomatis. Berkas lock yang rusak
dianggap tidak ada: penanda yang tidak terbaca tidak boleh membuat server gagal
start.

## Berkas

| Berkas | Isi |
|---|---|
| `factory-credentials.js` | baca ulang kredensial dari konfigurasi, pesan gagal login |
| `process-lock.js` | penanda proses, ambil-alih lock basi, peringatan |
| `factory-client.js` | `resolveToken` memakai keduanya |
| `index.js` | mencatat lock saat start dan melepasnya saat exit |

## Tes

| Berkas | Jumlah |
|---|---|
| `tests/factory-credentials.test.js` | 10 |
| `tests/factory-credentials-wiring.test.js` | 2 |
| `tests/process-lock.test.js` | 9 |

Bukti tes bergigi:

- `resolveToken` dikembalikan ke versi lama (tanpa penyegaran) -> tes
  "memakai password baru dari berkas saat password lama ditolak" GAGAL dengan
  HTTP 400, persis kejadian aslinya;
- dukungan `mcp.servers` dihapus -> tes bentuk konfigurasi nyata GAGAL.

Verifikasi terhadap PocketBase asli: `listTasks` dengan password yang sengaja
salah tetapi berkas konfigurasi benar mengembalikan data, bukan HTTP 400.

## Yang belum ditutup

1. **Token tidak dipersistensi.** Setiap kali cache token (10 menit) habis,
   login diulang. Bila PocketBase membatasi laju login, ini bisa menjadi
   masalah. Perbaikannya perlu keputusan karena menambah rahasia di disk.
2. **`perform_release` masih bisa menyusun `--release-as null`** bila tipe rilis
   tidak terdeteksi, dan kegagalan `git push --follow-tags` setelah commit rilis
   dibuat tidak di-rollback. Terjadi 31 Oktober (tag `vnull`). Belum diperbaiki.
