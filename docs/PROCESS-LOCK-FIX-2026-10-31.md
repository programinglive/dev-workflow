# Penanda proses MCP: salah tempat dan bisa dilewati (31 Oktober 2026)

Perbaikan di rilis 1.13.13 **tidak bekerja**. Dokumen ini mencatat bukti dan
perbaikannya.

## Bukti kegagalan

Setelah restart penuh, keadaan nyata:

| Fakta | Arti |
|---|---|
| 2 proses MCP hidup (PID 26604, 7516) | proses ganda masih terjadi |
| Hanya **1** lock file (pid 7516) | 26604 tidak pernah menulis penanda |
| Lock ada di `.state/users/<user>/` | lokasi tergantung direktori user |

Dua cacat terpisah.

### Cacat 1: penanda ditulis di dalam `try` yang sama dengan inisialisasi state

```js
try {
  workflowState = new WorkflowState();
  ...
  try {
    acquireProcessLock(...);   // <- tidak pernah jalan kalau baris di atas melempar
  } catch { ... }
} catch (error) {
  workflowState = new WorkflowState();   // <- penanda dilewati
}
```

Saat dua proses start serempak, salah satunya gagal menginisialisasi state
(berebut berkas yang sama), masuk ke `catch` luar, dan penandanya tidak pernah
ditulis. Proses itu jadi tidak terlihat oleh proses lain.

**Perbaikan.** Penanda ditulis di luar `try/catch` inisialisasi state, sehingga
selalu dieksekusi.

### Cacat 2: lock diletakkan di direktori user, bukan proyek

`path.dirname(stateFile)` menunjuk `.state/users/<user>/`. Direktori user bisa
BERBEDA antar proses (id user dibuat per direktori state), sehingga dua proses
di proyek yang sama menulis lock ke tempat berbeda dan tidak pernah saling
melihat.

**Perbaikan.** `projectLockDir()` naik sampai menemukan direktori `.state` dan
memakai direktori itu, jadi satu lock per PROYEK:

```
.state/mcp-process.lock          <- sekarang
.state/users/<user>/mcp-process.lock   <- sebelumnya, bisa berbeda per proses
```

### Cacat 3: kegagalan menulis lock ditelan

`acquireProcessLock` mengembalikan `{ acquired: true, wrote: false }` tanpa
sebabnya, jadi sistem tampak sehat padahal tidak ada penanda di disk.

**Perbaikan.** Sebabnya disimpan (`error`) dan `lockWarning` melaporkannya:

```
Tidak bisa menulis penanda proses ke mcp-process.lock (EACCES).
Deteksi proses MCP ganda tidak akan bekerja sampai ini diperbaiki.
```

## Verifikasi nyata

Dua server dijalankan serempak dari direktori yang sama. Server kedua mencatat:

```
Proses dev-workflow MCP lain (PID 26040, hidup sejak 2026-10-31T01:47:50.545Z)
masih berjalan dan memakai direktori state yang sama. ...
Tutup OpenCode lalu buka lagi untuk memastikan hanya satu proses yang hidup.
```

Lock file berada di `.state/mcp-process.lock` (satu per proyek), bukan di
direktori user.

## Berkas

| Berkas | Perubahan |
|---|---|
| `process-lock.js` | `projectLockDir()`, laporan kegagalan tulis |
| `index.js` | penanda ditulis di luar `try` inisialisasi state |
| `tests/process-lock.test.js` | 4 tes baru (13 total) |

## Bukti tes bergigi

| Perubahan sementara | Hasil |
|---|---|
| `projectLockDir` dihapus, kembali ke `path.dirname(stateFile)` | 2 tes lokasi lock GAGAL |
| Sebab kegagalan tulis tidak disimpan | tes "gagal menulis dilaporkan" GAGAL |

Suite: 449 tes, 446 lulus, 3 dilewati, 0 gagal. Hash
`.state/workflow-state.json` identik sebelum dan sesudah suite.

## Catatan operasional: restart OpenCode tidak cukup

Ditemukan saat memperbaiki ini, dan penting untuk lain kali:

- Menutup jendela OpenCode **tidak** mematikan `opencode-cli.exe serve --service`.
  Backend itu tetap hidup dan tetap memegang proses MCP lama.
- Anak proses MCP yang sudah dimatikan manual tidak di-spawn ulang oleh backend
  yang sudah ada; server MCP hilang sampai backend ikut dimatikan.
- Cara yang terbukti: matikan proses MCP, matikan `opencode-cli.exe serve
  --service`, lalu buka OpenCode lagi. Kalau masih gagal, restart komputer.

Cek cepat:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dev-workflow*' } |
  Select-Object ProcessId, CreationDate
```
