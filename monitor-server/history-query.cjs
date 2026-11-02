'use strict';

/**
 * Riwayat sesi yang sudah selesai, beserta durasi akhirnya.
 *
 * MASALAH YANG DITUTUP
 * --------------------
 * Pemilik meminta counter waktu "biar tau berapa lama task itu selesai".
 * Tetapi sesi `idle` disembunyikan setelah beberapa menit, sehingga angka yang
 * paling berguna - durasi akhir sebuah task - HILANG justru saat task selesai.
 * Tidak ada cara menjawab "berapa lama task tadi mengerjakan X".
 *
 * Yang dikerjakan berkas ini hanya MEMILIH dan MENGHITUNG; tidak ada data yang
 * dihapus atau diubah. Sesi yang sudah selesai tetap ada di database.
 *
 * ATURAN
 * ------
 * 1. Hanya `idle` yang punya task - sesi tanpa task tidak menarik untuk dilihat.
 * 2. Batasnya `HISTORY_DAYS` (bawaan 7 hari).
 * 3. Durasi = updated_at - started_at. Bila started_at tidak ada, durasinya
 *    TIDAK dikarang: dibiarkan null dan ditandai "tidak tercatat".
 */

const DEFAULT_HISTORY_DAYS = 7;
const DEFAULT_HISTORY_LIMIT = 12;

/**
 * Query riwayat. Waktu acuan memakai `now()` database, bukan jam aplikasi.
 *
 * MENGAPA TIDAK MENYARING `task <> ''`
 * ------------------------------------
 * Saat task ditutup, pelapor mengosongkan `task` (itu memang bentuk penutupan).
 * Diukur 2 November 2026: filter `task <> ''` membuat riwayat SELALU kosong,
 * karena tidak ada satu pun baris idle yang masih menyimpan task.
 *
 * Yang tersisa setelah penutupan justru yang paling berguna untuk dikenali:
 * `session_title` (judul percakapan) dan `project_name`. Jadi baris dianggap
 * menarik bila salah satunya ada.
 */
function buildHistoryQuery({
  historyDays = DEFAULT_HISTORY_DAYS,
  limit = DEFAULT_HISTORY_LIMIT,
} = {}) {
  const hari = Number(historyDays) > 0 ? Number(historyDays) : DEFAULT_HISTORY_DAYS;
  const batas = Number(limit) > 0 ? Math.min(50, Number(limit)) : DEFAULT_HISTORY_LIMIT;
  return {
    sql: `SELECT session_key, machine, project_name, task, task_type, session_title, agent_tool,
                 started_at, updated_at,
                 CASE WHEN started_at IS NULL THEN NULL
                      ELSE EXTRACT(EPOCH FROM (updated_at - started_at))::int
                 END AS duration_seconds,
                 plan_done, plan_total, dod_done, dod_total
            FROM sessions
           WHERE phase = 'idle'
             AND started_at IS NOT NULL
             AND updated_at > now() - ($1::text || ' days')::interval
           ORDER BY updated_at DESC
           LIMIT $2`,
    params: [String(hari), batas],
  };
}

/** Ubah detik menjadi "1j 04m" / "12m 05d" / "45d" untuk ditampilkan. */
function formatDuration(detik) {
  if (detik === null || detik === undefined || !Number.isFinite(Number(detik))) return null;
  const d = Math.max(0, Math.floor(Number(detik)));
  const jam = Math.floor(d / 3600);
  const menit = Math.floor((d % 3600) / 60);
  const sisa = d % 60;
  const dua = (n) => String(n).padStart(2, '0');
  if (jam > 0) return `${jam}j ${dua(menit)}m`;
  if (menit > 0) return `${menit}m ${dua(sisa)}d`;
  return `${sisa}d`;
}

module.exports = {
  buildHistoryQuery,
  formatDuration,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_HISTORY_LIMIT,
};