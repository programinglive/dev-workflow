# Workflow yang berbohong tentang keadaannya (31 Oktober 2026)

Empat cacat yang punya satu akar: laporan workflow dihitung dari yang
*diharapkan*, bukan dari yang *terjadi*. Semuanya menggigit pada satu hari kerja.

## 1. `perform_release` menyusun `--release-as null`

`determineReleaseTypeFromCommit()` bisa mengembalikan string kosong. Perintahnya
lalu disusun menjadi:

```
npm run release -- --release-as null
```

standard-version menerimanya: `package.json` ditulis dengan `"version": null`,
tag `vnull` dibuat, lalu keduanya di-push. Yang salah bukan hanya hasilnya -
perintah yang mustahil itu dijalankan tanpa perlawanan.

**Perbaikan.** Tipe rilis divalidasi terhadap `{major, minor, patch}` SEBELUM
perintah disusun. Kalau tidak bisa ditentukan dari commit, rilis tidak
dijalankan dan pesannya meminta tipe eksplisit. Ada juga jaring pengaman yang
menolak perintah akhir bila masih mengandung `null`.

## 2. Push rilis gagal tidak melaporkan apa yang tertinggal

`git push --follow-tags` gagal setelah commit rilis dan tag sudah dibuat di
mesin. Jawabannya hanya berisi stderr git. Commit dan tag tetap ada secara
lokal, tetapi tidak disebut, sehingga tidak jelas apa yang harus dibereskan -
dan rilis tampak selesai.

**Perbaikan.** HEAD dan tag terakhir dicatat sebelum rilis. Kalau push gagal,
laporannya menyebut commit dan tag yang tertinggal, plus langkah pemulihan
(kirim ulang, atau batalkan rilis lokal). Kalimat "Rilis TIDAK tercatat sebagai
selesai" ada di baris pertama.

## 3. `commit_and_push` melaporkan repo yang salah

Label `Repo: ...` dihitung dari variabel global yang bisa berubah, bukan dari
repo tempat git benar-benar berjalan. Sekali waktu laporan menyebut
`portal-beautyworld` untuk commit yang masuk ke repo lain. Laporan seperti itu
membuat agen percaya commit-nya ada di tempat yang salah - kelas kesalahan yang
paling mahal, karena tampak berhasil.

**Perbaikan.** Repo diambil dari `git rev-parse --show-toplevel`, yaitu jawaban
git sendiri. Kalau repo itu berbeda dari `projectDir` yang diminta, commit
**dibatalkan** sebelum apa pun dijalankan. Label laporan memakai nilai yang
sama dengan yang dipakai git.

## 4. `npm test` menghapus task yang sedang berjalan

Dua mekanisme bertumpuk:

1. `resolveStateFile()` memilih proyek dari `process.cwd()`. Karena tes dijalankan
   dari akar paket, dan akar paket punya `package.json`, setiap
   `new WorkflowState()` tanpa argumen menulis ke `.state/workflow-state.json`
   milik repo.
2. `ensureCompatibilityLinks()` **selalu** menulis cermin ke
   `<paket>/.state/workflow-state.json`, di mana pun state aslinya berada. Jadi
   bahkan tes yang memakai direktori sementara tetap menimpa state repo.

Diukur saat itu: **16 dari 53 berkas tes** mengubah `.state/workflow-state.json`.
Akibatnya `get_workflow_status` tiba-tiba melaporkan task bernama sebuah tes, dan
seluruh langkah workflow hilang di tengah pekerjaan.

**Perbaikan.**

- `tests/setup-env.js` (baru) dijalankan lewat
  `node --import ./tests/setup-env.js --test`, mengarahkan
  `DEV_WORKFLOW_STATE_FILE` dan `DEV_WORKFLOW_DB_PATH` ke direktori sementara.
- `ensureCompatibilityLinks()` menghormati `DEV_WORKFLOW_NO_COMPAT_LINKS=1`, yang
  ditetapkan preload tes. Perilaku produksi tidak berubah.
- Tes yang memang menguji pemilihan path (`workflowState.test.js`,
  `session-metadata-e2e.test.js`) mengosongkan variabel itu sendiri, dengan
  komentar alasannya.

Bukti: hash `.state/workflow-state.json` **identik** sebelum dan sesudah suite
penuh (441 tes).

## Berkas

| Berkas | Perubahan |
|---|---|
| `tools/handler-modules/release-handlers.js` | validasi tipe rilis, laporan sisa rilis saat push gagal |
| `tools/handler-modules/commit-handlers.js` | repo dari `git rev-parse --show-toplevel`, tolak repo tak cocok |
| `git-helpers.js`, `git-facade.js` | `getToplevel()` |
| `workflow-state.js` | `DEV_WORKFLOW_NO_COMPAT_LINKS` |
| `tests/setup-env.js` | isolasi state tes |
| `tests/workflow-truthfulness.test.js` | 7 tes |

## Bukti tes bergigi

| Perubahan sementara | Hasil |
|---|---|
| Validasi tipe rilis dihapus | tes rilis tanpa tipe GAGAL |
| Laporan sisa rilis dihapus | tes push gagal GAGAL (tidak menyebut commit/tag) |
| Cek toplevel dihapus | tes repo berbeda GAGAL (commit tetap jalan diam-diam) |
| `DEV_WORKFLOW_NO_COMPAT_LINKS` dihapus | tes cermin GAGAL: "State milik repo berubah selama tes" |

## Yang belum ditutup

- `claim_factory_task` mengganti task lokal yang sedang berjalan tanpa
  konfirmasi (terjadi saat mengerjakan task ini).
- `commit_and_push` melaporkan "No changes detected" ketika state menunjuk task
  yang sudah selesai. Pesannya sekarang menyebut repo yang benar, tetapi kondisinya
  sendiri belum dibedakan dari "sudah di-commit".
