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

## Alamat server

Bawaan `http://100.77.138.14:3100`, bisa ditimpa saat build:

```bash
EXPO_PUBLIC_MONITOR_URL=http://100.77.138.14:3100 npx expo prebuild -p android
```

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
