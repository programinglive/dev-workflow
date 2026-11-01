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

Bawaan `http://100.107.65.21:3100`, bisa ditimpa saat build:

```bash
EXPO_PUBLIC_MONITOR_URL=http://100.107.65.21:3100 npx expo prebuild -p android
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

## Memasang ke tablet

**Blokir MIUI.** Kedua tablet menolak instalasi lewat adb dengan
`INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`, meskipun
`install_non_market_apps=1`. Penyebabnya tombol
**Developer options → Apps from unverified developers** yang masih mati.

Menyalakannya menuntut **PIN layar** perangkat, jadi harus dilakukan pemiliknya:

1. Settings → About tablet → ketuk "OS version" 7× (kalau Developer options
   belum ada)
2. Settings → Additional settings → Developer options
3. **Apps from unverified developers** → nyalakan → masukkan PIN layar
4. Pasang APK: buka file manager, ketuk `app-release.apk`, izinkan instalasi

Sesudah izin itu menyala, pemasangan lewat adb juga bekerja:

```bash
adb connect 100.81.240.34:5555
adb -s 100.81.240.34:5555 install -r android/app/build/outputs/apk/release/app-release.apk
```

## Memperbarui aplikasi

Ubah `App.js`, lalu ulangi `gradlew assembleRelease`. Naikkan `versionCode` di
`app.json` bila perlu (Android menolak versi yang sama dengan isi berbeda).
