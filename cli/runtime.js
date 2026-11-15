/**
 * Adapters between the CLI and the real dev-workflow machinery.
 *
 * Kept apart from `commands.js` so the command rules stay testable with stubs,
 * and apart from `bin/cli.js` so the entry point stays a thin wire.
 */
import path from "node:path";
import { WorkflowState, resolveProjectRootForState, ProjectOwnershipLostError } from "../workflow-state.js";
import {
  acquireWorktreeMutex,
  releaseWorktreeMutex,
  projectLockDir,
  findActiveLegacyWriter,
  readProcessLockDetailed,
  verifyLegacyFleetQuiescence,
} from "../process-lock.js";
import { handleDropTask, handleCompleteTask } from "../tools/handler-modules/commit-handlers.js";
import { findSession, listSessions } from "./sessions.js";

/**
 * The base state directory on this machine.
 *
 * `DEVWF_STATE_ROOT` wins so the owner can point at one specific layout.
 * Otherwise the parent of `DEV_WORKFLOW_STATE_FILE` is used, because that is
 * the directory a running MCP session already reports.
 */
export function resolveStateRoot(env = process.env) {
  const explicit = typeof env.DEVWF_STATE_ROOT === "string" ? env.DEVWF_STATE_ROOT.trim() : "";
  if (explicit) return path.resolve(explicit);

  const stateFile = typeof env.DEV_WORKFLOW_STATE_FILE === "string"
    ? env.DEV_WORKFLOW_STATE_FILE.trim()
    : "";
  if (stateFile) return path.dirname(path.resolve(stateFile));

  return path.join(process.cwd(), ".state");
}

/**
 * A real WorkflowState for one discovered session file.
 *
 * The file found on disk is the JSON export; the authoritative copy lives in
 * SQLite keyed by the same session. Loading through WorkflowState means the
 * handler mutates the same row a running session would, instead of a stale
 * snapshot.
 */
export async function openSessionState(found) {
  const base = path.basename(String(found.file || ""));
  const match = /^workflow-state\.(.+)\.json$/.exec(base);
  const discoveredSessionId = match ? match[1] : null;
  const workflowState = new WorkflowState(found.file, {
    ...(discoveredSessionId ? { canonicalSessionKey: discoveredSessionId } : {}),
    requireKernelMutex: true,
  });
  await workflowState.load({ skipWrites: true });
  const lockDir = projectLockDir(found.file);
  const lockInspection = readProcessLockDetailed({ dir: lockDir });
  if (lockInspection.status === "corrupt" || lockInspection.status === "unreadable") {
    throw new ProjectOwnershipLostError(
      `Refusing CLI session mutation: lock metadata in "${lockDir}" is ${lockInspection.status}`,
      { reason: `lock_metadata_${lockInspection.status}`, lockDir },
    );
  }
  const legacyWriter = findActiveLegacyWriter({ dir: lockDir });
  if (legacyWriter) {
    throw new ProjectOwnershipLostError(
      `Refusing CLI session mutation: active legacy v1 writer (PID ${legacyWriter.pid || "unknown"}) in "${lockDir}"`,
      { reason: "legacy_writer_active", lockDir, pid: legacyWriter.pid || null },
    );
  }
  const projectsParent = path.dirname(lockDir);
  if (path.basename(projectsParent) === "projects") {
    const quiescence = verifyLegacyFleetQuiescence({ baseDir: path.dirname(projectsParent) });
    if (quiescence.inspectionErrors && quiescence.inspectionErrors.length > 0) {
      const errItem = quiescence.inspectionErrors[0];
      throw new ProjectOwnershipLostError(
        `Refusing CLI session mutation: quiescence inspection failed (${errItem.reason || errItem.error || "QUIESCENCE_INSPECTION_FAILED"})`,
        { reason: errItem.reason || "quiescence_inspection_failed", lockDir },
      );
    }
    if (quiescence.legacyWriters && quiescence.legacyWriters.length > 0) {
      const w = quiescence.legacyWriters[0];
      throw new ProjectOwnershipLostError(
        `Refusing CLI session mutation: active legacy v1 writer (PID ${w.pid || "unknown"})`,
        { reason: "legacy_writer_active", lockDir, pid: w.pid || null },
      );
    }
  }
  const targetProjectDir = workflowState.state?.projectDir || resolveProjectRootForState(found.file);
  const ownerKey =
    discoveredSessionId ||
    (typeof workflowState._sessionKey === "function" ? workflowState._sessionKey()?.key : "") ||
    found.file;
  const acq = await acquireWorktreeMutex({
    projectDir: targetProjectDir,
    ownerKey,
  });
  if (!acq.ok) {
    throw new ProjectOwnershipLostError(
      acq.message || `Cannot acquire worktree mutex for "${targetProjectDir}": ${acq.reason || "locked"}`,
      {
        reason: acq.reason || "worktree_mutex_unavailable",
        projectDir: targetProjectDir,
        endpoint: acq.endpoint || null,
      },
    );
  }
  workflowState.bindKernelCapability(acq.capability);
  try {
    await workflowState.load();
  } catch (err) {
    await releaseWorktreeMutex(acq.capability);
    throw err;
  }
  return { workflowState, capability: acq.capability };
}

/**
 * Handlers bound to real state.
 *
 * `completed` / `dropped` are read from the STATE, not from the message text:
 * `handleCompleteTask` answers with prose for its refusals (no DoD, open DoD
 * items, bad next steps) and only resets the workflow on success. Matching
 * Indonesian or English sentences would break the first time the copy changes,
 * so the post-condition is the signal.
 */
export function createHandlers({ out }) {
  return {
    async drop({ file, reason }) {
      const { workflowState, capability } = await openSessionState({ file });
      try {
        const response = await handleDropTask({ reason }, workflowState, {});
        return { response, settled: isSettled(workflowState) };
      } finally {
        await releaseWorktreeMutex(capability);
      }
    },
    async complete({ file, nextSteps }) {
      const { workflowState, capability } = await openSessionState({ file });
      try {
        const args = nextSteps && nextSteps.length ? { nextSteps } : {};
        const response = await handleCompleteTask(args, workflowState, {});
        return { response, settled: isSettled(workflowState) };
      } finally {
        await releaseWorktreeMutex(capability);
      }
    },
  };
}

/** A settled task has been reset: no description and no live phase remain. */
function isSettled(workflowState) {
  const state = workflowState?.state || {};
  const description = typeof state.taskDescription === "string" ? state.taskDescription.trim() : "";
  const phase = typeof state.currentPhase === "string" ? state.currentPhase : "";
  return description === "" && (phase === "" || phase === "idle");
}

/** The session store the commands call. */
export function createSessions({ env = process.env } = {}) {
  const root = resolveStateRoot(env);
  return {
    find: (key) => findSession({ root, key }),
    list: () => listSessions({ root }),
  };
}
