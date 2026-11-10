'use strict';

/**
 * Rekap durasi per proyek.
 *
 * MENGAPA ADA
 * -----------
 * Timer per sesi sudah lama terkumpul ("⏱ 45:26"), tetapi angkanya tidak
 * pernah dijumlahkan. Pemilik hanya tahu satu sesi memakan 45 menit, bukan
 * proyek mana yang menghabiskan waktunya minggu ini.
 *
 * MENGAPA HANYA SESI YANG SUDAH DITUTUP
 * -------------------------------------
 * Durasi sesi yang masih berjalan bertambah setiap detik. Memasukkannya ke
 * rekap membuat angka berubah tiap kali layar disegarkan, dan tidak bisa
 * dibandingkan antar hari. Rekap adalah catatan yang sudah selesai; sesi hidup
 * punya tempatnya sendiri di kartu.
 *
 * MENGAPA "(tanpa proyek)" DIPISAH, BUKAN DITEBAK
 * ----------------------------------------------
 * Sesi lama tidak punya `project_name` karena bug yang baru diperbaiki. Menebak
 * dari jalur, judul sesi, atau nama task berarti mengarang data. Yang jujur:
 * kumpulkan sebagai "(tanpa proyek)" supaya terlihat jelas bahwa catatannya
 * tidak lengkap - bukan menyembunyikannya di dalam proyek lain.
 *
 * Berkas ini tidak menyentuh jaringan maupun basis data, hanya menyusun SQL.
 */

const DEFAULT_SUMMARY_DAYS = 7;
const DEFAULT_SUMMARY_LIMIT = 20;
const MAKS_LIMIT = 50;

const { worthReportingPredicate } = require('./empty-session.cjs');

function buildProjectSummaryQuery({ days = DEFAULT_SUMMARY_DAYS, limit = DEFAULT_SUMMARY_LIMIT } = {}) {
  const hari = Number(days) > 0 ? Number(days) : DEFAULT_SUMMARY_DAYS;
  const batas = Number(limit) > 0 ? Math.min(MAKS_LIMIT, Number(limit)) : DEFAULT_SUMMARY_LIMIT;

  return {
    sql: `SELECT project_name AS project,
                 count(*) AS sessions,
                 count(*) FILTER (WHERE updated_at > now() - interval '15 minutes') AS recent,
                 SUM(EXTRACT(EPOCH FROM (updated_at - started_at)))::int AS total_seconds,
                 max(updated_at) AS last_at
            FROM sessions
           WHERE machine <> ''
             AND started_at IS NOT NULL
             AND phase IN ('idle', 'closed', 'done', 'cancelled')
             AND updated_at > now() - ($1::text || ' days')::interval
             AND ${worthReportingPredicate()}
           GROUP BY 1
           ORDER BY total_seconds DESC NULLS LAST
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
  buildProjectSummaryQuery,
  formatDuration,
  DEFAULT_SUMMARY_DAYS,
  DEFAULT_SUMMARY_LIMIT,
};