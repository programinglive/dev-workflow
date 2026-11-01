# Satu berkas state untuk semua proyek (diperbaiki 1 November 2026)

## Gejala

Pada 1 November 2026 dua sesi OpenCode di mesin HELLOWORLD saling menimpa:

- Bukti Definition of Done milik task "Clinic CLI: vault token per platform"
  tertulis ke tujuh item DoD task lain, "Tambah status cancelled pada papan task"
  (proyek `daily-activity-journal`).
- `start_task` menolak dua kali dengan alasan "sesi lain sedang mengerjakan
  proyek ini", padahal yang berdetak adalah proses MCP yang sedang menganggur
  di proyek yang sama sekali lain.
- Pemaksaan dengan `force` membuat state task yang satu menimpa yang lain.

Gejalanya menyesatkan karena setiap tool menjawab "berhasil". Yang rusak adalah
*slot* task-nya: hanya ada satu untuk seluruh mesin.

## Akar masalah

`resolveStateFile()` mengembalikan `DEV_WORKFLOW_STATE_FILE` apa adanya bila
variabel itu dipasang:

```js
const customPath = process.env.DEV_WORKFLOW_STATE_FILE;
if (customPath) return path.resolve(customPath);   // <- satu berkas untuk semua
```

Config mesin ini memasangnya ke satu berkas:

```jsonc
"DEV_WORKFLOW_STATE_FILE": "D:\\code\\dev-workflow-mcp-server\\.state\\workflow-state.json"
```

Akibatnya, untuk SEMUA proyek dan SEMUA lokasi OpenCode:

- satu berkas state = satu slot task;
- `projectLockDir()` naik sampai menemukan `.state`, jadi lock penjaga juga
  satu untuk semua proyek - itulah kenapa peringatan "sesi lain" menyala untuk
  proyek yang tidak berhubungan.

Tanpa pin, mekanisme yang benar sudah ada: state per sesi di
`<proyek>/.state/users/<user>/workflow-state.<sesi>.json`, riwayat per proyek,
lock per `<proyek>/.state`.

## Perbaikan

Pin **tidak dihapus**, artinya yang diubah. Pin sekarang berarti *direktori
dasar*, dan tiap proyek mendapat subdirektorinya sendiri:

```
<dasar>/projects/<nama-proyek>-<hash10>/workflow-state.json
<dasar>/projects/<nama-proyek>-<hash10>/mcp-process.lock
```

`projectLockDir()` mengenali tata letak `projects/<proyek>/` dan berhenti di
sana, sehingga penjaga kembali sejauh proyek - bukan sejauh mesin.

Pin sengaja dipertahankan karena `.state` **tidak** di-ignore di sebagian repo
(`clinic`, `infra-knowledge-mcp-server`, `portal-beautyworld`,
`daily-activity-journal`). Mencabut pin akan menaruh berkas state di dalam
working tree repo-repo itu dan mengotori `git status`.

### Migrasi

Saat pertama kali dijalankan, bila `<dasar>/workflow-state.json` lama ada dan
`projectDir` di dalamnya memang proyek yang sedang dipakai, isinya **disalin**
ke berkas proyeknya. Bila `projectDir`-nya proyek lain, tidak disalin - memindahkannya
justru mengulang kesalahan yang sedang diperbaiki. Berkas lama tidak dihapus
karena ia juga menyimpan riwayat era sebelumnya.

Kalau tidak ada proyek yang bisa dikenali dari `cwd`/`INIT_CWD`, pin dipakai apa
adanya (perilaku lama). Fallback ke direktori modul sengaja **tidak** dipakai di
jalur ini: direktori acak akan dianggap proyek "dev-workflow-mcp-server" dan
state-nya nyasar ke sana.

## Batas yang tersisa

Dua sesi pada **satu proyek yang sama** tetap berbagi satu berkas state. Itu
disengaja: penjaganya adalah lock per proyek, dan sesi kedua kini ditolak dengan
alasan yang benar, bukan ditolak karena proyek tetangga.

## Cara memverifikasi

```bash
node --no-deprecation --import ./tests/setup-env.js --test tests/state-per-project.test.js
```

Sembilan tes menutup: state per proyek, proyek berbeda tidak berbagi berkas,
lock per proyek, riwayat tidak tercampur, migrasi hanya untuk proyek yang
berhak, dan pin tetap dipakai bila proyek tidak dikenali.

Seluruh suite: `npm test` - 561 tes, 0 gagal.
