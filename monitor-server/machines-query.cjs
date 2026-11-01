'use strict';

/**
 * Daftar MESIN, terpisah dari daftar sesi.
 *
 * MASALAH YANG DITUTUP
 * --------------------
 * Sebelumnya layar hanya menampilkan SESI yang punya task. Sesi `idle` yang
 * tidak punya task disembunyikan setelah 5 menit, jadi mesin yang sedang tidak
 * dipakai HILANG dari layar sama sekali. Diukur 2 November 2026: pemilik
 * bertanya "saya ngga lihat task dari MMCH dan Mac" - padahal kedua mesin itu
 * sehat, hanya belum dipakai.
 *
 * Yang dibutuhkan adalah dua hal berbeda, dan keduanya harus ada:
 *   1. SESI  - apa yang sedang dikerjakan sekarang
 *   2. MESIN - siapa saja yang terhubung, kapan terakhir melapor
 *
 * Tanpa (2), "tidak ada pekerjaan" dan "mesin tidak pernah terhubung" tampak
 * sama: dua-duanya tidak menampilkan apa pun.
 *
 * Berkas ini tidak menyentuh jaringan, hanya menyusun SQL.
 */

const DEFAULT_OFFLINE_AFTER_MINUTES = 30;

/**
 * Satu baris per mesin: kapan terakhir melapor, dan apakah masih hidup.
 *
 * `online` dihitung dari umur laporan: mesin yang belum melapor lebih dari
 * batas dianggap offline, TETAPI tetap ditampilkan - justru itu gunanya.
 */
function buildMachinesQuery({ offlineAfterMinutes = DEFAULT_OFFLINE_AFTER_MINUTES } = {}) {
  const menit = Number(offlineAfterMinutes) > 0
    ? Number(offlineAfterMinutes)
    : DEFAULT_OFFLINE_AFTER_MINUTES;
  return {
    sql: `SELECT machine,
                 max(updated_at) AS last_seen,
                 count(*) AS sessions,
                 max(now() - updated_at) AS age,
                 (now() - max(updated_at) <= ($1::text || ' minutes')::interval) AS online,
                 (array_agg(phase ORDER BY updated_at DESC))[1] AS last_phase,
                 (array_agg(NULLIF(task, '') ORDER BY updated_at DESC))[1] AS last_task,
                 (array_agg(NULLIF(project_name, '') ORDER BY updated_at DESC))[1] AS last_project,
                 (array_agg(NULLIF(session_title, '') ORDER BY updated_at DESC))[1] AS last_title
            FROM sessions
           WHERE machine <> ''
           GROUP BY machine
           ORDER BY max(updated_at) DESC`,
    params: [String(menit)],
  };
}

module.exports = { buildMachinesQuery, DEFAULT_OFFLINE_AFTER_MINUTES };
