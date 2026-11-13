# Dua klaim tanpa bukti: claim yang menghapus kerja, dan commit yang mengaku selesai (31 Oktober 2026)

Keduanya punya bentuk sama: tool menyatakan sesuatu tentang keadaan yang tidak
ia ketahui.

## 1. `claim_factory_task` menghapus task lokal tanpa jejak

`handleClaimFactoryTask` memanggil `workflowState.reset()` **tanpa** `archive`.
`start_task` sudah lama memakai `reset({ archive: true })`; claim tidak.

Akibatnya, 31 Oktober 2026, claim di tengah task lain membuat task itu lenyap:
tidak ada entri history, tidak ada peringatan, tidak disebut di jawaban. Yang
sedang berjalan saat itu adalah tahap rilis task lain. Pekerjaannya selamat
hanya karena sudah ter-commit; kalau belum, tidak akan ada catatan bahwa task
itu pernah ada.

**Perbaikan.** Claim memakai `reset({ archive: true, reason })` dan menyebut task
yang diarsipkan di jawabannya:

```
⚠️ Task lokal yang belum selesai diarsipkan ke history: "<judul>".
Pekerjaannya tidak dihapus, tetapi tidak lagi aktif di sesi ini.
```

Kalau memang tidak ada task lokal, tidak ada yang dilaporkan - tidak ada pesan
palsu.

## 2. `commit_and_push` mengaku "sudah selesai" saat tidak commit apa pun

Saat working tree bersih, jawabannya:

```
ℹ️ No changes detected. Assuming commit and push already completed.
```

Kata *Assuming* adalah klaim tanpa bukti. Yang benar-benar diperiksa hanya satu
hal: HEAD ada di remote. Itu membuktikan commit terakhir terkirim - **bukan**
bahwa commit itu berisi pekerjaan task ini.

Terjadi 31 Oktober: setelah `perform_release`, state masih `ready_to_complete`
dengan `readyToCommit`/`readyCheckCompleted` sudah true, sehingga pemeriksaan
kesiapan dilewati dan jawaban di atas keluar dengan pesan commit lama dari task
sebelumnya. Agen bisa membacanya sebagai "pekerjaan saya sudah masuk".

**Perbaikan.** Jawabannya sekarang memisahkan dua hal:

- yang **terbukti**: commit terakhir ada di remote, beserta SHA-nya;
- yang **tidak terbukti**: bahwa commit itu berisi pekerjaan task ini.

Ditambah satu baris khusus saat state `idle`: tidak ada task aktif, jadi memang
tidak ada yang diharapkan. Frasa `No changes detected` dan `verified on remote`
dipertahankan supaya pemanggil dan tes lama tidak rusak.

## Berkas

| Berkas | Perubahan |
|---|---|
| `tools/handler-modules/factory-handlers.js` | claim mengarsipkan + melaporkan |
| `tools/handler-modules/commit-handlers.js` | jawaban tanpa perubahan menyatakan apa yang terbukti |
| `tests/claim-preserves-local-task.test.js` | 2 tes |
| `tests/workflow-truthfulness.test.js` | 2 tes baru |

## Bukti tes bergigi

| Perubahan sementara | Hasil |
|---|---|
| `archive: true` diganti `false` | tes arsip claim GAGAL |
| Kalimat jujur dikembalikan ke "Assuming commit and push already completed" | tes "tidak mengaku sudah commit" GAGAL |

Suite: 445 tes, 442 lulus, 3 dilewati, 0 gagal. Hash `.state/workflow-state.json`
identik sebelum dan sesudah suite.

## Yang belum ditutup

- Claim tetap **mengganti** task lokal, bukan menolak. Arsipnya sekarang
  tercatat, tetapi agen tetap kehilangan konteks aktif tanpa bisa memilih.
  Menolak claim saat ada task berjalan akan lebih aman, tetapi mengubah alur
  yang mungkin dipakai sengaja - perlu keputusan pemilik.
- `readyToCommit`/`readyCheckCompleted` tidak direset saat task baru dimulai di
  proses yang sama, sehingga pemeriksaan kesiapan bisa terlewat. Itu akar dari
  kasus kedua di atas; memperbaikinya menyentuh siklus hidup state, jadi
  dicatat di sini alih-alih ditambal diam-diam.
