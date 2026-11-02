/**
 * Replika state ke database pusat, tanpa pernah berada di jalur kritis.
 *
 * MENGAPA ANTREAN, BUKAN KIRIM LANGSUNG
 * -------------------------------------
 * `save()` adalah jalur terpanas di seluruh sistem: ia jalan setiap langkah
 * workflow. Kalau pengiriman salinan ke Postgres ikut ditunggu tanpa penanganan,
 * Postgres atau Tailscale yang mati berarti `start_task` dan `commit_and_push`
 * ikut mati - padahal keduanya tidak butuh jaringan untuk benar.
 *
 * Antrean membalik arahnya: penyimpanan selalu berhasil, pengiriman menyusul
 * kapan pun jaringannya ada. Yang tertinggal terlihat sebagai angka, bukan
 * hilang diam-diam.
 */

import { safeLog } from "../security/sanitizer.js";

/**
 * Jeda sebelum mencoba lagi, dalam detik.
 *
 * Menaik cepat lalu berhenti di 5 menit: gangguan jaringan singkat pulih dalam
 * hitungan detik, sedangkan server yang benar-benar mati tidak perlu ditempeli
 * percobaan setiap detik.
 */
export function backoffSeconds(attempts) {
  const n = Number.isFinite(attempts) && attempts > 0 ? Math.trunc(attempts) : 1;
  if (n > 7) return 300;
  return 2 ** (n - 1);
}

/**
 * Klaim baris selama pengiriman.
 *
 * Harus lebih panjang daripada batas waktu satu pengiriman, dan cukup pendek
 * supaya proses yang mati di tengah jalan tidak menahan baris selamanya.
 */
const CLAIM_SECONDS = 300;

/** Menitipkan satu perubahan ke antrean. Kunci yang sama menimpa isinya, bukan menumpuk. */
export async function enqueue(adapter, kind, dedupeKey, payload) {
  await adapter.connect();
  adapter.db
    .prepare(
      `INSERT INTO sync_queue (kind, dedupe_key, payload, attempts, created_at)
       VALUES (?, ?, ?, 0, datetime('now'))
       ON CONFLICT(kind, dedupe_key) DO UPDATE SET
         payload = excluded.payload`,
    )
    .run(kind, dedupeKey, typeof payload === "string" ? payload : JSON.stringify(payload));
}

function claimNext(adapter) {
  const row = adapter.db
    .prepare(
      `SELECT id, kind, dedupe_key, payload, attempts
         FROM sync_queue
        WHERE next_attempt_at IS NULL OR next_attempt_at <= datetime('now')
        ORDER BY id
        LIMIT 1`,
    )
    .get();

  if (!row) return null;

  // Klaim dengan syarat: hanya lanjut bila baris ini memang belum diklaim
  // proses lain. Tanpa `changes === 1`, dua penguras bisa mengirim dua kali isi
  // yang sama ke pabrik data, dan pembaca melihat riwayat ganda.
  const claimed = adapter.db
    .prepare(
      `UPDATE sync_queue
          SET next_attempt_at = datetime('now', '+${CLAIM_SECONDS} seconds')
        WHERE id = ? AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))`,
    )
    .run(row.id);

  return claimed.changes === 1 ? row : null;
}

/**
 * Mengirim isi antrean ke replika, sebentar saja.
 *
 * Tidak pernah melempar: hasilnya laporan. Pemanggil boleh mengabaikannya, dan
 * itu memang yang terjadi di `save()`.
 */
export async function drainSync({ replica, limit = 20, budgetMs = 1200, adapter = null } = {}) {
  const ada = adapter ?? (await (await import("./index.js")).getAdapter());
  await ada.connect();

  const result = { sent: 0, failed: 0, remaining: 0, skipped: false };

  if (!replica || typeof replica.push !== "function") {
    result.remaining = countPending(ada);
    result.skipped = true;
    return result;
  }

  const startedAt = Date.now();

  while (result.sent + result.failed < limit) {
    // Anggaran waktu diperiksa SEBELUM klaim, supaya berhenti karena waktu tidak
    // meninggalkan baris yang sudah diklaim tetapi tidak pernah dikirim.
    if (Date.now() - startedAt > budgetMs) break;

    const row = claimNext(ada);
    if (!row) break;

    try {
      await replica.push(row);
      ada.db.prepare("DELETE FROM sync_queue WHERE id = ?").run(row.id);
      result.sent += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      ada.db
        .prepare(
          `UPDATE sync_queue
              SET attempts = ?,
                  last_error = ?,
                  next_attempt_at = datetime('now', '+' || ? || ' seconds')
            WHERE id = ?`,
        )
        .run(attempts, String(error?.message || error).slice(0, 500), backoffSeconds(attempts), row.id);
      result.failed += 1;
    }
  }

  result.remaining = countPending(ada);
  return result;
}

function countPending(adapter) {
  return adapter.db.prepare("SELECT count(*) AS c FROM sync_queue").get().c;
}

/**
 * Berapa banyak yang belum terkirim, dan sudah berapa lama yang paling tua
 * menunggu.
 *
 * Umur dipakai, bukan hanya jumlah: antrean berisi satu baris berumur tiga hari
 * menandakan masalah yang berbeda dari tiga puluh baris berumur dua detik.
 */
export async function queueDepth(adapter = null) {
  const ada = adapter ?? (await (await import("./index.js")).getAdapter());
  await ada.connect();

  const row = ada.db
    .prepare(
      `SELECT count(*) AS pending,
              CAST(COALESCE((julianday('now') - julianday(min(created_at))) * 86400000, 0) AS INTEGER) AS age
         FROM sync_queue`,
    )
    .get();

  return { pending: row?.pending ?? 0, oldestAgeMs: Math.max(0, row?.age ?? 0) };
}

/** Baris yang gagal berkali-kali, untuk dilaporkan. Tidak pernah dihapus sendiri. */
export async function stuckRows(adapter = null, threshold = 20) {
  const ada = adapter ?? (await (await import("./index.js")).getAdapter());
  await ada.connect();
  return ada.db
    .prepare(
      `SELECT id, kind, dedupe_key, attempts, last_error
         FROM sync_queue WHERE attempts >= ? ORDER BY attempts DESC LIMIT 10`,
    )
    .all(threshold);
}

export function reportQueueProblems(depth, stuck) {
  if (depth?.pending > 0) {
    safeLog("warn", `Replika tertunda ${depth.pending} baris (tertua ${Math.round((depth.oldestAgeMs || 0) / 1000)} detik).`);
  }
  for (const row of stuck || []) {
    safeLog("warn", `Replika gagal ${row.attempts}x untuk "${row.dedupe_key}": ${row.last_error || "(tanpa pesan)"}`);
  }
}