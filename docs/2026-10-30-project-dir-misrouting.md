# Repo salah arah: satu `WORKFLOW_PROJECT_DIR` membajak semua sesi

Tanggal: 30 Oktober 2026
Status: diperbaiki

## Gejala

`commit_and_push` menjalankan `git add .` di `D:\code\clinic`, sementara
pekerjaan sebenarnya ada di `D:\code\bw-server-grooming` dan di
`C:\Users\<username>\Documents\Default Project`. Tool menjawab
"repo bersih → No changes detected → assuming already completed" dan menandai
tahap commit selesai, padahal tidak ada commit sama sekali.

Gejalanya tidak terlihat berbahaya: tidak ada error, tidak ada kegagalan push,
tidak ada berkas yang hilang. Yang hilang adalah *commit itu sendiri*.

## Akar masalah

`resolveWorkingDirectory()` di `exec.js` memakai urutan:

```
explicit -> WORKFLOW_PROJECT_DIR/PROJECT_DIR -> candidates (cwd)
```

`WORKFLOW_PROJECT_DIR` adalah variabel lingkungan **satu nilai untuk seluruh
proses MCP**. Di mesin ini nilainya `D:\code\clinic`, dipasang di
`~/.config/opencode/opencode.json` pada blok `dev-workflow`:

```json
"environment": {
  "WORKFLOW_PROJECT_DIR": "D:\\code\\clinic"
}
```

Karena env dicek **sebelum** direktori kerja sesi, setiap sesi OpenCode — di
repo mana pun — menjalankan git di clinic. Clinic bersih, jadi `git status`
menjawab kosong, `hasWorkingChanges()` menjawab `false`, dan handler menyimpulkan
"already committed".

Yang membuat ini berbahaya: `false` dari `hasWorkingChanges()` adalah jawaban
yang **valid** untuk "tidak ada perubahan". Tidak ada cara membedakan
"repo ini bersih" dari "ini bukan repo yang dimaksud".

## Kenapa perbaikan sebelumnya tidak menutupnya

Commit 29–30 Oktober 2026 sudah memperbaiki dua hal lain di jalur yang sama:

- server tidak lagi jatuh ke repo paket MCP sebagai cadangan;
- `hasWorkingChanges()` tidak lagi menelan error dan menjawab `false`.

Keduanya benar, dan keduanya tidak menyentuh bug ini: path repo tetap
ditentukan, `git status` tetap berhasil, dan hasilnya tetap "bersih" — hanya di
repo yang salah.

## Perbaikan

### 1. `projectDir` per sesi (jalur utama)

Argumen baru `projectDir` pada `start_task`:

```json
{ "description": "...", "type": "bugfix", "projectDir": "D:\\code\\bw-server-grooming" }
```

Nilainya disimpan di `workflowState.state.projectDir`, lalu dipakai semua operasi
git berikutnya lewat `setActiveProjectDir()`. Urutan resolusi menjadi:

```
explicit (argumen) -> pinned (start_task) -> env -> cwd
```

`projectDir` juga diterima langsung oleh `commit_and_push` dan `perform_release`,
supaya commit yang salah arah bisa dibetulkan tanpa mengulang task.

### 2. Repo yang dipakai selalu dilaporkan

`start_task` menjawab:

```
📁 Repo proyek: D:\code\clinic (dari WORKFLOW_PROJECT_DIR (nilai global))
```

`commit_and_push` menyertakan `Repo: <path>` di setiap jawaban, termasuk pada
"No changes detected". Tanpa ini, "No changes detected" tidak bisa dibedakan
dari "git berjalan di repo yang salah" — persis yang menyamarkan insiden ini.

### 3. Konflik dilaporkan, bukan didiamkan

`resolveProjectDir()` mengembalikan `conflict` bila `WORKFLOW_PROJECT_DIR`
menunjuk repo A sementara direktori sesi menunjuk repo B. `start_task` lalu
menulis:

```
⚠️ KONFLIK: direktori sesi menunjuk repo lain, D:\code\bw-server-grooming.
   Repo dipilih dari WORKFLOW_PROJECT_DIR. Kalau task ini untuk repo sesi,
   ulangi 'start_task' dengan projectDir: "D:\code\bw-server-grooming".
```

### 4. Env tetap menang — dengan sengaja

`WORKFLOW_PROJECT_DIR` **tidak** diturunkan di bawah cwd. Ada test yang
mengandalkan env sebagai penunjuk repo eksplisit di mesin dengan banyak proyek,
dan menurunkannya akan merusak itu. Yang diperbaiki bukan prioritasnya, tapi
tidak adanya jalan keluar per-sesi dan tidak adanya peringatan.

### 5. Config mesin ini

`WORKFLOW_PROJECT_DIR` dihapus dari `~/.config/opencode/opencode.json`. Mesin ini
mengerjakan banyak repo, jadi satu nilai global hanya menghasilkan salah arah.
Backup: `opencode.json.bak-workflowdir-<timestamp>`.

## Test

`tests/project-dir-resolution.test.js` — 14 test:

| Test | Menjaga |
|---|---|
| projectDir eksplisit menang atas env | prioritas #1 |
| cwd menunjuk repo lain → `conflict` dilaporkan | regresi utama |
| tidak ada konflik bila env dan cwd repo yang sama | tidak ada alarm palsu |
| pinned menang atas cwd dan env | prioritas #2 |
| env tetap dipakai tanpa projectDir sesi | backward compatibility |
| projectDir bukan repo → error menyebut cara perbaiki | pesan yang berguna |
| start_task menyimpan & mengaktifkan projectDir | wiring |
| start_task melaporkan KONFLIK | wiring |
| start_task dengan projectDir tidak melaporkan konflik | tidak over-warning |
| commit_and_push menyebut repo yang diperiksa | anti "No changes" palsu |
| commit_and_push menolak projectDir tidak valid | validasi |

Diverifikasi bahwa test **benar-benar menangkap** bug: dengan prioritas lama
dipulihkan (env mengalahkan cwd), test gagal dengan
`actual = global-...`, `expected = session-...`.

Suite penuh: **400 test, 397 lulus, 0 gagal, 3 skip**.

## Pelajaran

Nilai konfigurasi yang global (satu per proses) cocok untuk mesin yang hanya
mengerjakan satu proyek. Untuk server MCP yang hidup di banyak sesi, keputusan
"repo mana" harus per sesi — dan hasilnya harus selalu terlihat, supaya
kekeliruan konfigurasi muncul sebagai peringatan, bukan sebagai "sukses".
