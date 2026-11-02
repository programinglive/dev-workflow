# Penyimpanan state workflow

Sejak rilis 1.20.0, **state hidup workflow disimpan di SQLite lokal**, bukan di
berkas JSON.

| Lapisan | Isi | Sifat | Kalau mati |
|---|---|---|---|
| `<proyek>/.state/dev-workflow.db` | state per sesi, history, ringkasan | **sumber kebenaran**, wajib | tulis ditolak, pesan jelas |
| tabel `sync_queue` (di berkas yang sama) | salinan yang belum terkirim | wajib | — |
| Postgres `devwf_monitor` | salinan untuk dashboard | replika, best-effort | workflow jalan, dashboard basi |
| `.state/**/*.json` | ekspor cadangan | keluaran saja | dicatat, tidak menggagalkan simpan |

Satu kalimat yang merangkum desainnya: **tidak ada operasi workflow yang
menunggu jaringan.**

## Mengapa berubah

Dulu state disimpan di satu berkas JSON per sesi. Pemisahan per sesi sudah
dipasang, tetapi masih bergantung pada tiga hal yang tidak selalu benar: metadata
sesi yang harus dikirim klien, protokol penguncian berkas yang harus dipatuhi
semua penulis, dan penjaga `detectStaleOverwrite` yang sifatnya **mendeteksi lalu
memperbaiki** — bukan mencegah.

Sekarang tabrakan tidak bisa terjadi, karena:

1. Kunci baris memuat `session_key`, sehingga dua sesi tidak pernah menunjuk
   baris yang sama.
2. Setiap baris membawa `version`. Tulisan dengan versi basi ditolak, bukan
   menimpa.

## Skema

```sql
workflow_state (
  user_id, project_path, session_key,   -- kunci utama
  state_json, version, updated_at
)
```

Arti `key_source` di `state_writer`:

| Nilai | Arti |
|---|---|
| `request-metadata` | kunci berasal dari `_meta["ai.opencode/sessionID"]` — paling akurat |
| `env` | kunci berasal dari `DEV_WORKFLOW_SESSION_ID` / `OPENCODE_SESSION_ID` |
| `process-random` | cadangan `proc-<uuid>`, satu per proses |
| `legacy-file` | hasil migrasi berkas JSON lama |
| `legacy-db` | cadangan dari tabel `workflow_state` lama |

`legacy-db` hanya dipakai untuk proyek yang sudah kehilangan semua berkas
JSON-nya.

## Yang perlu diketahui alat lain

**Berkas JSON tidak lagi dibaca sebagai kebenaran.** Alat yang membaca
`.state/**/workflow-state*.json` akan melihat data yang benar saat sesi menyimpan,
tetapi mengubahnya dengan tangan **tidak** mengubah apa pun yang dipakai agen.

Berkas itu tetap ditulis karena dua alasan: memudahkan pemeriksaan manual, dan
menjaga alat lama tidak putus.

## Migrasi

Berjalan sekali, ditandai di tabel `migration_log` sebagai `legacy-json-v1`:

1. Isi `workflow_state` bentuk lama (berkunci per proyek) diarsipkan ke
   `workflow_state_legacy`. Baris itu milik **penulis terakhir**, bukan milik sesi
   mana pun, jadi tidak boleh dijadikan state hidup.
2. Berkas `workflow-state.<sesi>.json` dibaca dan dimasukkan per sesi.
3. Proyek tanpa berkas JSON memakai baris legacy terbaru sebagai cadangan
   (`session_key = 'legacy-project'`).
4. Berkas lama dipindah ke `.state/legacy-json/<stempel>/` — **tidak dihapus**,
   supaya masih bisa dibandingkan.

Selain itu, saat sebuah sesi dimuat dan database belum punya barisnya, berkas
JSON sesi itu diadopsi sekali. Tanpa ini, task yang sedang berjalan akan hilang
saat pemutakhiran dipasang.

## Kapan penulisan ditolak

| Keadaan | Perilaku |
|---|---|
| direktori database tidak bisa dibuat | `STATE_UNAVAILABLE`, tulis ditolak |
| berkas database terkunci | `STATE_UNAVAILABLE` (dengan `busy_timeout` 5 detik dulu) |
| `state_json` rusak saat dibaca | `STATE_UNAVAILABLE`; isi asli tidak ditimpa |
| versi baris sudah berubah | `STATE_CONFLICT`; penulis basi tidak menang |
| Postgres/monitor mati | **tidak** menolak apa pun; masuk antrean |

Aturan yang dipegang sejak perbaikan 2 November 2026: **gagal membaca tidak pernah
berarti kosong.**

## Melihat keadaan penyimpanan

`get_workflow_status` menampilkan dua hal tambahan bila perlu:

- `Replika: tertunda N` — ada salinan yang belum terkirim ke Postgres.
- `⚠️ Dua proses menulis sesi yang sama` — dua proses berbeda menulis kunci yang
  sama dalam 60 detik terakhir.

Keduanya sengaja **tidak** ditaruh di dashboard: antrean tinggal di mesin klien,
dan justru saat mesin itu tidak bisa menjangkau server, angkanya tidak bisa
ditampilkan di sana.
