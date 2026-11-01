'use strict';

/**
 * Query daftar sesi untuk dashboard.
 *
 * Dipisah dari dashboard.cjs supaya bisa diuji tanpa Postgres: berkas ini
 * tidak menyentuh jaringan sama sekali, hanya menyusun SQL dan parameternya.
 *
 * MENGAPA ADA FILTER
 * ------------------
 * Proses MCP mati bersama sesi OpenCode-nya, jadi sesi yang dulu `idle` akan
 * tinggal sebagai baris mati selamanya. Tanpa filter, monitor yang dipakai
 * berhari-hari memenuhi layar tablet dengan sesi yang sudah tidak ada.
 *
 * Sesi yang masih bekerja TIDAK pernah disembunyikan, seberapa lama pun ia
 * berjalan tanpa menyimpan state - hanya `idle` yang punya batas umur.
 */
const DEFAULT_IDLE_TTL = '30 minutes';

function buildSessionsQuery({ limit = 20, idleTtl = DEFAULT_IDLE_TTL } = {}) {
  return {
    sql: `SELECT session_key, machine, project_path, project_name, task, task_type, phase,
                 plan_json, plan_done, plan_total, dod_done, dod_total, dod_waived, updated_at
            FROM sessions
           WHERE NOT (phase = 'idle' AND updated_at < now() - $2::interval)
           ORDER BY updated_at DESC
           LIMIT $1`,
    params: [limit, idleTtl || DEFAULT_IDLE_TTL],
  };
}

module.exports = { buildSessionsQuery, DEFAULT_IDLE_TTL };
