# Aplikasi Android (Expo)

Aplikasi native untuk memantau sesi dev-workflow dari tablet, tanpa browser.

## Mengapa aplikasi, bukan website

Membuka dashboard lewat intent Android membuat **aktivitas Chrome baru setiap
kali**. Diukur 2 November 2026: 23 aktivitas menumpuk di Xiaomi Pad 6 dan 13 di
POCO Pad M1, semuanya dari percobaan otomatis. Aplikasi cukup dibuka sekali;
sesudah itu ia menyegarkan dirinya sendiri setiap 3 detik dan saat kembali dari
latar.

## Isi

| Berkas | Isi |
|---|---|
| `App.js` | Layar utama: kartu besar per sesi, progress bar, chip status, daftar aktivitas |
| `app.json` | Konfigurasi Expo: orientasi landscape, package `com.programinglive.devwfmonitor`, `usesCleartextTraffic` untuk HTTP di tailnet |
| `android/` | Hasil `expo prebuild` (dibuat ulang, jangan diedit tangan) |

Status diambil dari **server** (`state`), bukan disimpulkan sendiri dari
`phase`. Aplikasi ini tidak punya pendapat sendiri soal aktif/macet/berakhir.

## Build di kartu

Kartu sesi menampilkan build yang dilaporkan `report_build_status`, sama seperti
kartu dashboard web. Isinya: status (`MEMBANGUN`/`MENGUJI`/`BERHASIL`/`GAGAL`),
target build, baris lokasi build (`buildLocation`), stage terakhir, bar progres,
dan umur laporan yang dihitung dari jam server.

Baris lokasi punya tiga wajah, dan yang membedakannya tetap kejujuran:

| Data yang ada | Teks |
|---|---|
| host dilaporkan pelaksana | `Build di <host>` |
| hanya mesin pelapor | `Dilaporkan dari <machine>` |
| keduanya tidak ada | `Host build tidak dilaporkan` |

Di kartu sesi, `buildLocation` dipanggil **tanpa pelapor** karena baris meta
kartu di atasnya sudah menyebut mesin — tanpa itu, "HELLOWORLD" muncul dua kali
berturut-turut. Tab Build dan modal detail tetap menyebut pelapor, karena
keduanya dibaca tanpa konteks itu.

Blok ini hanya muncul bila `/api/sessions` mengirim `active_build.target`, dan
letaknya **di atas diagram flow** supaya build yang sedang berjalan terlihat
tanpa menggulir. Server hanya menempelkan `active_build` pada kartu terbaru
sebuah sesi, jadi kartu lama di tab Riwayat memang tidak menampilkan build.

Dijaga `tests/monitor-app-card-build.test.js`: kartu wajib memakai
`buildStatusLabel`, `buildLocation`, stage, progres, dan `ago(..., jamServer)`.

## Alamat server dinamis (Runtime Configuration)

Bawaan default mengarah ke `http://100.77.138.14:3100`. Namun mulai Milestone M1, alamat server **tidak lagi terkunci saat build**. Anda dapat mengubah, menambah, menguji koneksi (ping latency), dan berpindah profil server langsung dari aplikasi Android tanpa perlu build ulang APK:

1. **Tombol Header:** Ketuk pil `⚙ Server` di samping jumlah sesi aktif di bagian atas layar.
2. **Tab Info:** Buka tab `Info` (ikon `ⓘ`) dan ketuk tombol biru `⚙ Ganti Server Monitor`.
3. **Banner Error:** Bila koneksi terputus, muncul banner merah yang langsung menyediakan tombol `⚙ Ganti Alamat Server`.

Di modal pengaturan server:
- Masukkan URL atau IP server (misal: `192.168.1.100:3100` atau `https://monitor.example.com`).
- Ketuk **Uji Koneksi** untuk memverifikasi probe `/health` dan melihat latensi riil (misal `✓ Tersambung (12ms)`).
- Ketuk **Simpan & Hubungkan** untuk menyimpan profil ke penyimpanan lokal perangkat dan langsung beralih ke server tersebut.

Bila ingin menimpa nilai bawaan awal saat build:

```bash
EXPO_PUBLIC_MONITOR_URL=http://100.77.138.14:3100 npx expo prebuild -p android
```

## Pemasangan Perangkat Kriptografis (Cryptographic QR Pairing - M2)

Mulai Milestone M2, Android Companion mendukung pairing kriptografis otomatis antara tablet Xiaomi Pad 6 dan monitor server tanpa perlu input token manual:

### 1. Perintah CLI di Sisi Server
Jalankan perintah berikut di mesin host / server:
```bash
devwf pair
# atau tentukan URL eksplisit:
devwf pair --url http://100.77.138.14:3100
# atau format JSON untuk integrasi script:
devwf pair --json
```

Perintah ini menghasilkan:
- Ephemeral Challenge ID (`ch_...`) dengan TTL 3 menit (180 detik).
- Nonce kriptografis 32-karakter acak (`crypto.randomBytes(16)`).
- Kode verifikasi 6 digit visual (`XXX-XXX`).
- Fingerprint SHA-256 server host.
- QR Payload URI kanonikal: `devwf://pair?v=1&url=...&ch=...&nonce=...&fp=...&code=...`.

### 2. Monitor Server REST Endpoints
- `POST /api/v1/mobile/pair/verify`: Menerima payload challenge, memvalidasi single-use constraint & TTL, mencocokkan nonce/code, mendaftarkan device ke registry, dan menerbitkan `deviceId` serta `deviceToken` bertingkat Bearer.
- `GET /api/v1/mobile/pair/status?ch=<id>`: Memeriksa status tantangan pairing (`pending`, `consumed`, `expired`).

### 3. Alur Pairing pada Tablet (Xiaomi Pad 6)
1. Buka modal pengaturan server (ketuk pil `⚙ Server` di header).
2. Pilih tab `🔒 QR Pairing (devwf pair)`.
3. Tempelkan URI `devwf://pair?...` yang dihasilkan server.
4. Ketuk **🔒 Pasangkan Perangkat**.
5. Klien memvalidasi handshake ke `/api/v1/mobile/pair/verify`, menerima token autentikasi, menyimpan profil dengan badge `🔒 PAIRED`, dan langsung mengaktifkan pemantauan real-time.

## Real-Time SSE Event Streaming Engine (Milestone M3)

Mulai Milestone M3, polling periodik HTTP setiap 3 detik telah digantikan oleh arsitektur hibrida **Server-Sent Events (SSE) + Snapshot Synchronization** yang hemat daya, latensi rendah (<100ms), dan tangguh terhadap gangguan jaringan:

### 1. Endpoints Monitor Server
- `GET /api/v1/mobile/snapshot`: Mengembalikan snapshot state penuh saat inisialisasi atau pemulihan koneksi, dilengkapi cursor sequence terkini (`cursorId`).
- `GET /api/v1/mobile/events`: Stream SSE persisten (`text/event-stream`) yang menyiarkan update task, perubahan build progress, dan event aktivitas secara real-time.
  - Mendukung header `Last-Event-ID: <id>` untuk pemutaran ulang (replay) otomatis terhadap event yang terlewat saat terjadi gangguan jaringan singkat.
  - Mengirimkan heartbeat komentar (`: heartbeat <timestamp>`) setiap 15 detik agar koneksi tetap aktif melewati NAT/proxy timeout.

### 2. Client-Side ConnectionManager (`mobile-app/connection-manager.js`)
- Mengatur siklus hidup koneksi secara otonom:
  - **Foreground:** Membuka socket streaming SSE persisten dengan cursor replay.
  - **Background:** Memutuskan koneksi secara bersih saat aplikasi diminimalkan guna menghemat baterai tablet.
  - **Auto-Reconnect:** Melakukan rekoneksi otomatis dengan backoff eksponensial (1s, 2s, 4s, s.d. 10s).
  - **Graceful Polling Fallback:** Bila koneksi SSE gagal berturut-turut sebanyak 3 kali (misal akibat proxy kantor atau VPN yang memotong chunked streaming), ConnectionManager otomatis beralih ke mode polling adaptif `/api/sessions` setiap 3 detik tanpa mengganggu tampilan pengguna.

### 3. Indikator Status Konektivitas di Header
Di samping judul dashboard terdapat pil status live dengan kode warna:
- 🟢 `LIVE`: Terhubung langsung ke stream real-time SSE.
- 🟡 `RECONNECTING`: Sedang mencoba rekoneksi otomatis akibat fluktuasi jaringan.
- 🔵 `POLLING`: Mode cadangan aktif setelah 3 kali percobaan streaming gagal.
- ⚪ `OFFLINE`: Aplikasi dalam status terputus atau mode latar belakang.



## Membangun APK

Butuh JDK 17 dan Android SDK (build-tools + platform). Di mesin ini keduanya
sudah ada.

```bash
cd mobile-app
npm install
npx expo prebuild --platform android --no-install
# SDK path: sesuaikan dengan mesin Anda
echo 'sdk.dir=C\:\\Users\\<user>\\AppData\\Local\\Android\\Sdk' > android/local.properties
cd android && ./gradlew.bat assembleRelease
```

Hasil: `android/app/build/outputs/apk/release/app-release.apk` (~64 MB).

Build pertama butuh ~14 menit; berikutnya lebih cepat karena cache Gradle.

### Catatan `npm install`

Di mesin ini `npm install` dipanggil langsung, bukan lewat `npx expo install`:
konfigurasi npm global memakai `allow-scripts`, dan `npx expo install` memanggil
`npm install --allow-scripts` yang **ditolak** pada instalasi berlingkup
proyek (`EALLOWSCRIPTS`). Efeknya sama.

## Jam: label umur memakai waktu SERVER

Aplikasi **tidak** menghitung "4m lalu" dari jamnya sendiri. `/api/sessions`
mengirim field `now`, dan klien memakainya sebagai acuan.

Alasannya nyata: emulator MuMu pernah menampilkan `14d lalu` untuk sesi yang
baru 4 menit, karena jam perangkat bergeser. Kesalahan seperti itu tidak
memunculkan error apa pun — hanya angka yang salah, tanpa cara mengetahui
sebabnya.

Dijaga `tests/monitor-clock-source.test.js`: server wajib mengirim `now`, web
tidak boleh memakai `Date.now()` telanjang, dan setiap pemanggilan `ago()` di
`App.js` wajib menyertakan `jamServer`.

## Memasang ke tablet

**Blokir MIUI.** Kedua tablet menolak instalasi lewat adb dengan
`INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`, meskipun
`install_non_market_apps=1`. Penyebabnya tombol
**Developer options → Apps from unverified developers** yang masih mati.

Menyalakannya menuntut **PIN layar** perangkat, jadi harus dilakukan pemiliknya:

1. Settings → Additional settings → Developer options
   (kalau belum ada: Settings → About tablet → ketuk "OS version" 7×)
2. **Apps from unverified developers** → nyalakan → masukkan PIN layar
3. Pasang APK: buka file manager, ketuk `app-release.apk`, izinkan instalasi

Sesudah izin itu menyala, pemasangan lewat adb juga bekerja:

```bash
adb connect 100.81.240.34:5555
adb -s 100.81.240.34:5555 install -r android/app/build/outputs/apk/release/app-release.apk
```

## Sudah diuji di emulator

Aplikasi ini **tidak** hanya berhasil dibangun — sudah dijalankan dan dibaca
isinya di emulator Android 35 (`google_apis;x86_64`):

- APK terpasang: `Success`, `MainActivity` terbuka
- Saat server sepi: layar menampilkan `Tidak ada laporan masuk` — cocok dengan
  kondisi server, jadi bukan data palsu
- Dengan sesi aktif: chip **AKTIF**, task, `EMULATOR-TEST · dev-workflow-mcp-server · feature`,
  `rencana 1/3 · DoD 0/1`, langkah bertanda centang, dan `step_done` di aktivitas
- logcat: `FATAL EXCEPTION` 0, `E AndroidRuntime` 0, `ReactNativeJS Error` 0

Yang **belum** teruji adalah pemasangan di kedua tablet MIUI, karena alasan di
atas. Tampilan dan jaringan sudah terbukti bekerja.

### Terverifikasi di Xiaomi Pad 6 (12 November 2026)

Pemasangan lewat adb sekarang **berhasil** di Xiaomi Pad 6, jadi bagian "belum
teruji" di atas sudah tidak berlaku untuk tablet ini:

```bash
adb devices -l
# 192.168.21.247:34497  device product:pipa_id model:23043RP34G
adb -s 192.168.21.247:34497 install -r android/app/build/outputs/apk/release/app-release.apk
# Performing Streamed Install -> Success
```

Yang diukur, bukan diasumsikan:

| Pemeriksaan | Hasil |
|---|---|
| APK terpasang identik dengan hasil build repo | `sha256` `3867AAE9...8D5800` sama untuk `base.apk` yang di-`adb pull` dan `app-release.apk` lokal |
| Aplikasi berjalan | `pidof com.programinglive.devwfmonitor` mengembalikan PID |
| Tablet menjangkau monitor | `ping 100.77.138.14` 10.2 ms, port 3100 terbuka |
| Identitas terpasang | `versionName=1.0.0`, `versionCode=1`, `lastUpdateTime` bergerak setelah `install -r` |

Cara memeriksa ulang bahwa tablet benar-benar memakai build terbaru, tanpa
menebak dari tanggal berkas:

```bash
adb -s <serial> shell pm path com.programinglive.devwfmonitor
adb -s <serial> pull <path base.apk> /tmp/installed.apk
sha256sum /tmp/installed.apk android/app/build/outputs/apk/release/app-release.apk
```

Dua nilai `sha256` yang sama berarti build di tablet adalah build di repo. Bila
berbeda, ulangi `gradlew assembleRelease` lalu `adb install -r`.

### Catatan emulator

AVD lama `Pixel_7_Pro_API_35` menunjuk `google_apis_playstore` yang tidak
terpasang, sehingga emulator gagal start dengan
`Cannot find AVD system path`. Image `system-images;android-35;google_apis;x86_64`
diunduh lewat `sdkmanager`, lalu AVD baru dibuat dengan `avdmanager`. Untuk
memakainya:

```bash
export ANDROID_SDK_ROOT="$LOCALAPPDATA/Android/Sdk"
emulator -avd <nama> -no-snapshot-load -no-boot-anim -no-window -gpu swiftshader_indirect
```


## Memperbarui aplikasi

Ubah `App.js`, lalu ulangi `gradlew assembleRelease`. Naikkan `versionCode` di
`app.json` bila perlu (Android menolak versi yang sama dengan isi berbeda).
