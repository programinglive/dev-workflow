'use strict';

/**
 * Riwayat sesi, beserta durasi akhir dan statusnya.
 *
 * MENGAPA SEMUA SESI, BUKAN HANYA YANG SELESAI
 * --------------------------------------------
 * Tab riwayat punya filter status. Kalau isinya hanya baris `idle`, filter
 * "berjalan" dan "macet" akan selalu kosong dan tombol itu jadi hiasan.
 * Karena itu yang diambil adalah semua sesi dalam batas hari, dan statusnya
 * diturunkan dari umur laporan dengan aturan yang SAMA seperti kartu aktif -
 * bukan aturan kedua yang bisa berbeda.
 *
 * MENGAPA TIDAK MENYARING `task <> ''`
 * ------------------------------------
 * Saat task ditutup, pelapor mengosongkan `task`. Filter seperti itu membuat
 * riwayat selalu kosong; sudah pernah terjadi 2 November 2026.
 *
 * MENGAPA TIDAK MENYARING `started_at IS NOT NULL`
 * ------------------------------------------------
 * Kesalahan saya sendiri, 2 November 2026. Sesi lama tidak punya `started_at`,
 * dan menyaring dengan syarat itu membuang 3 dari 9 sesi dari riwayat. Sesi
 * yang sama terlihat di tab Aktif lalu tidak ditemukan saat dicari di Riwayat -
 * persis kebohongan yang sedang saya perbaiki di tempat lain. `started_at`
 * hanya dipakai MENGHITUNG durasi; kalau kosong, durasinya "tidak tercatat".
 *
 * Berkas ini tidak menyentuh jaringan, hanya menyusun SQL.
 */

const DEFAULT_HISTORY_DAYS = 7;
const DEFAULT_HISTORY_LIMIT = 60;

function buildHistoryQuery({
  historyDays = DEFAULT_HISTORY_DAYS,
  limit = DEFAULT_HISTORY_LIMIT,
} = {}) {
  const hari = Number(historyDays) > 0 ? Number(historyDays) : DEFAULT_HISTORY_DAYS;
  const batas = Number(limit) > 0 ? Math.min(200, Number(limit)) : DEFAULT_HISTORY_LIMIT;
  return {
    sql: `SELECT session_key, task_id, parent_task_id, parent_task_title,
                 machine, project_name, task, task_type, session_title, agent_tool,
                 phase, started_at, updated_at,
                 CASE WHEN started_at IS NULL THEN NULL
                      ELSE EXTRACT(EPOCH FROM (updated_at - started_at))::int
                 END AS duration_seconds,
                 plan_done, plan_total, dod_done, dod_total
            FROM sessions
           WHERE machine <> ''
             AND updated_at > now() - ($1::text || ' days')::interval
           ORDER BY updated_at DESC
           LIMIT $2`,
    params: [String(hari), batas],
  };
}

/** Ubah detik menjadi "1j 04m" / "12m 05d" / "45d". */
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
