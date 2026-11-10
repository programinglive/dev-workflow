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

// This one report came from a retired monitor test device. Keep the stored
// session for history while allowing a newer report from that name to appear.
const RETIRED_TEST_REPORT = {
  machine: 'uji',
  lastSeen: Date.parse('2026-11-03T10:10:45.095Z'),
};

/**
 * Milliseconds for a timestamp in any shape the driver can hand over.
 *
 * The Postgres driver returns `timestamptz` as a `Date`. `Date.parse()` would
 * stringify it first and DROP the milliseconds, so an equality check against a
 * precise stored timestamp silently fails and the retired row stays visible.
 */
function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function visibleMachines(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    !(row.machine === RETIRED_TEST_REPORT.machine &&
      toMs(row.last_seen) === RETIRED_TEST_REPORT.lastSeen));
}

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
                 (array_agg(NULLIF(session_title, '') ORDER BY updated_at DESC))[1] AS last_title,
                 -- Parity inputs come from the NEWEST row of each machine, for
                 -- the same reason the phase and project do: an old session must
                 -- not decide what the machine runs today. NULLIF keeps a blank
                 -- historical report from outranking a real one.
                 (array_agg(NULLIF(release_version, '') ORDER BY updated_at DESC))[1] AS release_version,
                 (array_agg(NULLIF(release_revision, '') ORDER BY updated_at DESC))[1] AS release_revision,
                 (array_agg(toolchain_json ORDER BY updated_at DESC))[1] AS toolchain_json
            FROM sessions
           WHERE machine <> ''
           GROUP BY machine
           ORDER BY max(updated_at) DESC`,
    params: [String(hari)],
  };
}

module.exports = { buildMachinesQuery, DEFAULT_STALE_AFTER_DAYS, visibleMachines };
