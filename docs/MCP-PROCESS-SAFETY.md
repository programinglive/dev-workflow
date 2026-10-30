# MCP mati karena agen membunuh proses `node.exe` (dikerjakan 30 Oktober 2026)

## Ringkasan

`playwright`, `dev-workflow`, dan `clinic-helper` sempat beberapa kali mati
bersamaan dengan pesan:

```text
message="mcp transport error" server=playwright error="MCP server process exited with code 1"
```

Gejalanya terlihat seperti bug `@playwright/mcp`. **Bukan.** Tidak ada hubungannya
dengan versi, flag, atau profil browser. Penyebabnya: agen menjalankan perintah
yang membunuh proses `node.exe`, dan setiap MCP server di sini adalah proses
Node.

## Bukti

Tiga klaster kegagalan di `~/.local/share/opencode/log/opencode.log`, masing-masing
didahului perintah pembunuh proses:

| Klaster | Perintah tepat sebelumnya | Exit | Yang mati |
| --- | --- | --- | --- |
| A 2026-10-29T03:01 | `Get-NetTCPConnection -LocalPort 2299` lalu `Stop-Process -Id ... -Force` pada pemilik port, plus semua `ssh` | 4 | semua MCP |
| B 2026-10-29T13:33 | `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` disaring `*dev-workflow-mcp-server*`, lalu `Stop-Process -Force` | 255 | hanya `dev-workflow` |
| C 2026-10-30T01:10 | `taskkill /F /IM node.exe /T` | 1 | semua MCP |

Klaster C adalah bukti paling langsung. Jarak antara perintah dan kematian
seluruh server: **386 milidetik**.

```text
01:10:37.098Z  spawning process  pwsh ... taskkill /F /IM node.exe /T 2>$null
01:10:37.484Z  mcp transport error  dev-workflow   exited with code 1
01:10:37.504Z  mcp transport error  clinic-helper  exited with code 1
01:10:37.519Z  mcp transport error  playwright     exited with code 1
01:10:37.531Z  mcp transport error  playwright     exited with code 1
01:10:37.545Z  mcp transport error  playwright     exited with code 1
```

Tiga proses `playwright` mati dalam **26 milidetik**. Tiga proses independen
tidak gagal bersamaan karena bug masing-masing; mereka dibunuh bersama.

Klaster B memperkuat hal yang sama dari arah berlawanan: perintah yang hanya
menyasar proses `dev-workflow` hanya membunuh `dev-workflow`. Jadi mekanismenya
konsisten - yang menentukan adalah proses mana yang dibunuh, bukan server mana.

## Akar masalah

MCP server dijalankan sebagai proses Node:

```json
{ "command": ["cmd", "/c", "npx", "-y", "@playwright/mcp@latest"] }
{ "command": ["node", "C:\\...\\dev-workflow-mcp-server\\index.js"] }
```

Perintah seperti `taskkill /F /IM node.exe` membunuh **semua** proses dengan nama
image `node.exe` di mesin itu. Ketiga MCP ikut mati, lalu OpenCode mencatatnya
sebagai transport error per server.

Perintah itu wajar dipakai untuk membersihkan dev server yang tertinggal. Bahaya
datang dari bentuk `/IM` (kill by image name): ia tidak bisa membedakan dev
server yang dimaksud dari MCP server yang tidak ada urusannya.

## Pencegahan

Aturan permission global menolak bentuk kill by image name. Ditambahkan ke
`~/.config/opencode/opencode.json`:

```jsonc
"permissions": [
  { "action": "shell", "resource": "taskkill */IM *", "effect": "deny" },
  { "action": "shell", "resource": "taskkill */im *", "effect": "deny" },
  { "action": "shell", "resource": "taskkill */F /IM *", "effect": "deny" },
  { "action": "shell", "resource": "taskkill */f /im *", "effect": "deny" }
]
```

Yang tetap diizinkan:

- `taskkill /PID <pid> /F` - menyasar satu proses, tidak menyentuh yang lain;
- `Stop-Process -Id <pid>` untuk proses yang sudah dipastikan identitasnya.

## Cara memverifikasi

Dua perintah, keduanya aman dijalankan:

```text
$ taskkill /F /IM definitely-not-a-real-process-xyz.exe
{"error":{"type":"permission.rejected","message":"Permission denied: shell"}}

$ taskkill /PID 999999 /F
ERROR: The process "999999" not found.
```

Yang pertama membuktikan bentuk `/IM` diblokir sebelum eksekusi. Yang kedua
membuktikan bentuk per-PID masih berjalan - perbaikannya tidak melumpuhkan
pembersihan proses yang sah.

`npm test` menjalankan `tests/process-kill-guard.test.js`, yang memastikan aturan
penjaga masih ada dan masih cocok dengan bentuk perintah berbahaya.

## Kalau MCP sudah terlanjur mati

OpenCode tidak menghidupkannya kembali sendiri; servernya berstatus `failed`
sampai dihubungkan ulang:

```bash
opencode api post '/api/experimental/mcp/playwright/connect?location[directory]=<direktori>'
opencode api get  '/api/mcp?location[directory]=<direktori>'
```

Atau lewat `/mcps` di TUI.

## Sisa risiko

**Aturan ini menyasar satu bentuk perintah.** `Stop-Process -Name node` atau
`wmic process where "name='node.exe'" delete` melakukan hal yang sama dan belum
diblokir. Dokumentasi OpenCode sendiri memperingatkan bahwa pola untuk mengenali
"setiap perintah berbahaya" tidak dapat diandalkan; yang benar-benar aman adalah
allowlist sempit.

**Kill per-PID tetap bisa membunuh MCP.** Klaster B melakukan itu dengan sengaja
dan hasilnya benar sesuai maksudnya - hanya `dev-workflow` yang mati. Setelah
tindakan seperti itu, server perlu dihubungkan ulang secara manual.

**`@playwright/mcp@latest` tetap tidak dipin.** Ini bukan penyebab crash, tetapi
membuat versi yang dipakai berubah tanpa catatan. Memakai versi tetap akan lebih
reproduktif bila suatu saat benar-benar ada bug di sana.
