# Allowlist shell: analisis berbasis bukti (30 Oktober 2026)

## Kesimpulan lebih dulu

**Allowlist sempit bukan pilihan yang tepat untuk mesin ini.** Datanya menolak ide
itu, dan saya menulis dokumen ini untuk membatalkan rekomendasi saya sendiri
sebelum ia dikerjakan.

Yang direkomendasikan: **persempit denylist yang sudah ada** sampai hanya
menyasar pembunuh proses Node, lalu biarkan sisanya berjalan seperti sekarang.

## Bukti

Sumber: `~/.local/share/opencode/log/opencode.log`, periode 20-30 Oktober 2026.

- **21.458** perintah dijalankan lewat `pwsh -Command`
- **2.976** pencarian `rg` dan **8.999** pemanggilan `git` oleh OpenCode sendiri
  (snapshot, worktree, status) - ini bukan perintah agen, jadi tidak pernah
  melewati pemeriksaan permission
- Rata-rata ~2.150 perintah agen per hari

### Bentuk perintah menentukan apakah allowlist mungkin

| Sifat | Jumlah | Persentase |
| --- | ---: | ---: |
| memakai pipe | 16.709 | **77,9%** |
| memakai variabel `$` | 10.745 | **50,1%** |
| multi-baris / skrip | 7.047 | **32,8%** |
| satu perintah sederhana | 14.411 | 67,2% |

Tiga angka pertama itulah masalahnya. Allowlist bekerja dengan mencocokkan
**awalan teks** perintah:

```
"npm test *"  -> cocok untuk "npm test", "npm test -- --watch"
```

Pola itu tidak bisa mencocokkan:

```powershell
# 77,9% perintah berbentuk begini
Get-ChildItem C:\x -Recurse | Where-Object { $_.Length -gt 1MB } | Remove-Item

# 50,1% menyembunyikan isinya di variabel
$target = "D:\code\foo"; Remove-Item -Recurse $target

# 32,8% berupa skrip beberapa baris
if (Test-Path $p) { ... }
foreach ($x in $list) { ... }
```

Untuk menutup bentuk-bentuk itu, allowlist harus memuat pola selebar `pwsh *`
- yang sama saja dengan mengizinkan semuanya.

### Perintah destruktif adalah bagian normal pekerjaan ini

Yang **benar-benar pernah dijalankan** (bukan hipotetis):

| Perintah | Frekuensi | Contoh nyata |
| --- | ---: | --- |
| `Remove-Item -Recurse` | 98 | `if (Test-Path C:\Users\DHIKA\.git) { Remove-Item -Recurse -Force C:\Users\DHIKA\.git }` |
| `rm -rf` | 39 | `ssh bw-server "cd /home/dhika && rm -rf clinic-work && git clone ..."` |
| kill by name (`taskkill /IM`) | 3 | `taskkill /f /im codex.exe; taskkill /f /im opencode.exe` |
| `Get-Process \| Stop-Process` | 9 | `Get-Process scrcpy \| Stop-Process -Force; Start-Process ...` |
| `git reset --hard` | 6 | `git reset --hard 1b94f9626` |
| `git push --force` | 5 | dorong ulang setelah rebase |
| `Stop-Process -Name` | 1 | `Stop-Process -Name "codex","opencode" -Force` |
| `DROP DATABASE` | 1 | `ssh ... psql -c "DROP DATABASE ..."` |

Allowlist yang mengizinkan semua ini tidak menambah keamanan apa pun. Allowlist
yang memblokirnya akan menghentikan pekerjaan yang memang sedang dikerjakan.

**Ini bukan alasan untuk tidak waspada.** Ini alasan untuk menargetkan penjagaan
pada risiko yang sebenarnya, bukan pada "segala yang terlihat berbahaya".

## Risiko yang sebenarnya

Dari seluruh daftar di atas, hanya **satu kelas** yang pernah merusak sesi:

> Perintah yang membunuh proses `node.exe`, karena setiap MCP server adalah
> proses Node.

Klaster A, B, dan C di `docs/MCP-PROCESS-SAFETY.md` semuanya kelas itu.
`Remove-Item -Recurse`, `git reset --hard`, dan `DROP DATABASE` berbahaya untuk
hal lain, tetapi tidak pernah menjatuhkan MCP.

## Rekomendasi: persempit, jangan perluas

Aturan yang terpasang sekarang **terlalu lebar** untuk pola kerja di mesin ini.
Contoh yang ikut terblokir padahal sah dan pernah dipakai:

```powershell
taskkill /f /im codex.exe          # membersihkan Codex, bukan MCP
Stop-Process -Name "codex","opencode" -Force
Get-Process scrcpy | Stop-Process -Force
```

Usulan: ganti 13 aturan menjadi 6 yang hanya menyasar **node**.

```jsonc
"permissions": [
  // taskkill yang menyasar proses bernama node*
  { "action": "shell", "resource": "taskkill */IM node*",  "effect": "deny" },
  { "action": "shell", "resource": "taskkill */im node*",  "effect": "deny" },

  // Stop-Process -Name yang menyebut node
  { "action": "shell", "resource": "Stop-Process *-Name*node*", "effect": "deny" },
  { "action": "shell", "resource": "stop-process *-name*node*", "effect": "deny" },

  // bentuk pipa yang menyebut node
  { "action": "shell", "resource": "Get-Process node*| Stop-Process*", "effect": "deny" },
  { "action": "shell", "resource": "Get-Process *| Stop-Process*node*", "effect": "deny" }
]
```

Yang berubah:

| Sebelum (13 aturan) | Sesudah (6 aturan) |
| --- | --- |
| `taskkill */IM *` - semua kill by name | hanya yang menyasar `node*` |
| `Stop-Process *-Name*` - semua kill by name | hanya yang menyebut `node` |
| `Get-Process *\| Stop-Process*` - semua pipa | hanya pipa yang menyebut `node` |
| `killall *`, `pkill *`, `wmic ... delete` | dibuang (tidak ada di mesin ini) |

### Trade-off yang harus kamu putuskan

| | Aturan sekarang (lebar) | Aturan sempit (usulan) |
| --- | --- | --- |
| MCP terlindungi dari `taskkill /IM node.exe` | ya | ya |
| `taskkill /f /im codex.exe` (pernah kamu pakai) | **diblokir** | jalan |
| `Stop-Process -Name "codex","opencode"` (pernah kamu pakai) | **diblokir** | jalan |
| `taskkill /F /IM git.exe` (pernah kamu pakai) | **diblokir** | jalan |
| `taskkill /IM other.exe` yang membunuh MCP secara tidak langsung | diblokir | **lolos** |
| Perintah yang dibangun dinamis (`& $cmd -Name node`) | lolos | lolos |

Berlaku juga untuk `Get-Process scrcpy | Stop-Process -Force` yang pernah dipakai:
diblokir aturan lebar, diizinkan aturan sempit.

Kolom terakhir sama di kedua pilihan: **pola teks bukan batas keamanan.** Kalau
perlindungan yang benar-benar kokoh yang diinginkan, satu-satunya cara adalah
menjalankan MCP server di luar jangkauan perintah agen - misalnya sebagai
service terpisah yang tidak berbagi nama proses Node.

## Kalau tetap ingin allowlist

Angka di atas tidak melarangnya, tetapi mengubah bentuknya. Allowlist yang
masuk akal untuk pola kerja ini adalah **allowlist per-alat, bukan per-perintah**:

1. **`git`** - allowlist karena hampir semua pemakaian aman dan bisa
   dicocokkan: `git status *`, `git diff *`, `git log *`, `git add *`,
   `git commit *`, `git push *`.
2. **`rg`** - allowlist: `rg *`.
3. **`npm test`**, **`npm run *`** - allowlist.
4. **`Get-Content *`**, **`Get-ChildItem *`**, **`Select-String *`** - allowlist
   baca-saja.
5. **`ssh *`**, **`pwsh *`**, **`node *`**, **`python *`** - **tidak bisa**
   di-allowlist dengan pola teks; isinya sepenuhnya dinamis. Untuk ini pilihannya
   hanya `ask` (prompt setiap kali) atau `allow` (seperti sekarang).

Karena keluarga terakhir mencakup **12.161 dari 21.462 perintah pwsh (56,7%)** -
lebih dari separuh - dan semuanya tidak bisa dicocokkan dengan andal, allowlist
akan menghasilkan ratusan prompt per hari atau kembali menjadi izin menyeluruh.

## Fakta yang paling menentukan

Dari 21.462 perintah, hanya **satu** yang menyasar proses node:

```text
taskkill /F /IM node.exe /T 2>$null; Write-Host "done"
```

Itu satu-satunya perintah yang benar-benar menjatuhkan MCP. Sementara itu ada
**tiga** kill-by-name yang menyasar proses **lain**:

```text
Stop-Process -Name "codex","opencode" -Force
taskkill /f /im codex.exe; taskkill /f /im opencode.exe
taskkill /F /IM git.exe
```

Aturan lebar yang terpasang sekarang memblokir keempat-empatnya, termasuk tiga
yang tidak berbahaya bagi MCP. Aturan sempit `*/IM node*` membiarkan tiga yang
tidak berbahaya itu berjalan, dan tetap menangkap satu yang berbahaya.

Itulah seluruh alasan rekomendasi persempitan: **presisi 1 dari 4**, bukan
kehati-hatian yang lebih besar.

## Sisa risiko

**Pola teks dapat diakali.** Ini batas yang tidak bisa ditutup dengan konfigurasi
permission. Perintah yang dirakit saat runtime tidak akan cocok dengan pola mana
pun.

**Aturan sempit menambah permukaan.** `taskkill /IM explorer.exe` tidak lagi
diblokir. Dampaknya ke MCP nol, tetapi dampaknya ke sesi Windows bisa besar.
Itu konsekuensi memilih presisi di atas keluasan.

**Angka di dokumen ini berasal dari satu mesin dan sepuluh hari.** Pola kerja bisa
berubah; kalau begitu, analisisnya perlu diulang dengan log yang baru.
