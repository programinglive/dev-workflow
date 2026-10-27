# State workflow dipakai bersama antar sesi: apa yang diperbaiki

Tanggal: 27 Oktober 2026

## Masalah

Berkas state workflow disimpan **per user OS**, bukan per sesi agen:

```
<root>/.state/user-id                                  -> user-1a171645d22-788e41b9
<root>/.state/users/<user-id>/workflow-state.json      -> satu untuk SEMUA sesi
```

Dua sesi OpenCode di mesin yang sama berbagi berkas itu. Akibatnya:

1. `start_task` di sesi B memanggil `reset()` yang **mengganti seluruh state**
   sesi A. Pekerjaan A hilang.
2. `history` hanya ditulis saat task **ditutup** (`complete_task`,
   `force_complete_task`, `drop_task`). Task yang ditinggalkan di tengah jalan
   **tidak pernah masuk history** — lenyap tanpa jejak.
3. `taskDescription` dan `lastCommitMessage` dipakai `commit_and_push`, sehingga
   sesi B bisa membuat commit dengan pesan milik sesi A, atau menutup task A.

### Kejadian nyata

26–27 Oktober 2026, saat resize `docker-alma`:

- Task `Kecilkan RAM docker-alma...` dijalankan, semua langkah selesai
  (60 tes lulus, dokumentasi, ready check).
- `get_workflow_status` menampilkan task **milik orang lain**:
  "Portal Beautyworld: halaman Temuan".
- Task docker-alma itu **tidak pernah muncul** di `view_history`.

Kejadian serupa berulang tiga kali dalam dua hari.

## Yang diperbaiki

### 1. Pekerjaan yang tertimpa tidak hilang

`save()` sekarang merekonsiliasi dengan isi berkas di disk **sebelum** menulis:

- `history` dari proses lain **digabungkan**, tidak ditimpa.
- Kalau berkas di disk memuat task yang **sedang berjalan** milik proses lain,
  task itu diarsipkan ke `history` sebagai `interrupted: true` sebelum ditimpa.

`start_task` memakai `reset({ archive: true })` sehingga task sendiri yang belum
selesai juga diarsipkan, bukan dibuang.

### 2. `reset()` sengaja OPT-IN

`complete_task`, `force_complete_task`, dan `drop_task` sudah memanggil
`addToHistory()` lalu `reset()`. Kalau `reset()` mengarsipkan secara default,
entri akan **ganda**.

Karena itu `reset()` hanya mengarsipkan bila dipanggil dengan
`{ archive: true }`. Perilaku lama tidak berubah.

### 3. Agen diberi tahu, bukan dibiarkan menebak

Setiap penulisan mencap identitas proses:

```json
"owner": { "token": "proc-<pid>-<acak>", "pid": 1234, "updatedAt": "..." }
```

- `start_task` menampilkan peringatan bila ada task proses lain yang hampir
  tertimpa, dan menyebut nama task itu.
- `get_workflow_status` menampilkan peringatan bila berkas terakhir ditulis
  proses lain, termasuk apa yang sedang dikerjakan proses itu.

## Yang TIDAK diperbaiki

**Isolasi penuh per sesi belum ada.** Dua sesi masih berbagi satu berkas.
Yang berubah: tidak ada pekerjaan yang hilang tanpa jejak, dan agen diberi tahu.

Kalau isolasi penuh diinginkan, opsinya:

| Opsi | Isi |
|---|---|
| a | Kunci state per sesi: `userId` + session id / pid |
| b | Kunci per task: `.state/users/<id>/tasks/<taskId>.json` |

Opsi (a) paling tepat sasaran. Kendalanya: server MCP perlu identitas sesi yang
stabil, yang belum tersedia sekarang.

## Cara memverifikasi

```bash
node --no-deprecation --test tests/shared-state.test.js
```

15 tes mengunci tiga janji di atas, termasuk:

- `reset()` tanpa opsi **tidak** menambah history (kompatibilitas `complete_task`)
- `save()` menyelamatkan task berjalan milik proses lain
- `save()` menggabungkan history proses lain
- arsip tidak dobel walau `save()` dipanggil berulang
- `start_task` dan `get_workflow_status` benar-benar menampilkan peringatan

## Untuk pekerjaan sehari-hari (sampai isolasi penuh ada)

1. **Selalu** periksa baris `Task:` di `get_workflow_status` sebelum
   `commit_and_push`. Kalau bukan task Anda, batalkan dan commit manual.
2. Kalau melihat peringatan "state dipakai bersama", artinya ada sesi lain aktif
   di direktori kerja yang sama.