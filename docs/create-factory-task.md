# create_factory_task: mencatat pekerjaan ke board

Tanggal: 26 Oktober 2026
Modul: MCP dev-workflow / integrasi Factory

---

## Masalah

Sesi kerja nyata (perbaikan ERP 12:00-13:10) tidak menghasilkan satu pun task di
Factory. Board tetap 20 task, isinya sama seperti sebelum mulai.

Penyebabnya struktural, bukan kelalaian:

| Jalur tulis Factory | Diekspos sebagai tool MCP? |
|---|---|
| `POST /api/factory { create_task }` | **tidak** |
| `POST /api/factory { move_task }` | ya, lewat `sync_task_status` |
| `POST /api/factory { update_task }` | tidak |
| `POST /api/work { start }` | ya, `claim_factory_task` |
| `POST /api/work { finish }` | ya, `sync_task_status` |

`sync_task_status` butuh `recordId` milik task yang **sudah ada**. Tanpa
`create_task`, agen tidak punya cara membuat task baru, sehingga `start_task`
hanya menulis ke SQLite lokal `dev-workflow` dan tidak pernah menyentuh Factory.

---

## Perbaikan

Dua tool baru, keduanya memakai jalur tulis resmi yang sudah ada. Tidak ada
jalur baru, tidak ada akses database langsung.

### `list_factory_projects`

`create_task` mewajibkan `projectId` berupa UUID. Agen tidak bisa mengarangnya,
jadi tool ini menampilkan daftar project beserta UUID-nya.

### `create_factory_task`

Memanggil `POST /api/factory { action: "create_task" }`.

**Default `status: "backlog"`.** Ini keputusan keamanan yang disengaja:

Factory membuat **worker run** untuk task `queued`, dan worker itu mengeksekusi
perintah dari blok ` ```run ` di kolom acceptance. Kalau `create_factory_task`
default ke `queued`, mencatat pekerjaan akan diam-diam menjalankan perintah di
server. Mencatat ≠ mengeksekusi, jadi default-nya `backlog`.

`queued` tetap tersedia sebagai opt-in eksplisit, dan Factory sendiri menolak
(409) task `queued` tanpa blok ` ```run `.

### Validasi lokal

Payload Factory divalidasi ketat oleh zod. Batas yang sama diterapkan di client
supaya agen dapat pesan yang bisa ditindaklanjuti, bukan HTTP 400 opaque:

| Field | Aturan |
|---|---|
| `projectId` | wajib, harus UUID |
| `title` | 3-140 karakter |
| `acceptance` | 3-3000 karakter, wajib |
| `description` | maks 4000 karakter |
| `priority` | `low` / `normal` / `high` |
| `status` | `backlog` / `queued` |

Validasi berjalan **sebelum** request, jadi input tidak valid tidak menghubungi
Factory sama sekali.

---

## Verifikasi

### Test (14 test, semua memakai `fetch` palsu - tidak menyentuh Factory asli)

```
✔ createTask posts create_task with the exact shape Factory validates
✔ createTask defaults to backlog so recording work never starts a worker run
✔ createTask returns the runId when Factory enqueues a run
✔ createTask omits an empty description rather than sending undefined
✔ createTask rejects a projectId that is not a UUID before calling Factory
✔ createTask requires projectId
✔ createTask enforces title length 3-140
✔ createTask requires acceptance, because Factory rejects a task without it
✔ createTask rejects unknown priority and status instead of forwarding them
✔ creatable statuses stay limited to what create_task accepts
✔ createTask surfaces Factory's own error message
✔ listProjects maps the workspace payload to id/name/repository
✔ formatProjectList says what to do when the workspace has no project
✔ formatProjectList shows the UUID so it can be copied into create_factory_task
```

Seluruh suite: **178 lulus, 0 gagal, 2 di-skip** (sebelumnya 164 lulus).

### Bug yang ditemukan test sendiri

Test "requires acceptance" menemukan `TypeError: Cannot read properties of null
(reading 'length')` saat `acceptance` kosong, karena `clean()` mengembalikan
`null`. Diperbaiki di produksi (`|| ""`), bukan dengan melonggarkan test.

### Uji nyata ke Factory

`list_factory_projects` mengembalikan **69 project** sungguhan.

Tiga task hari ini dicatat ke project
`beautyworld_repository/erp.beautyworld.co.id`
(`32876fab-3b54-421c-9e9d-57cae8f81203`), semuanya `backlog`:

| Task | ID | Priority |
|---|---|---|
| RS gantung hilang di WAREHOUSE ARCADIA | `2434d8b7` | high |
| Slip bisa lahir tanpa RS/AS/BO | `c69c4c2b` | high |
| Migrasi permission/media dan 5 config | `f0caa120` | normal |

Diverifikasi ulang lewat `list_factory_tasks` (bukan dari output `create`),
sehingga terlihat dari sisi board.

---

## Catatan

- Tool ini **aditif**. Tidak ada tool lama yang diubah perilakunya.
- Tool baru belum muncul di katalog MCP sesi ini karena katalog dimuat saat
  startup; perlu restart sesi. Uji nyata di atas dijalankan lewat pemanggilan
  handler langsung.
- `create_project` **belum** diekspos. Belum dibutuhkan: 69 project sudah ada,
  dan membuat project adalah keputusan pemilik workspace.

---

## Berkas yang berubah

| Berkas | Perubahan |
|---|---|
| `factory-client.js` | `createTask`, `listProjects`, `formatProjectList`, konstanta validasi |
| `tools/handler-modules/factory-handlers.js` | `handleCreateFactoryTask`, `handleListFactoryProjects` |
| `tools/handler-modules/index.js` | wiring dua case baru |
| `tools/definitions.js` | dua definisi tool |
| `tests/create-factory-task.test.js` | baru, 14 test |
