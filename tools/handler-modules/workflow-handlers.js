import { classify } from '../../security/policy.js';
import { sanitize } from '../../security/sanitizer.js';
import { textResponse, isReleaseSatisfied, isErrorResponse, ensurePrdExists, loadDocGateInputs } from "./shared.js";
import { validateItemTexts } from "./dod.js";
import {
  validatePlanSteps,
  createPlan,
  normalizePlan,
  planProgress,
  renderPlanFull,
} from "./plan.js";
import {
  evaluateDocGate,
  isDocumentationPath,
  isGateSatisfied,
  normalizePath,
  pathKey,
  MIN_WAIVER_REASON,
  MAX_WAIVER_REASON,
} from "./docs.js";
import {
  acquireWorktreeMutex,
  releaseWorktreeMutex,
  useWorktreeCapability,
  writeKernelLockMetadata,
  findActiveLegacyWriter,
  isLegacyLock,
  verifyLegacyFleetQuiescence,
  projectLockDir,
  currentIsAlive,
  currentIsHolderProcess,
  DEFAULT_LOCK_STALE_MS,
} from "../../process-lock.js";
import { reportEventSafe, updateSessionTitle, buildSnapshot, reportSnapshot } from "../../monitor.js";
import { exec, resolveProjectDir, setActiveProjectDir } from "../../exec.js";
import {
  pinSessionProject,
  resolveHistoryFile,
  readSessionProject,
  readFocusBinding,
  claimFocusBinding,
  retireFocusBinding,
  resolveTargetProjectState,
  findActiveForeignTaskInProject,
  parseOwnerTimestamp,
  ProjectOwnershipLostError,
} from "../../workflow-state.js";
import {
  captureRepositoryIdentity,
  evaluateProjectSwitch,
  buildIdentityContract,
  parseRemoteIdentity,
  normalizeRepoPath,
} from "../../repository-identity.js";
import path from "node:path";
import { assignWorkflowIdentity, validateZettlyTaskArguments } from '../../zettly-workflow.js';
import { recommendMcpTools, formatMcpRecommendations, formatFullMcpCatalog } from "../../mcp-index.js";
import { normalizeBuildState, formatBuildStatusBlock } from "../../build-monitor.js";
import { claimReportBlock } from "../../claim-view.js";
import { fetchActiveSessions, monitorUrl } from "../../monitor.js";
import os from 'node:os';
import {flowGraph,syncZettlyDrawing} from '../../zettly-drawing.js';
import { handoffGuard } from "./checkpoint-handlers.js";

/**
 * Ask the monitor which tasks other sessions hold, and render the warning block.
 *
 * Never throws and never delays `start_task` much: a missing monitor or a slow
 * network simply produces no block, exactly like the other monitor reports.
 */
async function describeActiveClaims({ sessionKey = "" } = {}) {
  try {
    if (!monitorUrl()) return "";
    const result = await fetchActiveSessions({ limit: 50, timeoutMs: 1500 });
    if (!result.ok) return "";

    const claims = (result.sessions || []).map((session) => ({
      machine: session.machine,
      projectName: session.project_name,
      task: session.task || session.session_title,
      agent: session.agent_tool,
      sessionKey: session.session_key,
      phase: session.phase,
      updatedAt: session.updated_at,
      ownerPid: session.owner_pid,
    }));

    const block = claimReportBlock({ claims, ownSessionKey: sessionKey });
    return block ? `\n\n${block}` : "";
  } catch {
    return "";
  }
}

export function generateDefaultFlow(description, planItems = []) {
  const clean = (s, max = 36) => String(s || '').replace(/["\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const taskText = clean(description, 32) || 'Start Task';
  const nodes = [`A["Start: ${taskText}"]`];
  const items = (Array.isArray(planItems) && planItems.length > 0 ? planItems : ['Analyze & Plan', 'Implement Changes', 'Verify Evidence'])
    .slice(0, 4);
  items.forEach((item, idx) => {
    const letter = String.fromCharCode(66 + idx);
    const label = clean(typeof item === 'string' ? item : item?.text, 36);
    nodes.push(`${letter}["${label || `Step ${idx + 1}`}"]`);
  });
  const finalLetter = String.fromCharCode(66 + items.length);
  nodes.push(`${finalLetter}["Verify & Complete"]`);
  const arrows = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const from = nodes[i].split('[')[0].trim();
    const to = nodes[i + 1].split('[')[0].trim();
    arrows.push(`  ${from} --> ${to}`);
  }
  return `flowchart TD\n  ${nodes.join('\n  ')}\n${arrows.join('\n')}`;
}

/**
 * Catat repo proyek untuk sesi ini.
 *
 * Tanpa ini, satu-satunya penentu adalah WORKFLOW_PROJECT_DIR yang global.
 * Di mesin ini nilainya `D:\code\clinic`, jadi task yang sebenarnya bekerja di
 * repo lain tetap menjalankan git di clinic dan `commit_and_push` menjawab
 * "No changes detected" seolah sudah selesai (30 Oktober 2026).
 *
 * Best-effort: kalau repo belum bisa ditentukan, task tetap boleh mulai, tapi
 * pengguna diberi tahu supaya tidak terkejut saat commit.
 */
/**
 * Resolve and validate the project directory before touching workflow state.
 *
 * Owner rule (10 November 2026): a task without a project is not allowed. Every
 * task MUST belong to a real Git repository so the monitor never displays or
 * recaps "(tanpa proyek)".
 */
function resolveTaskProject(args) {
  const requested = typeof args.projectDir === "string" ? args.projectDir.trim() : "";

  let resolved = null;
  let error = null;
  try {
    resolved = resolveProjectDir({
      explicit: requested,
      env: process.env,
      candidates: [process.cwd(), process.env.INIT_CWD],
    });
  } catch (resolveError) {
    error = resolveError;
  }

  if (!resolved || !resolved.dir) {
    return {
      ok: false,
      dir: "",
      message:
        `⚠️ Dibatalkan: repo proyek belum ditentukan (${error ? error.message : "projectDir kosong"}).\n` +
        `   Task tanpa proyek tidak diizinkan oleh Dev Workflow MCP.\n` +
        `   Sebutkan 'projectDir' yang menunjuk ke repository Git (mis. "D:\\\\code\\\\clinic") pada 'start_task'.\n\n` +
        `Task BELUM dimulai; workflow sebelumnya tidak diubah.`,
    };
  }

  const sourceNote = {
    explicit: "dari argumen projectDir",
    cwd: "dari direktori kerja sesi",
    env: "dari WORKFLOW_PROJECT_DIR (nilai global)",
    pinned: "dari projectDir sesi",
  }[resolved.source] || resolved.source;

  let message = `📁 Repo proyek: ${resolved.dir} (${sourceNote})`;

  // Sumber env berarti tidak ada sinyal per-sesi sama sekali. Kalau direktori
  // sesi ternyata menunjuk repo LAIN, hampir pasti env ini milik proyek lain -
  // dan itulah yang dulu membuat `git add .` berjalan di repo yang salah.
  if (resolved.conflict) {
    message +=
      `\n   ⚠️ KONFLIK: direktori sesi menunjuk repo lain, ${resolved.conflict.cwdDir}.` +
      `\n   Repo dipilih dari WORKFLOW_PROJECT_DIR. Kalau task ini untuk repo sesi,` +
      `\n   ulangi 'start_task' dengan projectDir: "${resolved.conflict.cwdDir}".`;
  } else if (resolved.source === "env") {
    message +=
      `\n   ⚠️ Repo ini berasal dari WORKFLOW_PROJECT_DIR, bukan dari sesi.` +
      `\n   Kalau task ini bekerja di repo lain, ulangi 'start_task' dengan projectDir yang benar.`;
  }

  return { ok: true, dir: resolved.dir, message };
}

/**
 * Daftar berkas yang sudah kotor sebelum task dimulai.
 *
 * Kegagalan git di sini tidak boleh menggagalkan `start_task`: baseline hanya
 * dipakai untuk memperingatkan saat commit, dan task tanpa baseline tetap sah
 * (perilaku lama).
 */
async function captureDirtyAtStart(git) {
  if (!git || typeof git.getStatusOutput !== "function" ||
      typeof git.parseStatusEntries !== "function") {
    return [];
  }
  try {
    return git.parseStatusEntries(await git.getStatusOutput());
  } catch {
    return [];
  }
}

export async function handleStartTask(args, workflowState, git, zettlyOptions = {}) {
  if (workflowState && typeof workflowState.runSerialized === "function") {
    return await workflowState.runSerialized(() =>
      handleStartTaskSerialized(args, workflowState, git, zettlyOptions),
    );
  }
  return await handleStartTaskSerialized(args, workflowState, git, zettlyOptions);
}

async function handleStartTaskSerialized(args, workflowState, git, zettlyOptions = {}) {
  const env = zettlyOptions?.env || process.env;
  // `task` is a natural alias for `description`. Accepting it as an unknown key
  // silently created an empty task, which then had no Todo and no drawing, so
  // the monitor showed no flow. Normalise it, and refuse an empty description.
  if ((args.description === undefined || args.description === "") && typeof args.task === "string") {
    args = { ...args, description: args.task };
  }
  if (typeof args.description !== "string" || args.description.trim() === "") {
    return textResponse(
      "⚠️ 'description' is required. Pass the task description as 'description' (not 'task'). The task was not started."
    );
  }
  const zettlyArgumentError=validateZettlyTaskArguments(args);
  if(zettlyArgumentError)return textResponse(`⚠️ ${zettlyArgumentError} The existing task was not changed.`);
  // A task handed over to another machine must not be silently continued here:
  // the marker names the target, and acknowledgement is an explicit step.
  const handoff=handoffGuard(workflowState.state);
  if(handoff.handedOver){
    return textResponse(
      `⚠️ This task was handed over to ${handoff.to} by ${handoff.from}${handoff.at ? ` at ${handoff.at}` : ''}. ` +
      `Reason: ${handoff.reason}. The source machine must not keep working on it. ` +
      `If this machine should resume locally, call 'acknowledge_handover' first.`
    );
  }
  // Satu penulis per repo.
  //
  // 31 Oktober 2026 dua sesi OpenCode menulis satu working tree yang sama. Satu
  // sesi kehilangan seluruh suntingannya di `tools/handler-modules/index.js`
  // tanpa pesan apa pun: berkasnya kembali ke versi HEAD di tengah pekerjaan.
  // Penanda proses sudah ada sejak sebelumnya, tetapi hanya DICATAT sebagai
  // peringatan, jadi tidak ada yang menghentikan tabrakan.
  //
  // Validasi rencana. Skema mewajibkan `plan`; bila agen tidak mengirimnya,
  // rencana SEMENTARA diturunkan dari DoD supaya progres tetap bisa dibaca,
  // dan jawabannya menyebut terus terang bahwa urutannya belum benar.
  const planCheck = validatePlanSteps(args.plan);
  let planDerived = false;

  if (!planCheck.ok) {
    if (args.plan !== undefined) {
      return textResponse(
        `⚠️ ${planCheck.error}\n\n` +
          `Contoh pemakaian:\n` +
          `  plan: ["telusuri handler yang ada", "tulis tes yang gagal", "implementasi minimum"]\n\n` +
          `Task BELUM dimulai; workflow sebelumnya tidak diubah.`
      );
    }
    planDerived = true;
  }

  // Validasi DoD SEBELUM menyentuh state apa pun. Task yang ditolak tidak boleh
  // mengganti task yang sedang berjalan, dan tidak boleh meninggalkan state
  // setengah jadi yang membuat `get_workflow_status` membingungkan.
  const dodCheck = validateItemTexts(args.definitionOfDone);
  if (!dodCheck.ok) {
    return textResponse(
      `⚠️ ${dodCheck.error}\n\n` +
        `Contoh pemakaian:\n` +
        `  definitionOfDone: ["build lulus", "halaman login terverifikasi"]\n\n` +
        `Task BELUM dimulai; workflow sebelumnya tidak diubah.`
    );
  }

  // Validasi projectDir SEBELUM reset(): task tanpa proyek ditolak keras.
  const project = resolveTaskProject(args);
  if (!project.ok) {
    return textResponse(project.message);
  }

  // Resolusi identitas proyek target dan berkas state target SEBELUM validasi lock.
  // Ini mencegah tabrakan palsu saat dua klien MCP (mis. Antigravity dan Codex)
  // start di direktori kerja bersama (C:\Users\mahardhika) namun menargetkan
  // repositori proyek yang berbeda.
  const targetResolution = resolveTargetProjectState({
    stateFile: workflowState.stateFile,
    projectDir: project.dir,
  });
  const targetStateFile = targetResolution.stateFile;
  const targetLockDir = projectLockDir(targetStateFile);

  // Task HIDUP milik proses lain tidak boleh dihapus, bahkan dengan `force`.
  // findActiveForeignTaskInProject memeriksa disk state pada proyek target.
  const detectForeignTaskOnTarget = async () => {
    let foreignTask = findActiveForeignTaskInProject({
      projectDirPath: targetResolution.projectDirPath,
      targetStateFile,
      ownPid: process.pid,
      isAlive: currentIsAlive(),
      isHolderProcess: currentIsHolderProcess(),
      staleMs: DEFAULT_LOCK_STALE_MS,
    });

    if (!foreignTask && targetStateFile === workflowState.stateFile) {
      const disk = await workflowState.readDiskState();
      if (disk) {
        const phase = typeof disk.currentPhase === "string" ? disk.currentPhase : "idle";
        const description = typeof disk.taskDescription === "string" ? disk.taskDescription.trim() : "";
        const ownerPid = Number(disk.owner?.pid);
        const foreignOwner = Number.isFinite(ownerPid) && ownerPid !== process.pid;
        const ownerSeenAt = parseOwnerTimestamp(disk.owner?.updatedAt);
        const ownerFresh =
          Number.isFinite(ownerSeenAt) && Date.now() - ownerSeenAt < DEFAULT_LOCK_STALE_MS;

        if (phase !== "idle" && description !== "" && foreignOwner && ownerFresh && currentIsAlive()(ownerPid)) {
          foreignTask = {
            file: targetStateFile,
            disk,
            phase,
            description,
            ownerPid,
            ownerSeenAt,
          };
        }
      }
    }
    return foreignTask;
  };

  const formatForeignTaskRefusal = (foreignTask) => {
    const seen = Number.isFinite(foreignTask.ownerSeenAt)
      ? new Date(foreignTask.ownerSeenAt).toISOString()
      : "waktu tidak diketahui";

    return textResponse(
      `⚠️ Dibatalkan: task lain sedang berjalan di proses MCP PID ${foreignTask.ownerPid}.\n\n` +
        `Task      : "${foreignTask.description}"\n` +
        `Fase      : ${foreignTask.phase}\n` +
        `Pemilik   : PID ${foreignTask.ownerPid}, terakhir menulis state ${seen}\n\n` +
        `Memulai task baru di sini akan mengosongkan Definition of Done task itu, dan buktinya ` +
        `tidak bisa dipulihkan dari history. Karena itu 'force' TIDAK bisa melewati penjaga ini ` +
        `selama pemiliknya masih menulis.\n\n` +
        `Pilih salah satu:\n` +
        `  1. Selesaikan atau batalkan task itu dari sesi pemiliknya (complete_task / drop_task).\n` +
        `  2. Beri sesi ini worktree sendiri: opencode.worktree_create, lalu jalankan sesi dari sana.\n` +
        `  3. Kalau proses itu sudah tidak dipakai, tutup jendelanya. Penjaga berhenti menghalangi ` +
        `setelah ${Math.round(DEFAULT_LOCK_STALE_MS / 60000)} menit tanpa tulisan state.\n\n` +
        `Task BELUM dimulai; tidak ada state yang diubah.`
    );
  };

  {
    const foreignTask = await detectForeignTaskOnTarget();
    if (foreignTask) {
      return formatForeignTaskRefusal(foreignTask);
    }
  }

  // Repository identity preflight.
  //
  // 13 November 2026: a session pinned to DBPinball accepted a Clinic task and
  // replaced its own active task. The working directory never changed and no
  // cross-project commit was made, so the defect was not in git: `start_task`
  // resolved the requested `projectDir` and never compared it with the
  // repository the session had already established. A natural-language task
  // description was enough to move the session to another project.
  //
  // The comparison runs here, before `reset()`, so a refusal changes nothing:
  // the active task, its Definition of Done and its evidence stay intact.
  const requestedIdentity = await captureRepositoryIdentity({ dir: project.dir });
  if (!requestedIdentity || !requestedIdentity.isGitRepo || !requestedIdentity.root) {
    return textResponse(
      `⚠️ Refused: "${project.dir}" is not a valid Git working tree.\n\n` +
        `A task must be anchored to a real Git repository or worktree so its canonical ` +
        `worktree mutex and repository identity can be verified fail-closed.\n\n` +
        `Task NOT started; the previous task and its evidence are unchanged.`
    );
  }
  const sessionProject = readSessionProject({ stateFile: workflowState.stateFile });
  let sessionIdentity = null;
  if (sessionProject) {
    const observed = await captureRepositoryIdentity({ dir: sessionProject.projectDir });
    if (observed.isGitRepo) {
      sessionIdentity = {
        projectDir: sessionProject.projectDir,
        root: observed.root,
        remote: observed.remote,
        repoKey: parseRemoteIdentity(observed.remote)?.key || "",
        commonDir: observed.commonDir,
        commonDirKey: observed.commonDirKey,
        workspaceKey: observed.workspaceKey,
      };
    }
  }

  const switchDecision = evaluateProjectSwitch({
    requested: requestedIdentity,
    session: sessionIdentity,
    allowProjectSwitch: args.allowProjectSwitch,
    projectSwitchReason: args.projectSwitchReason,
    allowWorkspaceTransition: args.allowWorkspaceTransition,
    workspaceTransitionReason: args.workspaceTransitionReason,
    focusId: args.focusId,
  });
  if (!switchDecision.ok) {
    return textResponse(switchDecision.message);
  }

  // Focus binding preflight: check if already bound to another project before
  // acquiring or relocating any locks.
  const requestedRepoKey = parseRemoteIdentity(requestedIdentity.remote)?.key || "";
  const requestedFocusId = Number(args.focusId);
  const hasRequestedFocus = Number.isSafeInteger(requestedFocusId) && requestedFocusId > 0;
  if (hasRequestedFocus) {
    const binding = readFocusBinding({ stateFile: workflowState.stateFile, focusId: requestedFocusId });
    if (binding) {
      const sameKey = Boolean(binding.repoKey) && Boolean(requestedRepoKey) && binding.repoKey === requestedRepoKey;
      const sameDir =
        Boolean(binding.projectDir) &&
        Boolean(requestedIdentity.root) &&
        normalizeRepoPath(binding.projectDir) === normalizeRepoPath(requestedIdentity.root);
      if (!sameKey && !sameDir) {
        return textResponse(
          `⚠️ Refused: focus ${requestedFocusId} belongs to another project.\n\n` +
            `Focus bound to: ${binding.projectDir || binding.repoKey}\n` +
            `Requested repo: ${requestedIdentity.root || project.dir}\n\n` +
            `A focus is a container for one project's work. Attaching this task to it would ` +
            `make the focus report work it does not own.\n\n` +
            `Choose the focus that owns this repository, or set a new focus first.\n` +
            `Task NOT started; the previous task and its evidence are unchanged.`
        );
      }
    }
  }

  // Stage 2 (Option B): Acquire authoritative OS-owned kernel mutex for the
  // canonical Git working tree BEFORE any state, pointer, or focus mutation.
  const sessionOwnerKey =
    (typeof workflowState?._sessionKey === "function" ? workflowState._sessionKey()?.key : "") ||
    workflowState?.sessionId ||
    path.resolve(String(targetStateFile || workflowState?.stateFile || "")) ||
    String(process.pid);
  const targetMutex = await acquireWorktreeMutex({
    projectDir: project.dir,
    ownerKey: sessionOwnerKey,
  });

  if (!targetMutex.ok) {
    if (targetMutex.reason === "unsupported_platform") {
      return textResponse(
        `⚠️ Refused: ${targetMutex.message}\n\n` +
          `Task NOT started; the previous task and its evidence are unchanged.`
      );
    }
    if (targetMutex.reason === "invalid_project_dir") {
      return textResponse(
        `⚠️ Refused: invalid projectDir (${targetMutex.message || targetMutex.error}).\n\n` +
          `Task NOT started; the previous task and its evidence are unchanged.`
      );
    }
    if (targetMutex.reason === "mutex_error") {
      return textResponse(
        `⚠️ Dibatalkan: gagal memperoleh mutex kernel OS untuk "${project.dir}" ` +
          `(${targetMutex.error || "MUTEX_ERROR"}).\n\n` +
          `Kepemilikan eksklusif tidak dapat diverifikasi (fail-closed).\n` +
          `Task BELUM dimulai; tidak ada state yang diubah.`
      );
    }
    return textResponse(
      `⚠️ Dibatalkan: sesi lain sedang memegang mutex kernel OS untuk working tree ini.\n\n` +
        `Endpoint mutex: ${targetMutex.endpoint || project.dir}\n` +
        `Dua sesi pada satu working tree dilarang di Option B; mutex kernel hanya ` +
        `dilepas saat sesi pemilik selesai atau prosesnya berhenti.\n\n` +
        `Task BELUM dimulai; tidak ada state yang diubah.`
    );
  }

  // Reject overlap with any live legacy (pre-Option-B) writer process or foreign v2 lock.
  const legacyWriter = findActiveLegacyWriter({
    dir: targetLockDir,
    isAlive: currentIsAlive(),
  });
  if (legacyWriter) {
    if (!targetMutex.alreadyHeld) {
      await releaseWorktreeMutex(targetMutex.capability);
    }
    if (legacyWriter.inspectionError) {
      return textResponse(
        `⚠️ Dibatalkan: status kunci proses untuk proyek ini tidak dapat diverifikasi secara tertutup ` +
          `(${legacyWriter.reason || legacyWriter.error || "LOCK_INSPECTION_FAILED"}).\n\n` +
          `Kepemilikan eksklusif menolak melanjutkan saat metadata kunci korup atau tidak terbaca (fail-closed).\n` +
          `Task BELUM dimulai; tidak ada state yang diubah.`
      );
    }
    const isGenuineLegacy = isLegacyLock(legacyWriter) || legacyWriter.kernelMutex === false;
    if (isGenuineLegacy) {
      return textResponse(
        `⚠️ Dibatalkan: terdeteksi penulis protokol lama (legacy v1) yang masih hidup pada proyek ini ` +
          `(PID ${legacyWriter.pid || "tidak diketahui"}).\n\n` +
          `Option B menolak bekerja berdampingan dengan proses lama yang belum memegang mutex kernel OS.\n` +
          `Restart klien MCP lama terlebih dahulu sebelum memulai task di working tree ini.\n\n` +
          `Task BELUM dimulai; tidak ada state yang diubah.`
      );
    }
    return textResponse(
      `⚠️ Dibatalkan: sesi lain sedang mengerjakan proyek ini ` +
        `(PID ${legacyWriter.pid || "tidak diketahui"}).\n\n` +
        `Dua sesi pada satu proyek dilarang; tunggu sesi lain selesai atau tutup prosesnya terlebih dahulu.\n\n` +
        `Task BELUM dimulai; tidak ada state yang diubah.`
    );
  }

  // Also check shared state root for any live legacy v1 writers in unpinned buckets (R2-5).
  const projectsParent = path.dirname(targetLockDir);
  if (path.basename(projectsParent) === "projects") {
    const stateBase = path.dirname(projectsParent);
    const quiescence = verifyLegacyFleetQuiescence({
      baseDir: stateBase,
      isAlive: currentIsAlive(),
    });
    if (quiescence.inspectionErrors && quiescence.inspectionErrors.length > 0) {
      if (!targetMutex.alreadyHeld) {
        await releaseWorktreeMutex(targetMutex.capability);
      }
      const errItem = quiescence.inspectionErrors[0];
      return textResponse(
        `⚠️ Dibatalkan: pemeriksaan quiescence gagal secara tertutup ` +
          `(${errItem.reason || errItem.error || "QUIESCENCE_INSPECTION_FAILED"}).\n\n` +
          `Direktori atau metadata kunci tidak dapat diperiksa secara utuh (fail-closed).\n` +
          `Task BELUM dimulai; tidak ada state yang diubah.`
      );
    }
    if (quiescence.legacyWriters.length > 0) {
      if (!targetMutex.alreadyHeld) {
        await releaseWorktreeMutex(targetMutex.capability);
      }
      const w = quiescence.legacyWriters[0];
      return textResponse(
        `⚠️ Dibatalkan: terdeteksi penulis protokol lama (legacy v1) yang masih hidup pada proyek ini ` +
          `(PID ${w.pid || "tidak diketahui"}).\n\n` +
          `Option B menolak bekerja berdampingan dengan proses lama yang belum memegang mutex kernel OS.\n` +
          `Restart klien MCP lama terlebih dahulu sebelum memulai task di working tree ini.\n\n` +
          `Task BELUM dimulai; tidak ada state yang diubah.`
      );
    }
  }

  // Re-verify foreign task under the newly acquired target worktree mutex.
  {
    const foreignTaskAfterLock = await detectForeignTaskOnTarget();
    if (foreignTaskAfterLock) {
      if (!targetMutex.alreadyHeld) {
        await releaseWorktreeMutex(targetMutex.capability);
      }
      return formatForeignTaskRefusal(foreignTaskAfterLock);
    }
  }

  // Stage 3 (Option B): Execute transition under the live OS mutex capability
  // with a single authoritative SQLite commit boundary.
  const transitionHooks = zettlyOptions?.transitionHooks || null;
  const priorStateSnapshot = structuredClone(workflowState.state);
  const priorStateFile = workflowState.stateFile;
  const priorHistoryFile = workflowState.historyFile;
  const priorStateVersion = workflowState.stateVersion;
  const priorLoadedTask = workflowState.loadedTask;
  const rawPriorCapability = workflowState.boundKernelCapability || null;
  const priorKernelCapability =
    rawPriorCapability &&
    (!rawPriorCapability.ownerKey || rawPriorCapability.ownerKey === sessionOwnerKey)
      ? rawPriorCapability
      : null;
  const priorRequireKernelMutex = Boolean(workflowState.requireKernelMutex);
  const priorActiveProjectDir = priorStateSnapshot.projectDir || "";

  let preservedBeforeSave = null;
  let archivedTask = null;
  let reconciled = null;
  let claimedNewFocus = false;
  let sqliteCommitted = false;
  const warnings = [];

  try {
    if (typeof workflowState.bindKernelCapability === "function") {
      workflowState.bindKernelCapability(targetMutex.capability);
    }
    workflowState.requireKernelMutex = true;
    workflowState._lastSaveCommittedSqlite = false;
    workflowState._lastLoadCommittedSqlite = false;

    const committed = await useWorktreeCapability(
      targetMutex.capability,
      async () => {
        if (typeof transitionHooks?.afterStageLock === "function") {
          await transitionHooks.afterStageLock({ targetMutex });
        }

        if (hasRequestedFocus) {
          const claimed = await claimFocusBinding({
            stateFile: workflowState.stateFile,
            focusId: requestedFocusId,
            projectDir: project.dir,
            repoKey: requestedRepoKey,
            kernelCapability: targetMutex.capability,
            requireKernelMutex: true,
            expectedOwnerKey: sessionOwnerKey,
          });
          if (claimed && claimed.ok === false) {
            return { refusedResponse: textResponse(
              `⚠️ Refused: focus ${requestedFocusId} could not be claimed.\n\n` +
                `Reason: ${claimed.reason || "unknown"}\n` +
                (claimed.existing
                  ? `Focus bound to: ${claimed.existing.projectDir || claimed.existing.repoKey || "(unknown)"}\n`
                  : "") +
                `Requested repo: ${requestedIdentity.root || project.dir}\n\n` +
                `Task NOT started; the previous task and its evidence are unchanged.`
            ) };
          }
          if (claimed && claimed.ok && claimed.reason === "BOUND") {
            claimedNewFocus = true;
          }
          if (typeof transitionHooks?.afterClaimFocus === "function") {
            await transitionHooks.afterClaimFocus({ claimed, targetMutex });
          }
        }

        // Pre-compute git baseline before mutating workflowState in-memory fields.
        const resolvedBaseSha = await resolveBaseSha(project.dir);
        if (typeof transitionHooks?.afterResolveBaseSha === "function") {
          await transitionHooks.afterResolveBaseSha({ resolvedBaseSha, targetMutex });
        }

        // If switching to another project's state file, switch and load its authoritative
        // SQLite version BEFORE composing and committing the new task state.
        if (targetStateFile !== workflowState.stateFile) {
          if (typeof workflowState.close === "function") {
            await workflowState.close();
          }
          workflowState.stateFile = targetStateFile;
          workflowState.historyFile = resolveHistoryFile(targetStateFile);
          workflowState.state.projectDir = project.dir;
          await workflowState.load({ skipWrites: true });
        }

        // Selamatkan dulu pekerjaan yang mungkin tertimpa.
        preservedBeforeSave = await workflowState.reconcileWithDisk();
        const previousTaskIdentity = {
          taskDescription: workflowState.state.taskDescription,
          projectDir: workflowState.state.projectDir,
          workflowTaskId: workflowState.state.workflowTaskId,
          zettly: workflowState.state.zettly,
          taskOrigin: workflowState.state.taskOrigin,
        };
        const resetResult = workflowState.reset({ archive: true });
        archivedTask = resetResult.archivedTask;

        workflowState.state.currentPhase = "coding";
        workflowState.state.taskStartedAt = new Date().toISOString();
        workflowState.state.classification = classify(args);
        workflowState.state.taskDescription = args.description;
        workflowState.state.machine = String(
          env.DEVWF_MACHINE || os.hostname() || "unknown"
        );
        workflowState.state.checkpoint = {
          checkpointedAt: null,
          summary: "",
          baseSha: resolvedBaseSha,
          commits: [],
          handover: null,
        };
        workflowState.state.taskType = args.type;
        workflowState.state.plan = planDerived
          ? createPlan(dodCheck.items.map((text) => `Complete: ${text}`))
          : createPlan(planCheck.items);
        workflowState.state.definitionOfDone = dodCheck.items.map((text, index) => ({
          id: `dod-${index + 1}`,
          text,
          status: "open",
          evidence: "",
          waivedReason: "",
          revision: 0,
          updatedAt: new Date().toISOString(),
        }));
        workflowState.state.dodSource = "manual";
        workflowState.state.dodFactoryTaskId = "";
        workflowState.state.dodRevision = 0;
        workflowState.state.testsSkipped = false;
        workflowState.state.testsSkippedReason = "";
        workflowState.state.commitAndPushCompleted = false;
        workflowState.state.lastCommitMessage = "";
        workflowState.state.lastPushBranch = "";
        workflowState.state.projectDir = project.dir;
        setActiveProjectDir(project.dir);

        workflowState.state.identityContract = buildIdentityContract({
          projectId: requestedRepoKey || path.basename(requestedIdentity.root || project.dir),
          identity: requestedIdentity,
          focusId: hasRequestedFocus ? requestedFocusId : null,
          allowedOperations: ["read", "write", "commit", "push"],
        });

        workflowState.state.dirtyAtStart = await captureDirtyAtStart(git);
        assignWorkflowIdentity(workflowState.state, previousTaskIdentity, args);

        let initialFlow = typeof args.mermaidFlow === 'string' ? args.mermaidFlow.trim() : (typeof args.mermaidCode === 'string' ? args.mermaidCode.trim() : '');
        let flowValid = false;
        if (initialFlow) {
          try {
            flowGraph(initialFlow);
            flowValid = true;
          } catch (err) {
            warnings.push(`⚠️ Provided mermaidFlow is invalid (${err.message}); falling back to auto-generated architecture flow.`);
          }
        }
        if (!flowValid) {
          initialFlow = generateDefaultFlow(args.description, workflowState.state.plan);
        }
        workflowState.state.featureFlowCreated = true;
        workflowState.state.mermaidCode = initialFlow;
        workflowState.state.featureFlowDescription = args.description;

        if (typeof transitionHooks?.beforeSave === "function") {
          await transitionHooks.beforeSave({ workflowState, targetMutex });
        }

        // Authoritative SQLite commit boundary (fenced by live OS mutex).
        workflowState._lastSaveCommittedSqlite = false;
        reconciled = await workflowState.save({ allowReplaceRunningTask: true });
        if (!reconciled || reconciled.verified === false || reconciled.conflict) {
          throw new Error(
            reconciled?.conflict?.reason ||
              "Target project state persistence could not be verified.",
          );
        }
        sqliteCommitted = true;

        if (typeof transitionHooks?.afterSave === "function") {
          await transitionHooks.afterSave({ reconciled, targetMutex });
        }

        // Post-commit reconstructible projections & pointers (fenced by live OS mutex).
        const postCommitProjectionErrors = [];
        if (workflowState._lastExportJsonOk === false) {
          postCommitProjectionErrors.push("exportJson:EXPORT_RETURNED_FALSE");
        }
        if (workflowState.state.projectDir) {
          const pinRes = pinSessionProject({
            stateFile: workflowState.stateFile,
            projectDir: workflowState.state.projectDir,
            focusId: hasRequestedFocus ? requestedFocusId : null,
            kernelCapability: targetMutex.capability,
            requireKernelMutex: true,
            expectedOwnerKey: sessionOwnerKey,
          });
          if (!pinRes || pinRes.ok === false) {
            postCommitProjectionErrors.push(`pinSessionProject:${pinRes?.error || "FAILED"}`);
          }
        }
        const metaRes = writeKernelLockMetadata({
          dir: targetLockDir,
          capability: targetMutex.capability,
          projectDir: targetMutex.worktreeRoot,
          expectedOwnerKey: sessionOwnerKey,
        });
        if (!metaRes || metaRes.ok === false) {
          postCommitProjectionErrors.push(`writeKernelLockMetadata:${metaRes?.error || "FAILED"}`);
        }
        if (postCommitProjectionErrors.length > 0) {
          throw new Error(`Post-commit projection failed (${postCommitProjectionErrors.join(", ")})`);
        }

        workflowState.state.pendingProjectionRepair = null;
        return { ok: true };
      },
      { operation: "start_task_transition" },
    );

    if (committed?.refusedResponse) {
      let focusRollbackError = null;
      if (claimedNewFocus && hasRequestedFocus) {
        try {
          const retireRes = await retireFocusBinding({
            stateFile: targetStateFile,
            focusId: requestedFocusId,
            reason: "rollback_on_transition_refusal",
          });
          if (!retireRes || retireRes.ok === false) {
            focusRollbackError = retireRes?.reason || retireRes?.error || "RETIRE_FOCUS_FAILED";
          }
        } catch (err) {
          focusRollbackError = err?.message || String(err);
        }
      }
      workflowState.state = priorStateSnapshot;
      if (focusRollbackError) {
        workflowState.state.pendingFocusCleanup = {
          focusId: requestedFocusId,
          stateFile: targetStateFile,
          error: focusRollbackError,
          failedAt: new Date().toISOString(),
        };
      }
      workflowState.stateFile = priorStateFile;
      workflowState.historyFile = priorHistoryFile;
      workflowState.stateVersion = priorStateVersion;
      workflowState.loadedTask = priorLoadedTask;
      if (typeof workflowState.bindKernelCapability === "function") {
        workflowState.bindKernelCapability(priorKernelCapability);
      }
      workflowState.requireKernelMutex = priorRequireKernelMutex;
      setActiveProjectDir(priorActiveProjectDir);
      if (!targetMutex.alreadyHeld) {
        await releaseWorktreeMutex(targetMutex.capability);
      }
      return committed.refusedResponse;
    }

    if (priorKernelCapability && priorKernelCapability !== targetMutex.capability) {
      await releaseWorktreeMutex(priorKernelCapability);
    }
  } catch (transitionError) {
    const committedToSqlite =
      sqliteCommitted || Boolean(workflowState._lastSaveCommittedSqlite);
    if (committedToSqlite) {
      // Authoritative SQLite commit already succeeded under the live OS mutex.
      // Never roll back committed SQLite state or release the target capability;
      // instead, reconcile reconstructible post-commit projections under the live fence
      // and verify every repair outcome.
      const repairErrors = [];
      try {
        await useWorktreeCapability(
          targetMutex.capability,
          async () => {
            if (workflowState.state.projectDir) {
              try {
                const pinRes = pinSessionProject({
                  stateFile: workflowState.stateFile,
                  projectDir: workflowState.state.projectDir,
                  focusId: hasRequestedFocus ? requestedFocusId : null,
                  kernelCapability: targetMutex.capability,
                  requireKernelMutex: true,
                  expectedOwnerKey: sessionOwnerKey,
                });
                if (pinRes && pinRes.ok === false) {
                  repairErrors.push(`pinSessionProject:${pinRes.error || "FAILED"}`);
                }
              } catch (err) {
                repairErrors.push(`pinSessionProject:${err?.message || String(err)}`);
              }
            }
            try {
              const metaRes = writeKernelLockMetadata({
                dir: targetLockDir,
                capability: targetMutex.capability,
                projectDir: targetMutex.worktreeRoot,
                expectedOwnerKey: sessionOwnerKey,
              });
              if (!metaRes || metaRes.ok === false) {
                repairErrors.push(`writeKernelLockMetadata:${metaRes?.error || "FAILED"}`);
              }
            } catch (err) {
              repairErrors.push(`writeKernelLockMetadata:${err?.message || String(err)}`);
            }
            if (typeof workflowState._exportJson === "function") {
              try {
                const exported = await workflowState._exportJson();
                if (exported === false) {
                  repairErrors.push("exportJson:EXPORT_RETURNED_FALSE");
                }
              } catch (err) {
                repairErrors.push(`exportJson:${err?.message || String(err)}`);
              }
            }
          },
          { operation: "start_task_post_commit_reconcile" },
        );
      } catch (fenceErr) {
        repairErrors.push(`reconcileFence:${fenceErr?.message || String(fenceErr)}`);
      }
      if (priorKernelCapability && priorKernelCapability !== targetMutex.capability) {
        await releaseWorktreeMutex(priorKernelCapability);
      }
      if (repairErrors.length > 0) {
        workflowState.state.pendingProjectionRepair = sanitize({
          failedAt: new Date().toISOString(),
          triggerError: transitionError?.message || String(transitionError),
          repairErrors,
        });
        warnings.push(
          `⚠️ Authoritative SQLite task commit succeeded and was preserved, but post-commit projection repair is PENDING ` +
            `(trigger: ${transitionError?.message || String(transitionError)}; repairErrors: ${repairErrors.join(", ")}).`
        );
      } else {
        workflowState.state.pendingProjectionRepair = null;
        warnings.push(
          `⚠️ Post-commit projection warning reconciled and verified (${transitionError?.message || String(transitionError)}). ` +
            `Authoritative SQLite task commit was preserved.`
        );
      }
    } else {
      // Pre-commit failure: restore in-memory state cleanly; prior SQLite state & DoD evidence were not overwritten.
      let focusRollbackError = null;
      if (claimedNewFocus && hasRequestedFocus) {
        try {
          const retireRes = await retireFocusBinding({
            stateFile: targetStateFile,
            focusId: requestedFocusId,
            reason: "rollback_on_transition_failure",
          });
          if (!retireRes || retireRes.ok === false) {
            focusRollbackError = retireRes?.reason || retireRes?.error || "RETIRE_FOCUS_FAILED";
          }
        } catch (err) {
          focusRollbackError = err?.message || String(err);
        }
      }
      if (workflowState.stateFile !== priorStateFile && typeof workflowState.close === "function") {
        try {
          await workflowState.close();
        } catch {}
      }
      workflowState.state = priorStateSnapshot;
      if (focusRollbackError) {
        workflowState.state.pendingFocusCleanup = {
          focusId: requestedFocusId,
          stateFile: targetStateFile,
          error: focusRollbackError,
          failedAt: new Date().toISOString(),
        };
      }
      workflowState.stateFile = priorStateFile;
      workflowState.historyFile = priorHistoryFile;
      workflowState.stateVersion = priorStateVersion;
      workflowState.loadedTask = priorLoadedTask;
      if (typeof workflowState.bindKernelCapability === "function") {
        workflowState.bindKernelCapability(priorKernelCapability);
      }
      workflowState.requireKernelMutex = priorRequireKernelMutex;
      setActiveProjectDir(priorActiveProjectDir);
      if (!targetMutex.alreadyHeld) {
        await releaseWorktreeMutex(targetMutex.capability);
      }

      if (focusRollbackError) {
        return textResponse(
          `⚠️ Dibatalkan sebelum komit SQLite (${transitionError?.message || String(transitionError)}), ` +
            `namun pembersihan ikatan focus #${requestedFocusId} GAGAL (${focusRollbackError}) — rollback TIDAK LENGKAP.\n\n` +
            `State workflow dan penunjuk sesi sebelumnya telah dipulihkan serta bukti pembersihan tertunda ` +
            `(pendingFocusCleanup) telah dicatat.`
        );
      }

      return textResponse(
        `⚠️ Dibatalkan: transisi menuju proyek "${project.dir}" gagal sebelum komit SQLite ` +
          `(${transitionError?.message || String(transitionError)}).\n\n` +
          `Seluruh state workflow, penunjuk sesi, ikatan focus, dan kunci proses telah ` +
          `dikembalikan ke kondisi sebelum 'start_task' dipanggil.`
      );
    }
  }

  // Sinkronkan judul sesi AI (OpenCode / Monitor) ke deskripsi task baru
  try {
    const sKey = (typeof workflowState._sessionKey === "function" ? workflowState._sessionKey()?.key : "") || workflowState.sessionId || "";
    if (sKey && typeof updateSessionTitle === "function") {
      updateSessionTitle(sKey, args.description);
    }
  } catch {
    // Best effort: kegagalan penamaan sesi tidak boleh mengganggu start_task
  }

  await reportEventSafe(
    workflowState.state,
    "task_started",
    `${workflowState.state.taskDescription} (${workflowState.state.taskType}, ${workflowState.state.plan.length} langkah)`,
  );

  const preservedForeign = reconciled?.preservedTask || preservedBeforeSave?.preservedTask;
  if (preservedForeign) {
    warnings.push(
      `⚠️ Ada task yang SEDANG BERJALAN dari proses agen lain dan hampir tertimpa:\n` +
        `   "${preservedForeign}"\n` +
        `   Task itu sudah disimpan ke history sebagai 'interrupted', bukan dihapus.\n` +
        `   State workflow di mesin ini dipakai bersama antar sesi - periksa sebelum commit.`
    );
  }
  if (archivedTask) {
    warnings.push(
      `ℹ️ Task sebelumnya belum selesai dan diganti: "${archivedTask}".\n` +
        `   Disimpan ke history sebagai 'interrupted'.`
    );
  }
  if (reconciled?.mergedHistory > 0) {
    warnings.push(
      `ℹ️ ${reconciled.mergedHistory} entri history dari proses lain digabungkan, tidak ditimpa.`
    );
  }

  // Catat ke board Factory bila diminta. Tidak pernah menggagalkan start_task,
  // tetapi kegagalannya DITAMPILKAN - kegagalan tak terlihat adalah persis yang
  // membuat board diam dua hari tanpa ada yang tahu.
  let factoryNote = "";
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const { recordToFactory } = req("../../factory-auto-task.cjs");
    const hasil = await recordToFactory({ state: workflowState.state });
    if (hasil.ok) {
      workflowState.state.dodFactoryTaskId = hasil.id;
      workflowState.state.zettly.externalLinks={...workflowState.state.zettly.externalLinks,factory:{id:hasil.id,taskKey:''}};
      const persisted=await workflowState.save();
      if(persisted?.verified===false||persisted?.conflict)throw Error('Factory link persistence was not verified');
      factoryNote = `\n\n🏭 ${hasil.reused?'Linked existing':'Recorded in'} Factory: ${hasil.id}`;
    } else if (hasil.reason && hasil.reason !== "dimatikan" && hasil.reason !== "kredensial Factory tidak lengkap") {
      factoryNote = `\n\n⚠️ Factory TIDAK mencatat task ini: ${hasil.reason}`;
    }
  } catch (e) {
    factoryNote = `\n\n⚠️ Factory TIDAK mencatat task ini: ${String(e && e.message).slice(0, 160)}`;
  }

  let drawNote = "";
  try {
    const drawing = await syncZettlyDrawing(workflowState, zettlyOptions);
    if (drawing.ok) {
      drawNote = `\n\n🎨 Zettly Draw #${drawing.id}: ${drawing.url || `https://zettly.programinglive.com/draw/${drawing.id}`}`;
    } else if (drawing.note) {
      // A pending drawing means the monitor has no flow to show. Say so in the
      // start_task reply, because an agent that never sees this will work
      // through the whole task with an invisible plan.
      drawNote =
        `\n\n⚠️ FLOW BELUM TERLIHAT DI MONITOR: ${drawing.note}\n` +
        `   Jalankan 'create_feature_flow' sekarang (sebelum menulis kode) supaya konteksnya lengkap. ` +
        `Setiap balasan tool akan mengingatkan sampai drawing-nya ada.`;
    }
  } catch (e) {
    drawNote = `\n\n⚠️ Zettly Draw sync error: ${String(e && e.message).slice(0, 120)}`;
  }

  const warningBlock = warnings.length > 0 ? `\n\n${warnings.join("\n\n")}` : "";

  const dodLines = workflowState.state.definitionOfDone
    .map((item) => `   ${item.id}: ${item.text}`)
    .join("\n");

  const mcpRecommendations = formatMcpRecommendations({
    description: workflowState.state.taskDescription,
    projectDir: workflowState.state.projectDir,
    definitionOfDone: workflowState.state.definitionOfDone,
    plan: workflowState.state.plan,
  });
  const mcpBlock = mcpRecommendations ? `${mcpRecommendations}\n\n` : "";

  // Which tasks are other sessions holding right now? The agent only learns
  // this after choosing, so report it here, before it commits to the task.
  const ownSessionKey = (typeof workflowState._sessionKey === "function" ? workflowState._sessionKey()?.key : "")
    || workflowState.sessionId
    || "";
  const claimBlock = await describeActiveClaims({sessionKey: ownSessionKey});

  const cliTip = args.type === "feature"
    ? `💡 Multiplatform / CLI-First Standard: Build core business logic into headless services/actions first and expose an executable CLI command before or alongside UI components. Verify CLI execution in your DoD.\n\n`
    : "";

  return textResponse(
    `✅ Task Started: ${args.description}\n\n${project.message}${warningBlock}${claimBlock}${factoryNote}${drawNote}\n\n` +
      cliTip +
      `📋 Definition of Done (${workflowState.state.definitionOfDone.length} item, semua masih terbuka):\n${dodLines}\n` +
      `   Buktikan tiap item dengan 'mark_dod_item' { id, evidence } setelah benar-benar terbukti,\n` +
      `   atau kecualikan dengan 'waive_dod_item' { id, reason } bila memang tidak relevan.\n\n` +
      (planDerived
        ? `⚠️ 'plan' tidak dikirim, jadi rencana SEMENTARA diturunkan dari DoD.\n` +
          `   Urutannya belum tentu urutan kerja yang benar. Kirim 'plan' pada 'start_task',\n` +
          `   atau susun ulang sekarang dengan 'set_plan' { steps: [...] }.\n\n`
        : `${renderPlanFull(workflowState.state.plan)}\n\n`) +
      mcpBlock +
      `🎯 Be conscious about what you're coding!\n\nWorkflow Steps:\n1. ✓ Start task & Zettly Draw flow recorded (current)\n2. ⏳ Refine feature flow with 'create_feature_flow' if needed\n3. ⏳ Fix/implement the feature\n4. ⏳ Prove each definition-of-done item\n5. ⏳ Create tests\n6. ⏳ Run tests (must pass!)\n7. ⏳ Create documentation\n8. ⏳ Run 'check_ready_to_commit'\n9. ⏳ Run 'commit_and_push' (commits and pushes)\n10. ⏳ Run 'perform_release' or 'skip_release' (when no release is needed)\n11. ⏳ Complete task\n12. ✓ Workflow closed\n\nReminder: Focus on writing clean, maintainable code!`
  );
}

export async function handleMarkBugFixed(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Please start a task first using 'start_task'!");
  }

  if (!workflowState.state.featureFlowCreated) {
    return textResponse("⚠️ Record the issue-solving plan with create_feature_flow before marking implementation complete.");
  }

  if (workflowState.state.bugFixed) {
    const summary = typeof args.summary === "string" ? args.summary : "";
    if (summary && summary.trim() !== "") {
      workflowState.state.fixSummary = summary;
    }

    if (workflowState.state.testsPassed && workflowState.state.documentationCreated) {
      workflowState.state.currentPhase = "ready";
      workflowState.state.readyToCommit = true;
    } else if (workflowState.state.testsCreated) {
      workflowState.state.currentPhase = "testing";
    }
    workflowState.state.readyCheckCompleted = false;
    workflowState.state.commitAndPushCompleted = false;
    await workflowState.save();

    return textResponse(
      "ℹ️ Already marked as fixed; kept existing tests/documentation. Continue with the next step."
    );
  }

  workflowState.state.bugFixed = true;
  workflowState.state.testsCreated = false;
  workflowState.state.currentPhase = "testing";
  workflowState.state.testsSkipped = false;
  workflowState.state.testsSkippedReason = "";
  workflowState.state.fixSummary = args.summary;
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.released = false;
  workflowState.state.releaseSkipped = false;
  workflowState.state.releaseSkippedReason = "";
  workflowState.state.releaseCommand = "";
  workflowState.state.releaseNotes = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";
  await workflowState.save();

  return textResponse(
    `✅ Feature/Bug marked as fixed!\n\n⚠️ CRITICAL REMINDER: You MUST create tests now!\n\nNext Steps:\n1. ✓ Fix/implement feature\n2. ⏳ Create tests for: ${args.summary}\n3. ⏳ Run tests (must be green!)\n4. ⏳ Create documentation\n5. ⏳ Run 'check_ready_to_commit'\n6. ⏳ Run 'commit_and_push'\n7. ⏳ Run 'perform_release' (or 'skip_release' if no release applies)\n8. ⏳ Complete task\n\n🚫 DO NOT SKIP TESTING!`
  );
}

export async function handleCreateFeatureFlow(args, workflowState, zettlyOptions={}) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Please start a task first using 'start_task'!");
  }

  const mermaidCode = typeof args.mermaidCode === "string" ? args.mermaidCode.trim() : "";
  const description = typeof args.description === "string" ? args.description.trim() : "";

  if (!mermaidCode || !description) {
    return textResponse("⚠️ Please provide both 'mermaidCode' and 'description' when creating a feature flow.");
  }
  try{flowGraph(mermaidCode);}catch(error){return textResponse(`⚠️ Invalid Mermaid flow: ${error.message}`);}

  workflowState.state.featureFlowCreated = true;
  workflowState.state.mermaidCode = mermaidCode;
  workflowState.state.featureFlowDescription = description;
  workflowState.state.readyCheckCompleted = false;
  await workflowState.save();
  const drawing=await syncZettlyDrawing(workflowState,zettlyOptions);

  // The drawing relation is added AFTER the save above. Report once more so the
  // card shows the flow immediately instead of waiting for an unrelated save.
  try {
    const sessionKey = typeof workflowState._sessionKey === 'function'
      ? workflowState._sessionKey().key
      : '';
    await reportSnapshot({
      snapshot: buildSnapshot({
        state: workflowState.state,
        sessionKey,
        projectPath: workflowState.state.projectDir || '',
        sessionStartedAt: workflowState.state.taskStartedAt || '',
      }),
    });
  } catch {
    // Reporting is best-effort; the flow itself is already recorded.
  }

  return textResponse(
    `✅ Feature flow recorded!\n\nDescription: ${description}\n${drawing.ok?`Zettly Draw #${drawing.id}: ${drawing.url||''}`:drawing.note}\n\nNext Steps:\n1. ✓ Start task\n2. ✓ Describe feature flow\n3. ⏳ Fix/implement the feature\n4. ⏳ Create tests\n5. ⏳ Run tests\n6. ⏳ Create documentation\n7. ⏳ Run 'check_ready_to_commit'\n8. ⏳ Run 'commit_and_push'\n9. ⏳ Run 'perform_release'\n10. ⏳ Complete task`
  );
}

export async function handleCreateTests(workflowState) {
  if (!workflowState.state.featureFlowCreated) {
    return textResponse("⚠️ Record the feature flow with 'create_feature_flow' before creating tests!");
  }
  if (!workflowState.state.bugFixed) {
    return textResponse("⚠️ Please mark your feature/bug as fixed first using 'mark_bug_fixed'!");
  }

  workflowState.state.testsCreated = true;
  workflowState.state.testsSkipped = false;
  workflowState.state.testsSkippedReason = "";
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.released = false;
  workflowState.state.releaseSkipped = false;
  workflowState.state.releaseSkippedReason = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";
  await workflowState.save();

  return textResponse(
    "✅ Tests recorded!\n\nNext Steps:\n1. ✓ Fix/implement feature\n2. ✓ Create tests\n3. ⏳ Run tests (must be green!)\n4. ⏳ Create documentation\n5. ⏳ Run 'check_ready_to_commit'\n6. ⏳ Run 'commit_and_push'\n7. ⏳ Run 'perform_release' (or 'skip_release' if appropriate)\n8. ⏳ Complete task\n\n🧪 Run your test command and record the results using 'run_tests'."
  );
}

export async function handleSkipTests(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ No active task. Use 'start_task' before skipping tests.");
  }

  if (!workflowState.state.bugFixed) {
    return textResponse("⚠️ Please mark your feature/bug as fixed first using 'mark_bug_fixed'!");
  }

  const reason = typeof args.reason === "string" ? args.reason.trim() : "";

  if (!reason) {
    return textResponse("⚠️ Provide a non-empty justification when skipping tests.");
  }

  workflowState.state.testsCreated = true;
  workflowState.state.testsPassed = true;
  workflowState.state.testsSkipped = true;
  workflowState.state.testsSkippedReason = reason;
  workflowState.state.currentPhase = "documentation";
  workflowState.state.readyToCommit = false;
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.released = false;
  workflowState.state.releaseSkipped = false;
  workflowState.state.releaseSkippedReason = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";
  await workflowState.save();

  return textResponse(
    `⚠️ Tests skipped for this task.
Reason: ${reason}

Manual verification is now required.

Next Steps:
1. ✓ Fix/implement feature
2. ⚠️ Tests skipped (ensure manual QA)
3. ⏳ Create/update documentation
4. ⏳ Run 'check_ready_to_commit'
5. ⏳ Run 'commit_and_push'
6. ⏳ Run 'perform_release' or 'skip_release'
7. ⏳ Complete task`
  );
}

export async function handleRunTests(args, workflowState) {
  if (!workflowState.state.bugFixed) {
    return textResponse("⚠️ Please mark your feature/bug as fixed first using 'mark_bug_fixed'!");
  }

  if (!workflowState.state.testsCreated) {
    return textResponse("⚠️ Please create tests first using 'create_tests' before recording test results!");
  }

  if (
    typeof args.passed !== "boolean" ||
    typeof args.testCommand !== "string" ||
    args.testCommand.trim() === ""
  ) {
    return textResponse(
      "⚠️ Please provide both 'passed' (boolean) and 'testCommand' (non-empty string) when recording test results."
    );
  }

  workflowState.state.testsPassed = args.passed;
  workflowState.state.testCommand = args.testCommand;
  workflowState.state.testDetails = typeof args.details === "string" ? args.details : "";
  workflowState.state.activeBuild = normalizeBuildState(
    {
      status: args.passed ? "succeeded" : "failed",
      target: workflowState.state.activeBuild?.target || "Test Suite Execution",
      command: args.testCommand,
      machine: args.buildHost || process.env.DEVWF_BUILD_HOST || workflowState.state.machine || os.hostname(),
      stage: args.passed ? "All tests passed" : "Tests failed",
      progress: args.passed ? 100 : workflowState.state.activeBuild?.progress ?? null,
      output: typeof args.details === "string" ? args.details : "",
    },
    workflowState.state.activeBuild,
  );
  workflowState.state.testsSkipped = false;
  workflowState.state.testsSkippedReason = "";
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.released = false;
  workflowState.state.releaseSkipped = false;
  workflowState.state.releaseSkippedReason = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";

  if (!args.passed) {
    workflowState.state.currentPhase = "testing";
    await workflowState.save();

    return textResponse(
      `❌ TESTS FAILED!\n\n🚫 STOP! DO NOT COMMIT OR PUSH!\n\nYou must:\n1. Fix the failing tests\n2. Run tests again until they pass\n\nTest command: ${args.testCommand}\n\nNever skip or ignore failing tests!`
    );
  }

  workflowState.state.currentPhase = "documentation";
  await workflowState.save();

  await reportEventSafe(workflowState.state, "tests_passed", args.testCommand, workflowState._sessionKey().key);

  return textResponse(
    `✅ All tests passed! 🎉\n\nTest command: ${args.testCommand}\n\n📝 Now create or update documentation using 'create_documentation' with:\n- documentationType: "PRD", "README", "RELEASE_NOTES", "inline-comments", "API-docs", "changelog", or "other"\n- summary: Brief description of what was documented\n\nNext Steps:\n1. ✓ Fix/implement feature\n2. ✓ Create tests\n3. ✓ Run tests (GREEN!)\n4. ⏳ Create/update documentation\n5. ⏳ Run 'check_ready_to_commit'\n6. ⏳ Run 'commit_and_push'\n7. ⏳ Run 'perform_release' (or use 'skip_release' if no release is needed)\n8. ⏳ Complete task`
  );
}

/**
 * Ganti rencana task yang sedang berjalan.
 *
 * Dipakai saat rencana awal ternyata salah setelah ditelusuri. Langkah yang
 * sudah ditandai selesai dipertahankan bila teksnya sama, supaya mengganti
 * rencana tidak menghapus progres yang sudah nyata.
 */
export async function handleSetPlan(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Belum ada task aktif. Mulai dengan 'start_task' sebelum menyusun rencana.");
  }

  const check = validatePlanSteps(args.steps);
  if (!check.ok) {
    return textResponse(`⚠️ ${check.error}\n\nRencana lama tidak diubah.`);
  }

  const previous = normalizePlan(workflowState.state.plan);
  const doneTexts = new Set(
    previous.filter((item) => item.status === "done").map((item) => item.text.toLowerCase()),
  );

  const next = createPlan(check.items).map((item) =>
    doneTexts.has(item.text.toLowerCase()) ? { ...item, status: "done" } : item,
  );

  workflowState.state.plan = next;
  await workflowState.save();

  return textResponse(`✅ Rencana diperbarui.\n\n${renderPlanFull(next)}`);
}

/**
 * Tandai satu langkah rencana sebagai selesai (atau buka kembali).
 *
 * Idempoten: menandai ulang langkah yang sudah selesai tidak mengubah apa pun.
 * Membuka kembali berguna saat langkah yang dikira selesai ternyata belum.
 */
export async function handleMarkPlanStep(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Belum ada task aktif.");
  }

  const plan = normalizePlan(workflowState.state.plan);
  if (plan.length === 0) {
    return textResponse(
      "⚠️ Task ini belum punya rencana. Isi dengan 'set_plan' { steps: [...] } lebih dulu."
    );
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  const item = plan.find((entry) => entry.id === id);
  if (!item) {
    return textResponse(
      `⚠️ Tidak ada langkah ber-id "${id}".\n\n${renderPlanFull(plan)}`
    );
  }

  const status = args.status === "open" ? "open" : "done";
  workflowState.state.plan = plan.map((entry) =>
    entry.id === id ? { ...entry, status, updatedAt: new Date().toISOString() } : entry,
  );
  await workflowState.save();

  // Peristiwa dikirim SESUDAH simpan berhasil: kalau simpan gagal, dashboard
  // tidak boleh mencatat langkah yang tidak pernah tercapai.
  await reportEventSafe(
    workflowState.state,
    status === "done" ? "step_done" : "step_reopened",
    `${id}: ${item.text}`,
  );

  const progress = planProgress(workflowState.state.plan);
  return textResponse(
    `${status === "done" ? "✅" : "↩️"} Langkah ${id} ${status === "done" ? "selesai" : "dibuka kembali"}: ${item.text}\n\n` +
      `${renderPlanFull(workflowState.state.plan)}\n\n` +
      `Progres: ${progress.done}/${progress.total}` +
      (progress.next ? ` — berikutnya: ${progress.next.text}` : " — semua langkah selesai")
  );
}

export async function handleCreateDocumentation(args, workflowState, context = {}) {
  if (!workflowState.state.testsPassed) {
    return textResponse("⚠️ Please ensure tests are passing first! Run 'run_tests' with passed=true.");
  }

  if (!ensurePrdExists()) {
    return textResponse(
      `⚠️ PRD file not found!\n\nExpected location: docs/PRD.md\n\nPlease create or update the PRD before marking documentation as complete.`
    );
  }

  // `files` diverifikasi terhadap working tree. Tanpa ini, langkah dokumentasi
  // kembali menjadi klaim: `documentationType: "inline-comments"` dulu cukup
  // untuk menutupnya, dan README tidak pernah tersentuh.
  const requested = Array.isArray(args.files)
    ? args.files.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];

  const inputs = await loadDocGateInputs({ workflowState, git: context.git });
  const changed = new Set(inputs.changedPaths.map(pathKey));

  if (requested.length > 0) {
    const notDocumentation = requested.filter((p) => !isDocumentationPath(p));
    if (notDocumentation.length > 0) {
      return textResponse(
        `⚠️ Dibatalkan: ini bukan berkas dokumentasi: ${notDocumentation.join(", ")}\n\n` +
          `Berkas dokumentasi adalah README*, CHANGELOG*, CONTRIBUTING*, apa pun di bawah ` +
          `docs/ atau doc/, serta berkas .md/.mdx/.rst/.adoc di luar direktori tes.`
      );
    }

    const missing = requested.filter((p) => !changed.has(pathKey(p)));
    if (missing.length > 0) {
      const actual = inputs.changedPaths.length > 0
        ? inputs.changedPaths.map((p) => `   • ${p}`).join("\n")
        : "   (tidak ada perubahan sama sekali)";
      return textResponse(
        `⚠️ Dibatalkan: berkas ini disebut sebagai dokumentasi tetapi tidak muncul ` +
          `sebagai perubahan di working tree: ${missing.join(", ")}\n\n` +
          `Yang benar-benar berubah sekarang:\n${actual}\n\n` +
          `Sebutkan path relatif terhadap akar repo (contoh: "README.md"), bukan path absolut. ` +
          `Perbarui berkasnya lebih dulu, lalu sebut ulang. ` +
          `Kalau dokumentasi memang tidak perlu diubah, pakai 'waive_documentation' { reason }.\n\n` +
          `Tidak ada state yang diubah.`
      );
    }
  }

  const gate = evaluateDocGate({
    changedPaths: inputs.changedPaths,
    dirtyAtStart: inputs.dirtyAtStart,
    declaredFiles: requested.length > 0 ? requested : inputs.declaredFiles,
    hasDocumentation: inputs.hasDocumentation,
    waived: Boolean(workflowState.state.documentationWaived),
  });

  workflowState.state.documentationCreated = true;
  workflowState.state.documentationType = args.documentationType;
  workflowState.state.documentationSummary = args.summary;
  // Hanya ditimpa bila `files` benar-benar dikirim. Panggilan kedua tanpa
  // `files` (atau lewat run_full_workflow dengan daftar kosong) tidak boleh
  // menghapus bukti yang sudah terverifikasi sebelumnya.
  if (requested.length > 0) {
    workflowState.state.documentationFiles = requested;
  }
  workflowState.state.currentPhase = "ready";
  workflowState.state.readyToCommit = true;
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.released = false;
  workflowState.state.releaseSkipped = false;
  workflowState.state.releaseSkippedReason = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";
  await workflowState.save();

  // Pesan sukses WAJIB diawali ✅. `isErrorResponse` memperlakukan awalan ⚠️
  // sebagai kegagalan, dan `run_full_workflow` akan berhenti di langkah ini.
  const gateNote = isGateSatisfied(gate.status)
    ? requested.length > 0
      ? `✅ Gerbang dokumentasi terpenuhi oleh: ${requested.join(", ")}`
      : `✅ Gerbang dokumentasi terpenuhi (${gate.status}).`
    : `⚠️ Gerbang dokumentasi belum terpenuhi: ${gate.sourceChanged.length} berkas source ` +
      `berubah tanpa berkas dokumentasi.\n` +
      `   'check_ready_to_commit' akan menolak sampai Anda memakai 'files: [...]' ` +
      `atau 'waive_documentation'.`;

  return textResponse(
    `✅ Documentation created/updated!\n\n` +
      `Type: ${args.documentationType}\nSummary: ${args.summary}\n` +
      (requested.length > 0 ? `Files: ${requested.join(", ")}\n` : "") +
      `✅ PRD check: docs/PRD.md ada di paket MCP (bukan di repo proyek).\n` +
      `${gateNote}\n\n` +
      `🎉 You're ready to verify your work!\n\n` +
      `Next Steps:\n` +
      `1. ✓ Fix/implement feature\n` +
      `2. ✓ Create tests\n` +
      `3. ✓ Run tests (GREEN!)\n` +
      `4. ✓ Create/update documentation\n` +
      `5. ⏳ Run 'check_ready_to_commit' to verify\n` +
      `6. ⏳ Run 'commit_and_push'\n` +
      `7. ⏳ Run 'perform_release' (or 'skip_release' when applicable)\n` +
      `8. ⏳ Mark as complete with 'complete_task'`
  );
}

/**
 * Kecualikan gerbang dokumentasi dengan alasan tertulis.
 *
 * Waiver adalah KEPUTUSAN, bukan jalan pintas: alasannya ikut ke entri history,
 * ke laporan commit, dan ke rekomendasi sesi berikutnya. Pola me-waive setiap
 * task jadi terlihat, bukan tersembunyi.
 */
export async function handleWaiveDocumentation(args, workflowState) {
  if (!workflowState.state.testsPassed && !workflowState.state.testsSkipped) {
    return textResponse(
      "⚠️ Selesaikan langkah tes lebih dulu (run_tests dengan passed=true, atau skip_tests), " +
        "sebelum mengecualikan gerbang dokumentasi."
    );
  }

  const reason = typeof args.reason === "string" ? args.reason.trim() : "";

  if (reason.length < MIN_WAIVER_REASON) {
    return textResponse(
      `⚠️ Dibatalkan: alasan waiver minimal ${MIN_WAIVER_REASON} karakter.\n\n` +
        `Tulis KENAPA dokumentasi tidak perlu diubah, bukan sekadar "tidak perlu". ` +
        `Alasan ini masuk history dan akan terbaca lagi di sesi berikutnya.`
    );
  }

  if (reason.length > MAX_WAIVER_REASON) {
    return textResponse(
      `⚠️ Dibatalkan: alasan waiver maksimal ${MAX_WAIVER_REASON} karakter; dikirim ${reason.length}.`
    );
  }

  workflowState.state.documentationWaived = true;
  workflowState.state.documentationWaiverReason = reason;
  workflowState.state.readyCheckCompleted = false;
  await workflowState.save();

  return textResponse(
    `✅ Gerbang dokumentasi dikecualikan untuk task ini.\n\n` +
      `Alasan: ${reason}\n\n` +
      `Alasan ini dicatat di history, disebut di laporan commit, dan muncul di rekomendasi ` +
      `sesi berikutnya. Lanjutkan dengan 'check_ready_to_commit'.`
  );
}

export async function handleRecommendMcpTools(args = {}, workflowState) {
  const state = workflowState?.state || {};
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const projectDir =
    typeof args.projectDir === "string" && args.projectDir.trim() !== ""
      ? args.projectDir.trim()
      : state.projectDir || "";
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 4;

  const result = recommendMcpTools({
    query,
    description: state.taskDescription || "",
    projectDir,
    definitionOfDone: state.definitionOfDone || [],
    plan: state.plan || [],
    limit,
  });

  if (args.includeAll) {
    return textResponse(formatFullMcpCatalog(query ? result : null));
  }

  return textResponse(formatMcpRecommendations(result));
}

export async function handleReportBuildStatus(args = {}, workflowState) {
  if (!args || typeof args.target !== "string" || args.target.trim() === "") {
    return textResponse("⚠️ Please provide a non-empty 'target' describing what is being built.");
  }

  const prev = workflowState.state.activeBuild || null;
  const buildInput = {
    ...args,
    machine: args.buildHost || args.machine || process.env.DEVWF_BUILD_HOST || workflowState.state.machine || os.hostname(),
  };
  const next = normalizeBuildState(buildInput, prev);
  workflowState.state.activeBuild = next;

  if (!Array.isArray(workflowState.state.buildHistory)) {
    workflowState.state.buildHistory = [];
  }
  if (next.status === "succeeded" || next.status === "failed") {
    workflowState.state.buildHistory = [
      ...workflowState.state.buildHistory.slice(-9),
      next,
    ];
  }

  await workflowState.save();

  const eventKind =
    next.status === "succeeded"
      ? "build_succeeded"
      : next.status === "failed"
        ? "build_failed"
        : prev && prev.status === next.status
          ? "build_progress"
          : "build_started";

  await reportEventSafe(workflowState.state, eventKind, JSON.stringify(next), workflowState._sessionKey().key);

  const block = formatBuildStatusBlock(next, workflowState.state.buildHistory);
  // A build card without a URL is a dead end: the reader can see that something
  // ran but cannot open it. Say so at the moment the report is made, while the
  // caller still has the pipeline page in hand.
  const urlHint = next.jobUrl
    ? ''
    : '\n\nNo job URL recorded, so the monitor card has no link. Pass `jobUrl` ' +
      '(the pipeline or job page) when the build runs in CI.';
  return textResponse(`? Build status recorded!\n\n${block}${urlHint}`);
}




/**
 * The commit this task started from.
 *
 * Recorded at start_task so the commits a session makes can be listed exactly
 * (`rev-list base..HEAD`) instead of guessed from timestamps, which skip rebased
 * commits. A directory that is not a git repo yields null -- the session still
 * works, it simply has no revert record.
 */
async function resolveBaseSha(projectDir) {
  if (!projectDir) return null;
  try {
    const { stdout } = await exec(`git -C ${JSON.stringify(projectDir)} rev-parse HEAD`);
    const sha = stdout.trim();
    return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
