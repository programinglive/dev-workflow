'use strict';

const { normalizeTaskMetadata } = require('./task-metadata.cjs');

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
 * Refinement history as a jsonb parameter.
 *
 * Dropped, not truncated, when it is oversized: half a JSON document is not a
 * smaller document, it is a parse error waiting for the next reader. The
 * publisher already bounds the list, so reaching this limit means a caller sent
 * something it should not have.
 */
function refinementParam(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const serialized = JSON.stringify(value);
  return serialized.length <= 64000 ? serialized : null;
}

/**
 * Fase kartu yang sudah diserahkan ke kartu berikutnya dalam sesi yang sama.
 *
 * Bukan `closed`: sesinya masih hidup. Tetapi kartu ini tidak lagi menjadi
 * pekerjaan aktif, jadi ia harus hilang dari tab Aktif dan hanya muncul di
 * Riwayat - dengan tautan ke kartu penerusnya.
 */
const HANDOFF_PHASE = 'handed-off';

/**
 * Kartu sebelumnya, dari kiriman snapshot. Dua bentuk parent hidup berdampingan:
 * model chain v1.24.1 mengirim {taskId, title, startedAt}, sedangkan
 * assignWorkflowIdentity (main) mengirim {id, description, title, todoId}.
 * Keduanya dinormalisasi jadi satu record, sehingga klien lama maupun klien
 * baru tetap bisa mencatat tautan rantainya.
 */
function parentOf(b) {
  const p = b && b.parentTask && typeof b.parentTask === 'object' ? b.parentTask : null;
  const id = p ? str(p.taskId || p.id, 200) : '';
  if (!id) return null;
  return { taskId: id, title: str(p.title || p.description, 500) };
}

/**
 * @param {object} body  kiriman dari pelapor
 * @returns {{ sql: string, params: Array }}
 */
/**
 * Keeps the reported toolchain small and predictable.
 *
 * Only string versions are kept, at most 20 tools, each value truncated. A
 * malformed report degrades the parity view instead of breaking the session
 * write, which is the same rule the release version follows.
 */
function boundedToolchain(toolchain) {
  if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)) return {};
  const out = {};
  let count = 0;
  for (const [name, version] of Object.entries(toolchain)) {
    if (count >= 20) break;
    const key = str(name, 40);
    if (!key) continue;
    out[key] = version === null || version === undefined ? null : str(version, 40);
    count += 1;
  }
  return out;
}

function buildSessionUpsert(body = {}) {
  const b = body || {};
  const key = str(b.cardKey || b.sessionKey, 200);
  if (!key) throw new Error('sessionKey wajib');

  const plan = Array.isArray(b.plan) ? b.plan.slice(0, 40) : [];
  const metadata = normalizeTaskMetadata(b);
  const parent = parentOf(b);
  // A sparse completion is still the same task. A nonempty changed identity or
  // title starts a new task and must not inherit unrelated service links.
  const newTask = `(
    (EXCLUDED.workflow_task_id <> '' AND EXCLUDED.workflow_task_id <> COALESCE(sessions.workflow_task_id, ''))
    OR (EXCLUDED.task <> '' AND EXCLUDED.task <> COALESCE(sessions.task, '')
      AND (COALESCE(sessions.task, '') <> '' OR EXCLUDED.workflow_task_id = ''))
  )`;

  return {
    sql: `INSERT INTO sessions (session_key, machine, project_path, project_name, task, task_type, phase,
                               plan_json, plan_done, plan_total, dod_done, dod_total, dod_waived,
                               owner_pid, started_at, session_title, agent_tool,
                               workflow_task_id, task_origin_json, task_relations_json,
                               repo_path, repo_remote,
                               release_version, release_revision, toolchain_json,
                               task_id, parent_task_id, parent_task_title,
                               refinement_json, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21,$22,$23,$24,$25::jsonb,$26,$27,$28,$29::jsonb,now())
         ON CONFLICT (session_key, task_id) DO UPDATE SET
           machine=EXCLUDED.machine,
           -- Identitas tidak boleh dihapus oleh kiriman kosong. Ini bug yang
           -- membuat nama proyek hilang tepat saat task ditutup.
           project_path=COALESCE(NULLIF(EXCLUDED.project_path, ''), sessions.project_path),
           project_name=COALESCE(NULLIF(EXCLUDED.project_name, ''), sessions.project_name),
           -- Repository juga identitas: laporan ringkas saat task ditutup tidak
           -- boleh menghapus lokasi proyek yang sudah tercatat.
           repo_path=COALESCE(NULLIF(EXCLUDED.repo_path, ''), sessions.repo_path),
           repo_remote=COALESCE(NULLIF(EXCLUDED.repo_remote, ''), sessions.repo_remote),
            -- Task description juga identitas kartu: saat complete_task dipanggil,
           -- state lokal di-reset menjadi kosong, tetapi kartu di monitor dan
           -- riwayat harus tetap menampilkan nama task yang baru selesai, bukan
           -- berubah menjadi "(tanpa task)" atau hanya judul chat.
           task=COALESCE(NULLIF(EXCLUDED.task, ''), sessions.task), task_type=COALESCE(NULLIF(EXCLUDED.task_type, ''), sessions.task_type), phase=EXCLUDED.phase,
           workflow_task_id=CASE WHEN ${newTask} THEN EXCLUDED.workflow_task_id
             ELSE COALESCE(NULLIF(EXCLUDED.workflow_task_id, ''), sessions.workflow_task_id) END,
           task_origin_json=CASE
             WHEN COALESCE(EXCLUDED.task_origin_json->>'system', 'unknown') <> 'unknown' THEN EXCLUDED.task_origin_json
             WHEN ${newTask} THEN EXCLUDED.task_origin_json
             ELSE sessions.task_origin_json END,
           task_relations_json=CASE
             WHEN EXCLUDED.task_relations_json <> '[]'::jsonb THEN EXCLUDED.task_relations_json
             WHEN ${newTask} THEN '[]'::jsonb
             ELSE sessions.task_relations_json END,
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
           -- Rantai kartu tidak boleh hilang oleh kiriman kosong, sama
           -- seperti identitas proyek di atas: nilai lama menang, nilai baru mengisi.
           parent_task_id=COALESCE(EXCLUDED.parent_task_id, sessions.parent_task_id),
           parent_task_title=COALESCE(NULLIF(EXCLUDED.parent_task_title, ''), sessions.parent_task_title),
           -- Same rule as project_name: a reporter that does not know the
           -- release must not erase what an earlier report proved.
           release_version=COALESCE(NULLIF(EXCLUDED.release_version, ''), sessions.release_version),
           -- Tool versions are identity too: a sparse report must not erase the
           -- last known toolchain, or the parity view would flicker to empty.
           toolchain_json=CASE
             WHEN EXCLUDED.toolchain_json <> '{}'::jsonb THEN EXCLUDED.toolchain_json
             ELSE COALESCE(sessions.toolchain_json, '{}'::jsonb) END,
           release_revision=COALESCE(NULLIF(EXCLUDED.release_revision, ''), sessions.release_revision),
           -- Refinement history is append-only in the publisher, so the newest
           -- payload always wins. A report that carries none (every tool except
           -- refine_with_ai) must not erase what is already there.
           refinement_json=COALESCE(EXCLUDED.refinement_json, sessions.refinement_json),
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
      metadata.workflowTaskId,
      JSON.stringify(metadata.taskOrigin),
      JSON.stringify(metadata.taskRelations),
      str(b.repositoryPath, 512),
      str(b.repositoryRemote, 512),
      // Bounded rather than rejected: a malformed publisher should degrade the
      // version display, not break the whole session report.
      str(b.releaseVersion, 40),
      str(b.releaseRevision, 40),
      JSON.stringify(boundedToolchain(b.toolchain)),
      str(b.taskId, 200),
      parent ? parent.taskId : null,
      parent ? parent.title : null,
      refinementParam(b.refinement),
    ],
  };
}

/**
 * Tandai kartu sebelumnya sebagai sudah diserahkan.
 *
 * Tanpa ini, kartu lama tetap terlihat "berjalan" selamanya karena hanya
 * `idle` yang punya batas umur di query aktif. `handed-off` menyatakan hal
 * yang sebenarnya: sesinya masih hidup, tetapi topik itu sudah pindah ke
 * kartu berikutnya.
 *
 * @returns {{sql: string, params: Array}|null}
 */
function buildParentHandoff(body = {}) {
  const b = body || {};
  const key = str(b.cardKey || b.sessionKey, 200);
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
