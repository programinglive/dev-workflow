'use strict';

/**
 * SQL untuk menyimpan satu sesi.
 *
 * MASALAH YANG DITUTUP (2 November 2026)
 * --------------------------------------
 * 5 dari 9 sesi tidak punya `project_name`, dan yang kehilangan justru sesi
 * yang SUDAH SELESAI. Sebabnya satu baris:
 *
 *     project_name=EXCLUDED.project_name
 *
 * Saat `complete_task`, pelapor tidak mengirim `projectPath`, jadi nama proyek
 * ditimpa string kosong tepat ketika pekerjaan itu selesai - yaitu saat
 * catatannya paling berguna. `session_title` sudah dijaga sejak awal; nama
 * proyek terlewat.
 *
 * Pola yang dipegang berkas ini:
 *
 *   - NILAI YANG MENJELASKAN IDENTITAS (`project_name`, `project_path`,
 *     `session_title`, `agent_tool`) TIDAK BOLEH terhapus oleh kiriman kosong.
 *     "Tidak dikirim" bukan berarti "hapus".
 *
 *   - NILAI YANG MEMANG BISA DIKOSONGKAN DENGAN SENGAJA (`task`) HARUS tetap
 *     bisa dikosongkan. `task=''` adalah sinyal sah bahwa task ditutup; kalau
 *     ikut dilindungi, riwayat akan selamanya menampilkan task yang sudah
 *     selesai seolah masih berjalan.
 *
 * Berkas ini tidak menyentuh jaringan maupun basis data, hanya menyusun SQL.
 */

function str(v, max) {
  const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  return s.slice(0, max);
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Nama tool yang disimpan: huruf kecil, atau 'unknown' bila tidak ada info.
 *
 * 'unknown' BUKAN nilai, melainkan ketiadaan informasi. Karena itu aturan
 * "jangan menimpa yang lama" dinyatakan di SQL (lihat CASE pada agent_tool),
 * bukan dengan mengosongkan nilai di sini - kalau dikosongkan sebelum SQL,
 * baris baru kehilangan penanda "belum tahu" dan tampil kosong di layar.
 */
function normalTool(v) {
  const s = str(v, 40).trim().toLowerCase();
  return s || 'unknown';
}

/**
 * Fase kartu yang sudah diserahkan ke kartu berikutnya dalam sesi yang sama.
 *
 * Bukan `closed`: sesinya masih hidup. Tetapi kartu ini tidak lagi menjadi
 * pekerjaan aktif, jadi ia harus hilang dari tab Aktif dan hanya muncul di
 * Riwayat - dengan tautan ke kartu penerusnya.
 */
const HANDOFF_PHASE = 'handed-off';

/** Kartu sebelumnya, dari kiriman snapshot. */
function parentOf(b) {
  const p = b && b.parentTask && typeof b.parentTask === 'object' ? b.parentTask : null;
  const id = p ? str(p.taskId, 200) : '';
  if (!id) return null;
  return { taskId: id, title: str(p.title, 500) };
}

/**
 * @param {object} body  kiriman dari pelapor
 * @returns {{ sql: string, params: Array }}
 */
function buildSessionUpsert(body = {}) {
  const b = body || {};
  const key = str(b.sessionKey, 200);
  if (!key) throw new Error('sessionKey wajib');

  const plan = Array.isArray(b.plan) ? b.plan.slice(0, 40) : [];
  const parent = parentOf(b);

  return {
    sql: `INSERT INTO sessions (session_key, machine, project_path, project_name, task, task_type, phase,
                               plan_json, plan_done, plan_total, dod_done, dod_total, dod_waived,
                               owner_pid, started_at, session_title, agent_tool,
                               task_id, parent_task_id, parent_task_title, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now())
         ON CONFLICT (session_key, task_id) DO UPDATE SET
           machine=EXCLUDED.machine,
           -- Identitas tidak boleh dihapus oleh kiriman kosong. Ini bug yang
           -- membuat nama proyek hilang tepat saat task ditutup.
           project_path=COALESCE(NULLIF(EXCLUDED.project_path, ''), sessions.project_path),
           project_name=COALESCE(NULLIF(EXCLUDED.project_name, ''), sessions.project_name),
           -- Kolom "task" SENGAJA tidak dilindungi: mengosongkannya adalah cara
           -- sah menutup task.
           task=EXCLUDED.task, task_type=EXCLUDED.task_type, phase=EXCLUDED.phase,
           plan_json=EXCLUDED.plan_json, plan_done=EXCLUDED.plan_done, plan_total=EXCLUDED.plan_total,
           dod_done=EXCLUDED.dod_done, dod_total=EXCLUDED.dod_total, dod_waived=EXCLUDED.dod_waived,
           owner_pid=EXCLUDED.owner_pid,
           -- Judul bisa datang belakangan (OpenCode menamainya setelah beberapa
           -- pesan), jadi kiriman kosong tidak boleh menghapus judul yang ada.
           session_title=COALESCE(NULLIF(EXCLUDED.session_title, ''), sessions.session_title),
           -- 'unknown' BUKAN informasi, jadi tidak boleh menimpa label yang
           -- sudah benar. Tetapi 'unknown' HARUS tetap tersimpan untuk baris
           -- yang memang belum pernah punya label sama sekali - kalau tidak,
           -- layar kehilangan kemampuan membedakan "belum tahu" dari "kosong".
           --
           -- Perbaikan pertama saya menaruh 'unknown' sebagai pilihan terakhir
           -- di COALESCE dan menganggapnya selesai. Itu salah: 'unknown' bukan
           -- string kosong, jadi ia lolos dari NULLIF(...,'') dan tetap
           -- MENIMPA 'codex'. Terbukti di produksi 2 November 2026.
           agent_tool=CASE
             WHEN NULLIF(EXCLUDED.agent_tool, '') IS NULL
               THEN COALESCE(NULLIF(sessions.agent_tool, ''), 'unknown')
             WHEN lower(EXCLUDED.agent_tool) = 'unknown'
               THEN COALESCE(NULLIF(sessions.agent_tool, ''), 'unknown')
             ELSE EXCLUDED.agent_tool
           END,
           -- Ambil waktu mulai yang PALING AWAL dan sah.
           --
           -- HATI-HATI: LEAST(NULL, x) menghasilkan NULL di PostgreSQL, bukan x.
           -- Versi pertama perbaikan ini memakai LEAST apa adanya dan justru
           -- MENGHAPUS started_at yang sudah tersimpan setiap kali pelapor
           -- mengirim nilai kosong. Karena itu tiap sisi dibungkus GREATEST,
           -- yang di PostgreSQL mengabaikan NULL.
           started_at=LEAST(
             GREATEST(sessions.started_at, EXCLUDED.started_at),
             GREATEST(EXCLUDED.started_at, sessions.started_at)
           ),
           -- Identitas rantai tidak boleh hilang oleh kiriman kosong, sama
           -- seperti identitas proyek di atas.
           parent_task_id=COALESCE(EXCLUDED.parent_task_id, sessions.parent_task_id),
           parent_task_title=COALESCE(NULLIF(EXCLUDED.parent_task_title, ''), sessions.parent_task_title),
           updated_at=now()`,
    params: [
      key,
      str(b.machine, 120),
      str(b.projectPath, 512),
      str(b.projectName, 160),
      str(b.task, 500),
      str(b.taskType, 40),
      str(b.phase, 40),
      JSON.stringify(plan),
      int(b.planDone),
      int(b.planTotal),
      int(b.dodDone),
      int(b.dodTotal),
      int(b.dodWaived),
      b.ownerPid ? int(b.ownerPid) : null,
      b.startedAt || null,
      str(b.sessionTitle, 200),
      normalTool(b.agentTool),
      str(b.taskId, 200),
      parent ? parent.taskId : null,
      parent ? parent.title : null,
    ],
  };
}

/**
 * Tandai kartu sebelumnya sebagai sudah diserahkan.
 *
 * Tanpa ini, kartu lama tetap terlihat "berjalan" selamanya karena hanya
 * `idle` yang punya batas umur di query aktif. `handed-off` menyatakan hal
 * yang sebenarnya: sesinya masih hidup, tetapi topik itu sudah pindah ke kartu
 * berikutnya.
 *
 * @returns {{sql: string, params: Array}|null}
 */
function buildParentHandoff(body = {}) {
  const b = body || {};
  const key = str(b.sessionKey, 200);
  const parent = parentOf(b);
  if (!key || !parent) return null;

  return {
    sql: `UPDATE sessions SET phase = '${HANDOFF_PHASE}', updated_at = now()
           WHERE session_key = $1 AND task_id = $2
             AND phase NOT IN ('closed', 'done', 'cancelled', '${HANDOFF_PHASE}')`,
    params: [key, parent.taskId],
  };
}

module.exports = { buildSessionUpsert, buildParentHandoff, HANDOFF_PHASE };
