/**
 * @zettly-code DWF-TOOL-PROFILES-009
 * @purpose Emit lifecycle next-step lists that only reference tools registered in the active profile.
 */
import { existsSync } from "node:fs";
import { classify } from '../../security/policy.js';
import { sanitize } from '../../security/sanitizer.js';
import { resolveInitialGovernance, loadPolicies, normalizeRepoSlug } from "../../governance/engine.js";
import { textResponse, isReleaseSatisfied, isErrorResponse, ensurePrdExists, loadDocGateInputs } from "./shared.js";
import { getToolProfile, isToolAllowedInProfile } from "../../src/tool-profiles.js";
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
import { runPreflight } from "../../preflight.js";
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
 * Record the project repository for this session.
 *
 * Without this, the only authority is the global WORKFLOW_PROJECT_DIR.
 * On this machine its value is `D:\code\clinic`, so a task that actually works in
 * another repo still runs git in clinic and `commit_and_push` answers
 * "No changes detected" as if it were already done (30 October 2026).
 *
 * Best-effort: when the repo cannot be determined, the task may still start, but
 * the user is told so they are not surprised at commit time.
 */
/**
 * Resolve and validate the project directory before touching workflow state.
 *
 * Owner rule (10 November 2026): a task without a project is not allowed. Every
 * task MUST belong to a real Git repository so the monitor never displays or
 * recaps "(without a project)".
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
        `⚠️ Refused: the project repo is not determined yet (${error ? error.message : "empty projectDir"}).\n` +
        `   Dev Workflow MCP does not allow a task without a project.\n` +
        `   Pass 'projectDir' pointing to a Git repository (e.g. "D:\\\\code\\\\clinic") on 'start_task'.\n\n` +
        `Task NOT started; the previous workflow was not changed.`,
    };
  }

  const sourceNote = {
    explicit: "dari argumen projectDir",
    cwd: "from the session working directory",
    env: "from WORKFLOW_PROJECT_DIR (global value)",
    pinned: "from the session projectDir",
  }[resolved.source] || resolved.source;

  let message = `📁 Repo proyek: ${resolved.dir} (${sourceNote})`;

  // An env source means there is no per-session signal at all. When the session
  // directory turns out to point at ANOTHER repo, this env value almost certainly belongs to another project -
  // and that is exactly what used to make `git add .` run in the wrong repo.
  if (resolved.conflict) {
    message +=
      `\n   ⚠️ CONFLICT: the session directory points at another repo, ${resolved.conflict.cwdDir}.` +
      `\n   The repo was chosen from WORKFLOW_PROJECT_DIR. If this task is for the session repo,` +
      `\n   repeat 'start_task' with projectDir: "${resolved.conflict.cwdDir}".`;
  } else if (resolved.source === "env") {
    message +=
      `\n   ⚠️ This repo comes from WORKFLOW_PROJECT_DIR, not from the session.` +
      `\n   If this task works in another repo, repeat 'start_task' with the correct projectDir.`;
  }

  return { ok: true, dir: resolved.dir, message };
}

/**
 * List of files that were already dirty before the task started.
 *
 * A git failure here must not fail `start_task`: the baseline is only
 * used to warn at commit time, and a task without a baseline is still valid
 * (the previous behaviour).
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
      (isToolAllowedInProfile("acknowledge_handover")
        ? `If this machine should resume locally, call 'acknowledge_handover' first.`
        : `This profile cannot claim the handover; set DEVWF_TOOL_PROFILE=full to resume it on this machine.`)
    );
  }
  // One writer per repo.
  //
  // On 31 October 2026 two OpenCode sessions wrote to the same working tree. One
  // session lost every edit in `tools/handler-modules/index.js`
  // without any message: the file reverted to its HEAD version mid-work.
  // A process marker already existed, but it was only RECORDED as a
  // warning, so nothing stopped the collision.
  //
  // Plan validation. The schema requires `plan`; when the agent does not send it,
  // a TEMPORARY plan is derived from the DoD so progress stays readable,
  // and the reply states plainly that the order is not yet correct.
  const planCheck = validatePlanSteps(args.plan);
  let planDerived = false;

  if (!planCheck.ok) {
    if (args.plan !== undefined) {
      return textResponse(
        `⚠️ ${planCheck.error}\n\n` +
          `Contoh pemakaian:\n` +
          `  plan: ["explore the existing handlers", "write the failing test", "minimal implementation"]\n\n` +
          `Task NOT started; the previous workflow was not changed.`
      );
    }
    planDerived = true;
  }

  // Validate the DoD BEFORE touching any state. A rejected task must not
  // replace the running task, and must not leave a half-finished
  // state that makes `get_workflow_status` confusing.
  const dodCheck = validateItemTexts(args.definitionOfDone);
  if (!dodCheck.ok) {
    return textResponse(
      `⚠️ ${dodCheck.error}\n\n` +
        `Contoh pemakaian:\n` +
        `  definitionOfDone: ["build passes", "login page verified"]\n\n` +
        `Task NOT started; the previous workflow was not changed.`
    );
  }

  // Validate projectDir BEFORE reset(): a task without a project is rejected outright.
  const project = resolveTaskProject(args);
  if (!project.ok) {
    return textResponse(project.message);
  }

  // Resolve the target project identity and the target state file BEFORE lock validation.
  // This prevents false collisions when two MCP clients (e.g. Antigravity and Codex)
  // start in a shared working directory (C:\Users\mahardhika) but target
  // different project repositories.
  const targetResolution = resolveTargetProjectState({
    stateFile: workflowState.stateFile,
    projectDir: project.dir,
    skipWrites: true,
  });
  const targetStateFile = targetResolution.stateFile;
  const targetLockDir = projectLockDir(targetStateFile);

  // A LIVE task owned by another process must not be deleted, even with `force`.
  // findActiveForeignTaskInProject inspects the state on disk for the target project.
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
      const disk = await workflowState.readDiskState({ skipWrites: true });
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
      : "time unknown";

    return textResponse(
      `⚠️ Refused: another task is running in MCP process PID ${foreignTask.ownerPid}.\n\n` +
        `Task      : "${foreignTask.description}"\n` +
        `Phase     : ${foreignTask.phase}\n` +
        `Owner     : PID ${foreignTask.ownerPid}, last wrote state ${seen}\n\n` +
        `Starting a new task here would clear that task's Definition of Done, and its evidence ` +
        `cannot be recovered from history. That is why 'force' CANNOT bypass this guard ` +
        `while the owner is still writing.\n\n` +
        `Choose one:\n` +
        `  1. Finish or cancel that task from its owner session (complete_task / drop_task).\n` +
        `  2. Give this session its own worktree: opencode.worktree_create, then run the session there.\n` +
        `  3. If that process is no longer used, close its window. The guard stops blocking ` +
        `after ${Math.round(DEFAULT_LOCK_STALE_MS / 60000)} minutes without a state write.\n\n` +
        `Task NOT started; no state was changed.`
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
        `⚠️ Refused: failed to acquire the OS kernel mutex for "${project.dir}" ` +
          `(${targetMutex.error || "MUTEX_ERROR"}).\n\n` +
          `Exclusive ownership cannot be verified (fail-closed).\n` +
          `Task NOT started; no state was changed.`
      );
    }
    return textResponse(
      `⚠️ Refused: another session holds the OS kernel mutex for this working tree.\n\n` +
        `Mutex endpoint: ${targetMutex.endpoint || project.dir}\n` +
        `Two sessions on one working tree are forbidden in Option B; the kernel mutex is only ` +
        `released when the owner session finishes or its process stops.\n\n` +
        `Task NOT started; no state was changed.`
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
        `⚠️ Refused: the process lock status for this project cannot be verified closed ` +
          `(${legacyWriter.reason || legacyWriter.error || "LOCK_INSPECTION_FAILED"}).\n\n` +
          `Exclusive ownership refuses to continue when lock metadata is corrupt or unreadable (fail-closed).\n` +
          `Task NOT started; no state was changed.`
      );
    }
    const isGenuineLegacy = isLegacyLock(legacyWriter) || legacyWriter.kernelMutex === false;
    if (isGenuineLegacy) {
      return textResponse(
        `⚠️ Refused: a live legacy protocol writer (v1) was detected on this project ` +
          `(PID ${legacyWriter.pid || "unknown"}).\n\n` +
          `Option B refuses to work alongside an old process that does not hold the OS kernel mutex.\n` +
          `Restart the old MCP client first before starting a task in this working tree.\n\n` +
          `Task NOT started; no state was changed.`
      );
    }
    return textResponse(
      `⚠️ Refused: another session is working on this project ` +
        `(PID ${legacyWriter.pid || "unknown"}).\n\n` +
        `Two sessions on one project are forbidden; wait for the other session to finish or close its process first.\n\n` +
        `Task NOT started; no state was changed.`
    );
  }

  // Also check shared state root for any live legacy v1 writers in unpinned buckets (R2-5).
  const projectsParent = path.dirname(targetLockDir);
  if (path.basename(projectsParent) === "projects") {
    const stateBase = path.dirname(projectsParent);
    if (existsSync(stateBase)) {
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
          `⚠️ Refused: the quiescence check failed closed ` +
            `(${errItem.reason || errItem.error || "QUIESCENCE_INSPECTION_FAILED"}).\n\n` +
            `The directory or lock metadata cannot be inspected in full (fail-closed).\n` +
            `Task NOT started; no state was changed.`
        );
      }
      if (quiescence.legacyWriters.length > 0) {
        if (!targetMutex.alreadyHeld) {
          await releaseWorktreeMutex(targetMutex.capability);
        }
        const w = quiescence.legacyWriters[0];
        return textResponse(
          `⚠️ Refused: a live legacy protocol writer (v1) was detected on this project ` +
            `(PID ${w.pid || "unknown"}).\n\n` +
            `Option B refuses to work alongside an old process that does not hold the OS kernel mutex.\n` +
            `Restart the old MCP client first before starting a task in this working tree.\n\n` +
            `Task NOT started; no state was changed.`
        );
      }
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

  // README-first preflight: bounded, read-only discovery of the repository's
  // own instructions and documented CLI entrypoints. The record is persisted
  // with the task so resume_session can revalidate it and the scope guard can
  // compare against it. Documents are untrusted content; nothing is executed.
  let preflight;
  try {
    preflight = runPreflight({
      projectDir: project.dir,
      taskId: workflowState.state.workflowTaskId || "",
      taskDescription: args.description,
    });
  } catch (err) {
    if (!targetMutex.alreadyHeld) {
      await releaseWorktreeMutex(targetMutex.capability);
    }
    return textResponse(
      `⚠️ Task not started: PREFLIGHT_ERROR (${err?.message || String(err)}). The project directory could not be read as a repository root.`
    );
  }
  if (!preflight.ok) {
    if (!targetMutex.alreadyHeld) {
      await releaseWorktreeMutex(targetMutex.capability);
    }
    return textResponse(
      `⚠️ Task not started: ${preflight.code}. The project directory could not be read as a repository root.`
    );
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

  const rollbackPreCommit = async (reason) => {
    let focusRollbackError = null;
    if (claimedNewFocus && hasRequestedFocus) {
      try {
        const retireRes = await retireFocusBinding({
          stateFile: targetStateFile,
          focusId: requestedFocusId,
          projectDir: project.dir,
          repoKey: requestedRepoKey,
          reason,
          kernelCapability: targetMutex.capability,
          requireKernelMutex: true,
          expectedOwnerKey: sessionOwnerKey,
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
    workflowState.stateFile = priorStateFile;
    workflowState.historyFile = priorHistoryFile;
    workflowState.stateVersion = priorStateVersion;
    workflowState.loadedTask = priorLoadedTask;
    if (focusRollbackError) {
      workflowState.state.pendingFocusCleanup = {
        focusId: requestedFocusId,
        stateFile: targetStateFile,
        projectDir: project.dir,
        repoKey: requestedRepoKey,
        error: focusRollbackError,
        failedAt: new Date().toISOString(),
      };
      const rollbackCap = priorStateFile === targetStateFile ? targetMutex.capability : priorKernelCapability;
      if (rollbackCap && typeof workflowState.save === "function") {
        try {
          if (typeof workflowState.bindKernelCapability === "function") {
            workflowState.bindKernelCapability(rollbackCap);
          }
          await workflowState.save({ operation: "pending_focus_cleanup_persist" });
        } catch {
          // Best-effort persistence: in-memory pendingFocusCleanup remains set.
        }
      }
    }
    if (typeof workflowState.bindKernelCapability === "function") {
      workflowState.bindKernelCapability(priorKernelCapability);
    }
    workflowState.requireKernelMutex = priorRequireKernelMutex;
    setActiveProjectDir(priorActiveProjectDir);
    if (!targetMutex.alreadyHeld) {
      await releaseWorktreeMutex(targetMutex.capability);
    }
    return focusRollbackError;
  };

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

        const pendingCleanup = workflowState.state?.pendingFocusCleanup;
        if (pendingCleanup && Number.isSafeInteger(Number(pendingCleanup.focusId)) && Number(pendingCleanup.focusId) > 0) {
          try {
            const pendingDir = pendingCleanup.projectDir || project.dir;
            const retiredPending = await retireFocusBinding({
              stateFile: pendingCleanup.stateFile || workflowState.stateFile,
              focusId: Number(pendingCleanup.focusId),
              projectDir: pendingDir,
              repoKey: pendingCleanup.repoKey || (pendingDir === project.dir ? requestedRepoKey : ""),
              kernelCapability: pendingDir === project.dir ? targetMutex.capability : null,
              requireKernelMutex: true,
              expectedOwnerKey: sessionOwnerKey,
            });
            if (retiredPending && retiredPending.ok !== false) {
              delete workflowState.state.pendingFocusCleanup;
            }
          } catch {
            // Keep pendingFocusCleanup recorded for next retry if retirement still fails
          }
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

        // Rescue the work that might be overwritten first.
        preservedBeforeSave = await workflowState.reconcileWithDisk();
        const previousTaskIdentity = {
          taskDescription: workflowState.state.taskDescription,
          projectDir: workflowState.state.projectDir,
          workflowTaskId: workflowState.state.workflowTaskId,
          zettly: workflowState.state.zettly,
          taskOrigin: workflowState.state.taskOrigin,
        };
        const remainingPendingFocusCleanup = workflowState.state?.pendingFocusCleanup || null;
        const resetResult = workflowState.reset({ archive: true });
        archivedTask = resetResult.archivedTask;
        if (remainingPendingFocusCleanup) {
          workflowState.state.pendingFocusCleanup = remainingPendingFocusCleanup;
        }

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
        workflowState.state.dodRevision = 0;
        workflowState.state.preflight = preflight;
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

        workflowState.state.governance = resolveInitialGovernance({
          repository: requestedIdentity.remote || project.dir,
          taskType: args.type,
          description: workflowState.state.taskDescription || args.description || "",
          governanceMode: "",
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
        const postCommitProjectionErrors = Array.isArray(workflowState._lastPostCommitProjectionErrors)
          ? [...workflowState._lastPostCommitProjectionErrors]
          : [];
        if (workflowState._lastExportJsonOk === false && !postCommitProjectionErrors.includes("exportJson:EXPORT_RETURNED_FALSE")) {
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
      await rollbackPreCommit("rollback_on_transition_refusal");
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
            if (typeof workflowState.writeHistoryFile === "function") {
              try {
                await workflowState.writeHistoryFile();
              } catch (err) {
                repairErrors.push(`summaryOrHistory:${err?.message || String(err)}`);
              }
            }
            if (typeof workflowState.updateProjectSummary === "function") {
              try {
                await workflowState.updateProjectSummary();
              } catch (err) {
                repairErrors.push(`summaryOrHistory:${err?.message || String(err)}`);
              }
            }
            if (typeof workflowState._syncHistoryToDatabase === "function") {
              try {
                const histRes = await workflowState._syncHistoryToDatabase();
                if (histRes?.skipped > 0) {
                  repairErrors.push(`syncHistoryDb:SKIPPED_${histRes.skipped}`);
                }
                if (histRes?.summaryFailed) {
                  repairErrors.push(`syncHistorySummary:${histRes.summaryError || "FAILED"}`);
                }
              } catch (err) {
                repairErrors.push(`syncHistoryDb:${err?.message || String(err)}`);
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
        if (typeof workflowState.save === "function") {
          try {
            await workflowState.save({ operation: "persist_transition_projection_repair" });
          } catch {
            // Best-effort persistence when projections are degraded.
          }
        }
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
      const focusRollbackError = await rollbackPreCommit("rollback_on_transition_failure");

      if (focusRollbackError) {
        return textResponse(
          `⚠️ Refused before the SQLite commit (${transitionError?.message || String(transitionError)}), ` +
            `but cleanup of the focus binding #${requestedFocusId} FAILED (${focusRollbackError}) — rollback is NOT COMPLETE.\n\n` +
            `The previous workflow state and session pointer were restored and the pending cleanup evidence ` +
            `(pendingFocusCleanup) telah dicatat.`
        );
      }

      return textResponse(
        `⚠️ Refused: the transition to project "${project.dir}" failed before the SQLite commit ` +
          `(${transitionError?.message || String(transitionError)}).\n\n` +
          `All workflow state, session pointers, focus bindings, and process locks were ` +
          `restored to the condition before 'start_task' was called.`
      );
    }
  }

  // Sync the AI session title (OpenCode / Monitor) to the new task description
  try {
    const sKey = (typeof workflowState._sessionKey === "function" ? workflowState._sessionKey()?.key : "") || workflowState.sessionId || "";
    if (sKey && typeof updateSessionTitle === "function") {
      updateSessionTitle(sKey, args.description);
    }
  } catch {
    // Best effort: a session naming failure must not disturb start_task
  }

  await reportEventSafe(
    workflowState.state,
    "task_started",
    `${workflowState.state.taskDescription} (${workflowState.state.taskType}, ${workflowState.state.plan.length} langkah)`,
  );

  const preservedForeign = reconciled?.preservedTask || preservedBeforeSave?.preservedTask;
  if (preservedForeign) {
    warnings.push(
      `⚠️ A task is RUNNING from another agent process and was almost overwritten:\n` +
        `   "${preservedForeign}"\n` +
        `   That task was saved to history as 'interrupted', not deleted.\n` +
        `   The workflow state on this machine is shared between sessions - check before committing.`
    );
  }
  if (archivedTask) {
    warnings.push(
      `ℹ️ The previous task was not finished and was replaced: "${archivedTask}".\n` +
        `   Disimpan ke history sebagai 'interrupted'.`
    );
  }
  if (reconciled?.mergedHistory > 0) {
    warnings.push(
      `ℹ️ ${reconciled.mergedHistory} history entries from another process were merged, not overwritten.`
    );
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
        `\n\n⚠️ FLOW NOT YET VISIBLE IN THE MONITOR: ${drawing.note}\n` +
        `   Run 'create_feature_flow' now (before writing code) so the context is complete. ` +
        `Every tool reply will remind you until the drawing exists.`
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

  const preflightBlock = (() => {
    const record = workflowState.state.preflight;
    if (!record || !record.ok) return "";
    const readme = record.readme ? `README: ${record.readme.path}` : "README: MISSING";
    const agents = record.agents.length > 0
      ? `AGENTS: ${record.agents.map((a) => a.path).join(", ")}`
      : "AGENTS: none found";
    const cli = record.cli.length > 0
      ? `CLI: ${record.cli.slice(0, 5).map((c) => c.invocation).join(", ")}${record.cli.length > 5 ? ` (+${record.cli.length - 5} more)` : ""}`
      : "CLI: none documented";
    const summary = record.instructionSummary?.text
      ? `\n\n   ${record.instructionSummary.text.split("\n").join("\n   ")}`
      : "";
    const fingerprint = record.preflightFingerprint || record.readme?.fingerprint || "n/a";
    return `\n\n📖 Preflight (bounded, read-only):\n   ${readme}\n   ${agents}\n   ${cli}${summary}\n   Fingerprint: ${fingerprint}\n   Evidence: ${record.preflightAt} · ${record.verification}`;
  })();

  return textResponse(
    `✅ Task Started: ${args.description}\n\n${project.message}${warningBlock}${claimBlock}${drawNote}\n\n` +
      cliTip +
      `📋 Definition of Done (${workflowState.state.definitionOfDone.length} items, all still open):\n${dodLines}\n` +
      `   Prove each item with 'mark_dod_item' { id, evidence } once it is genuinely proven` +
      (isToolAllowedInProfile("waive_dod_item")
        ? `,\n   or exclude it with 'waive_dod_item' { id, reason } when it is truly irrelevant.\n\n`
        : `.\n   DoD waivers are not available in the active profile; set DEVWF_TOOL_PROFILE=full if an item is genuinely irrelevant.\n\n`) +
      (planDerived
        ? `⚠️ 'plan' was not sent, so a TEMPORARY plan was derived from the DoD.\n` +
          `   Its order is not necessarily the correct working order. Send 'plan' on 'start_task',\n` +
          `   or rearrange it now with 'set_plan' { steps: [...] }.\n\n`
        : `${renderPlanFull(workflowState.state.plan)}\n\n`) +
      mcpBlock +
      preflightBlock +
      `🎯 Be conscious about what you're coding!\n\nWorkflow Steps:\n1. ✓ Start task & Zettly Draw flow recorded (current)\n2. ⏳ Refine feature flow with 'create_feature_flow' if needed\n3. ⏳ Fix/implement the feature\n4. ⏳ Prove each definition-of-done item\n5. ⏳ Create tests\n6. ⏳ Run tests (must pass!)\n7. ⏳ Create documentation\n8. ⏳ Run 'check_ready_to_commit'\n9. ⏳ Run 'commit_and_push' (commits and pushes)\n10. ⏳ ${isToolAllowedInProfile("skip_release") ? "Run 'perform_release' or 'skip_release' (when no release is needed)" : "Run 'perform_release'"}\n11. ⏳ Complete task\n12. ✓ Workflow closed\n\nReminder: Focus on writing clean, maintainable code!`
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
    `✅ Feature/Bug marked as fixed!\n\n⚠️ CRITICAL REMINDER: You MUST create tests now!\n\nNext Steps:\n1. ✓ Fix/implement feature\n2. ⏳ Create tests for: ${args.summary}\n3. ⏳ Run tests (must be green!)\n4. ⏳ Create documentation\n5. ⏳ Run 'check_ready_to_commit'\n6. ⏳ Run 'commit_and_push'\n7. ⏳ ${isToolAllowedInProfile("skip_release") ? "Run 'perform_release' (or 'skip_release' if no release applies)" : "Run 'perform_release'"}\n8. ⏳ Complete task\n\n🚫 DO NOT SKIP TESTING!`
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
    "✅ Tests recorded!\n\nNext Steps:\n1. ✓ Fix/implement feature\n2. ✓ Create tests\n3. ⏳ Run tests (must be green!)\n4. ⏳ Create documentation\n5. ⏳ Run 'check_ready_to_commit'\n6. ⏳ Run 'commit_and_push'\n7. ⏳ Run 'perform_release'" +
      (isToolAllowedInProfile("skip_release") ? " (or 'skip_release' if appropriate)" : "") +
      "\n8. ⏳ Complete task\n\n🧪 Run your test command and record the results using 'run_tests'."
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
6. ⏳ ${isToolAllowedInProfile("skip_release") ? "Run 'perform_release' or 'skip_release'" : "Run 'perform_release'"}
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
    `✅ All tests passed! 🎉\n\nTest command: ${args.testCommand}\n\n📝 Now create or update documentation using 'create_documentation' with:\n- documentationType: "PRD", "README", "RELEASE_NOTES", "inline-comments", "API-docs", "changelog", or "other"\n- summary: Brief description of what was documented\n\nNext Steps:\n1. ✓ Fix/implement feature\n2. ✓ Create tests\n3. ✓ Run tests (GREEN!)\n4. ⏳ Create/update documentation\n5. ⏳ Run 'check_ready_to_commit'\n6. ⏳ Run 'commit_and_push'\n7. ⏳ ${isToolAllowedInProfile("skip_release") ? "Run 'perform_release' (or use 'skip_release' if no release is needed)" : "Run 'perform_release'"}\n8. ⏳ Complete task`
  );
}

/**
 * Replace the plan of the running task.
 *
 * Used when the initial plan turns out to be wrong after investigation. Steps already
 * marked done are preserved when their text matches, so replacing the
 * plan does not delete real progress.
 */
export async function handleSetPlan(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ No active task yet. Start with 'start_task' before composing a plan.");
  }

  const check = validatePlanSteps(args.steps);
  if (!check.ok) {
    return textResponse(`⚠️ ${check.error}\n\nThe previous plan was not changed.`);
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
 * Mark one plan step as done (or reopen it).
 *
 * Idempotent: re-marking an already done step changes nothing.
 * Reopening is useful when a step believed done turns out not to be.
 */
export async function handleMarkPlanStep(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ No active task yet.");
  }

  const plan = normalizePlan(workflowState.state.plan);
  if (plan.length === 0) {
    return textResponse(
      "⚠️ This task has no plan yet. Fill it with 'set_plan' { steps: [...] } first."
    );
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  const item = plan.find((entry) => entry.id === id);
  if (!item) {
    return textResponse(
      `⚠️ No step with id "${id}".\n\n${renderPlanFull(plan)}`
    );
  }

  const status = args.status === "open" ? "open" : "done";
  workflowState.state.plan = plan.map((entry) =>
    entry.id === id ? { ...entry, status, updatedAt: new Date().toISOString() } : entry,
  );
  await workflowState.save();

  // The event is sent AFTER the save succeeds: if the save fails, the dashboard
  // must not record a step that was never reached.
  await reportEventSafe(
    workflowState.state,
    status === "done" ? "step_done" : "step_reopened",
    `${id}: ${item.text}`,
  );

  const progress = planProgress(workflowState.state.plan);
  return textResponse(
    `${status === "done" ? "✅" : "↩️"} Step ${id} ${status === "done" ? "done" : "reopened"}: ${item.text}\n\n` +
      `${renderPlanFull(workflowState.state.plan)}\n\n` +
      `Progres: ${progress.done}/${progress.total}` +
      (progress.next ? ` — next: ${progress.next.text}` : " — all steps done")
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

  // `files` is verified against the working tree. Without this, the documentation step
  // becomes a claim again: `documentationType: "inline-comments"` used to be enough
  // to close it, and the README was never touched.
  const requested = Array.isArray(args.files)
    ? args.files.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];

  const inputs = await loadDocGateInputs({ workflowState, git: context.git });
  const changed = new Set(inputs.changedPaths.map(pathKey));

  if (requested.length > 0) {
    const notDocumentation = requested.filter((p) => !isDocumentationPath(p));
    if (notDocumentation.length > 0) {
      return textResponse(
        `⚠️ Refused: these are not documentation files: ${notDocumentation.join(", ")}\n\n` +
          `Documentation files are README*, CHANGELOG*, CONTRIBUTING*, anything under ` +
          `docs/ or doc/, plus .md/.mdx/.rst/.adoc files outside test directories.`
      );
    }

    const missing = requested.filter((p) => !changed.has(pathKey(p)));
    if (missing.length > 0) {
      const actual = inputs.changedPaths.length > 0
        ? inputs.changedPaths.map((p) => `   • ${p}`).join("\n")
        : "   (no changes at all)";
      return textResponse(
        `⚠️ Refused: these files are declared as documentation but do not appear ` +
          `sebagai perubahan di working tree: ${missing.join(", ")}\n\n` +
          `What actually changed right now:\n${actual}\n\n` +
          `Sebutkan path relatif terhadap akar repo (contoh: "README.md"), bukan path absolut. ` +
          `Update the files first, then declare them again. ` +
          (isToolAllowedInProfile("waive_documentation")
            ? `If the documentation truly does not need changes, use 'waive_documentation' { reason }.\n\n`
            : `If the documentation truly does not need changes, set DEVWF_TOOL_PROFILE=full to use the recorded waiver path.\n\n`) +
          `No state was changed.`
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
  // Only overwritten when `files` is actually sent. A second call without
  // `files` (or through run_full_workflow with an empty list) must not
  // delete evidence that was already verified earlier.
  if (requested.length > 0) {
    workflowState.state.documentationFiles = requested;
  }
  if (workflowState.state.governance) {
    const policies = loadPolicies();
    const docPolicy = policies.policies["engineering.documentation_required"];
    const effectiveFiles = requested.length > 0 ? requested : (workflowState.state.documentationFiles || []);
    workflowState.state.governance.documentationEvidence = {
      status: "UPDATED",
      files: effectiveFiles,
      summary: args.summary || "",
      repository: workflowState.state.governance.repository || normalizeRepoSlug(workflowState.state.identityContract?.remote || ""),
      revision: Number(workflowState.state.dodRevision) || 0,
      policyVersion: docPolicy.version,
      policyDigest: policies.digest,
      recordedAt: new Date().toISOString(),
    };
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

  // The success message MUST start with ✅. `isErrorResponse` treats a ⚠️ prefix
  // as a failure, and `run_full_workflow` stops at this step.
  const gateNote = isGateSatisfied(gate.status)
    ? requested.length > 0
      ? `✅ Gerbang dokumentasi terpenuhi oleh: ${requested.join(", ")}`
      : `✅ Gerbang dokumentasi terpenuhi (${gate.status}).`
    : `⚠️ The documentation gate is not satisfied yet: ${gate.sourceChanged.length} source files ` +
      `changed without a documentation file.\n` +
      (isToolAllowedInProfile("waive_documentation")
        ? `   'check_ready_to_commit' will refuse until you use 'files: [...]' ` +
          `or 'waive_documentation'.`
        : `   'check_ready_to_commit' will refuse until you update a documentation file and pass it as 'files: [...]'.`);

  return textResponse(
    `✅ Documentation created/updated!\n\n` +
      `Type: ${args.documentationType}\nSummary: ${args.summary}\n` +
      (requested.length > 0 ? `Files: ${requested.join(", ")}\n` : "") +
      `✅ PRD check: docs/PRD.md exists in the MCP package (not in the project repo).\n` +
      `${gateNote}\n\n` +
      `🎉 You're ready to verify your work!\n\n` +
      `Next Steps:\n` +
      `1. ✓ Fix/implement feature\n` +
      `2. ✓ Create tests\n` +
      `3. ✓ Run tests (GREEN!)\n` +
      `4. ✓ Create/update documentation\n` +
      `5. ⏳ Run 'check_ready_to_commit' to verify\n` +
      `6. ⏳ Run 'commit_and_push'\n` +
      `7. ⏳ ${isToolAllowedInProfile("skip_release") ? "Run 'perform_release' (or 'skip_release' when applicable)" : "Run 'perform_release'"}\n` +
      `8. ⏳ Mark as complete with 'complete_task'`
  );
}

/**
 * Exclude the documentation gate with a written reason.
 *
 * A waiver is a DECISION, not a shortcut: the reason goes into the history entry,
 * the commit report, and the next session's recommendations, so waiving every
 * task becomes visible instead of hidden.
 */
export async function handleWaiveDocumentation(args, workflowState) {
  if (!workflowState.state.testsPassed && !workflowState.state.testsSkipped) {
    return textResponse(
      "⚠️ Finish the test step first (run_tests with passed=true, or skip_tests), " +
        "before excluding the documentation gate."
    );
  }

  const reason = typeof args.reason === "string" ? args.reason.trim() : "";

  if (reason.length < MIN_WAIVER_REASON) {
    return textResponse(
      `⚠️ Refused: the waiver reason needs at least ${MIN_WAIVER_REASON} characters.\n\n` +
        `Write WHY the documentation does not need changes, not just "not needed". ` +
        `This reason goes into history and will be read again in the next session.`
    );
  }

  if (reason.length > MAX_WAIVER_REASON) {
    return textResponse(
      `⚠️ Refused: the waiver reason allows at most ${MAX_WAIVER_REASON} characters; ${reason.length} were sent.`
    );
  }

  workflowState.state.documentationWaived = true;
  workflowState.state.documentationWaiverReason = reason;
  workflowState.state.readyCheckCompleted = false;
  if (workflowState.state.governance) {
    const policies = loadPolicies();
    const docPolicy = policies.policies["engineering.documentation_required"];
    workflowState.state.governance.documentationEvidence = {
      status: "NOT_REQUIRED_WITH_REASON",
      rationale: reason,
      repository: workflowState.state.governance.repository || normalizeRepoSlug(workflowState.state.identityContract?.remote || ""),
      revision: Number(workflowState.state.dodRevision) || 0,
      policyVersion: docPolicy.version,
      policyDigest: policies.digest,
      recordedAt: new Date().toISOString(),
    };
  }
  await workflowState.save();

  return textResponse(
    `✅ The documentation gate is excluded for this task.\n\n` +
      `Reason: ${reason}\n\n` +
      `This reason is recorded in history, mentioned in the commit report, and appears in the next ` +
      `session's recommendations. Continue with 'check_ready_to_commit'.`
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
