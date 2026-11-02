'use strict';

/**
 * Daftar MESIN, terpisah dari daftar sesi.
 *
 * MASALAH YANG DITUTUP
 * --------------------
 * Dua kali, dan yang kedua adalah kesalahan saya sendiri:
 *
 * 1. Layar hanya menampilkan SESI yang punya task, jadi mesin yang menganggur
 *    hilang sama sekali. Ditutup dengan daftar mesin.
 *
 * 2. Lalu daftar itu memakai ambang 30 MENIT dan label online/offline. Mesin
 *    hanya melapor saat ada tool dev-workflow dipanggil, jadi mesin yang nyala
 *    tetapi tidak sedang dipakai tampil sebagai "offline" - sebuah kebohongan
 *    yang persis sama bentuknya dengan yang sudah diperbaiki di dashboard
 *    ("mati" tampak sama dengan "tidak ada pekerjaan").
 *
 * Karena itu sekarang:
 *   - labelnya "terakhir melapor X lalu", bukan online/offline
 *   - tanda perlu-waspada hanya setelah 3 HARI, bukan 30 menit
 *
 * Berkas ini tidak menyentuh jaringan, hanya menyusun SQL.
 */

const DEFAULT_STALE_AFTER_DAYS = 3;

/**
 * Satu baris per mesin: kapan terakhir melapor, dan apakah sudah lama sekali.
 *
 * `stale` HANYA berarti "sudah lama tidak melapor" - bukan "mesin mati".
 * Mesin yang tidak dipakai memang tidak melapor, dan itu normal.
 */
function buildMachinesQuery({ staleAfterDays = DEFAULT_STALE_AFTER_DAYS } = {}) {
  const hari = Number(staleAfterDays) > 0 ? Number(staleAfterDays) : DEFAULT_STALE_AFTER_DAYS;
  return {
    sql: `SELECT machine,
                 max(updated_at) AS last_seen,
                 count(*) AS sessions,
                 (now() - max(updated_at)) AS age,
                 (now() - max(updated_at) > ($1::text || ' days')::interval) AS stale,
                 (array_agg(phase ORDER BY updated_at DESC))[1] AS last_phase,
                 (array_agg(NULLIF(task, '') ORDER BY updated_at DESC))[1] AS last_task,
                 (array_agg(NULLIF(project_name, '') ORDER BY updated_at DESC))[1] AS last_project,
                 (array_agg(NULLIF(session_title, '') ORDER BY updated_at DESC))[1] AS last_title
            FROM sessions
           WHERE machine <> ''
           GROUP BY machine
           ORDER BY max(updated_at) DESC`,
    params: [String(hari)],
  };
}

module.exports = { buildMachinesQuery, DEFAULT_STALE_AFTER_DAYS };
