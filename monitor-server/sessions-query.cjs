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
 * DUA BATAS UMUR, BUKAN SATU
 * --------------------------
 * Sesi `idle` TANPA task tidak memberi informasi apa pun - kartunya hanya
 * berbunyi "IDLE (tanpa task)" - jadi dibuang jauh lebih cepat (5 menit).
 * Sesi `idle` yang PUNYA task menyimpan riwayat pekerjaan yang baru selesai,
 * jadi dipertahankan lebih lama (30 menit) agar masih terbaca sesudah commit.
 *
 * Sesi yang masih bekerja TIDAK pernah disembunyikan, seberapa lama pun ia
 * berjalan tanpa menyimpan state - satu tugas panjang tetap pekerjaan nyata.
 */
const DEFAULT_IDLE_TTL = '30 minutes';
const DEFAULT_EMPTY_IDLE_TTL = '5 minutes';

function buildSessionsQuery({
  limit = 20,
  idleTtl = DEFAULT_IDLE_TTL,
  emptyIdleTtl = DEFAULT_EMPTY_IDLE_TTL,
} = {}) {
  return {
    sql: `SELECT session_key, machine, project_path, project_name, task, task_type, phase,
                 plan_json, plan_done, plan_total, dod_done, dod_total, dod_waived,
                 started_at, session_title, agent_tool, updated_at
            FROM sessions
           WHERE NOT (
                   phase = 'idle'
                   AND (
                     (task = '' AND updated_at < now() - $3::interval)
                     OR updated_at < now() - $2::interval
                   )
                 )
           ORDER BY updated_at DESC
           LIMIT $1`,
    params: [
      limit,
      idleTtl || DEFAULT_IDLE_TTL,
      emptyIdleTtl || DEFAULT_EMPTY_IDLE_TTL,
    ],
  };
}

module.exports = { buildSessionsQuery, DEFAULT_IDLE_TTL, DEFAULT_EMPTY_IDLE_TTL };
