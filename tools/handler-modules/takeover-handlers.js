import { existsSync } from "node:fs";
import path from "node:path";

import { textResponse } from "./shared.js";
import {
  findActiveForeignTaskInProject,
  canonicalProjectPath,
  projectKey,
} from "../../workflow-state.js";
import {
  DEFAULT_LOCK_STALE_MS,
  currentIsAlive,
  currentIsHolderProcess,
  projectLockDir,
  writeTakeoverRequest,
} from "../../process-lock.js";
import { resolveProjectDir } from "../../exec.js";

const refuse = (message) => textResponse(`⚠️ ${message}\n\nTask NOT taken over; no state was changed.`);

/** Locate the `.state` base directory from any state file path. */
function locateStateBase(stateFile) {
  let current = path.dirname(path.resolve(String(stateFile || "")));
  while (true) {
    if (path.basename(current) === ".state" || existsSync(path.join(current, "projects"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(path.resolve(String(stateFile || "")));
    current = parent;
  }
}

/**
 * Resolve the project's state bucket directly from the repository path.
 * The requester cannot rely on its own pinned state file: it is blocked exactly
 * because start_task never completed for this project.
 */
function resolveProjectBucket(stateFile, projectDir) {
  const canonical = canonicalProjectPath(projectDir);
  if (!canonical) return null;
  const base = locateStateBase(stateFile);
  return path.join(base, "projects", projectKey(canonical));
}

/**
 * Request a cooperative takeover of a repository whose task is held by a LIVE
 * but idle MCP process. A kernel mutex owned by a live process cannot be stolen
 * safely, so this tool only leaves a durable, confirmed request. The holder's
 * heartbeat drops its own task through the normal terminal path, which closes
 * the Zettly Todo and releases the mutex, then the requester retries start_task.
 */
export function handleTakeOverTask(args = {}, workflowState) {
  const ownerPid = Number(args.ownerPid);
  const reason = String(args.reason || "").trim();
  const confirmation = String(args.confirmation || "").trim();

  if (!Number.isFinite(ownerPid) || ownerPid <= 0) {
    return refuse("A positive numeric 'ownerPid' is required.");
  }
  if (reason.length < 5) {
    return refuse("A non-empty 'reason' (at least 5 characters) is required.");
  }
  if (confirmation !== `CONFIRM TAKE_OVER ${ownerPid}`) {
    return refuse(
      `Confirmation must be exactly "CONFIRM TAKE_OVER ${ownerPid}". This protects a live task from being dropped by accident.`,
    );
  }

  const resolved = resolveProjectDir({
    explicit: String(args.projectDir || ""),
    pinned: String(workflowState?.state?.projectDir || ""),
  });
  const projectDir = String(resolved?.dir || resolved?.projectDir || "").trim();
  if (!projectDir) {
    return refuse("Resolve a valid project directory before requesting a takeover.");
  }

  const projectDirPath = resolveProjectBucket(workflowState.stateFile, projectDir);
  if (!projectDirPath) {
    return refuse("Resolve a valid project directory before requesting a takeover.");
  }

  const foreign = findActiveForeignTaskInProject({
    projectDirPath,
    targetStateFile: null,
    ownPid: process.pid,
    isAlive: currentIsAlive(),
    isHolderProcess: currentIsHolderProcess(),
    staleMs: DEFAULT_LOCK_STALE_MS,
  });
  if (!foreign) {
    return refuse("No active foreign task was found for this project. Nothing to take over.");
  }
  if (foreign.ownerPid !== ownerPid) {
    return refuse(
      `The active task is owned by PID ${foreign.ownerPid}, not ${ownerPid}. Pass the current owner's PID.`,
    );
  }

  const ownerSeenAt = Number(foreign.ownerSeenAt);
  if (!Number.isFinite(ownerSeenAt)) {
    return refuse("The owner's last state write could not be verified. Takeover is refused fail-closed.");
  }
  const idleMs = Date.now() - ownerSeenAt;
  if (idleMs < DEFAULT_LOCK_STALE_MS) {
    return refuse(
      `PID ${ownerPid} wrote state ${Math.round(idleMs / 1000)}s ago. Takeover is only allowed after ${Math.round(DEFAULT_LOCK_STALE_MS / 60000)} minutes of inactivity.`,
    );
  }

  const request = writeTakeoverRequest({
    dir: projectLockDir(path.join(projectDirPath, "users", "placeholder", "workflow-state.json")),
    ownerPid,
    requesterPid: process.pid,
    reason,
  });
  if (!request.ok) {
    return refuse(`Could not record the takeover request (${request.error}).`);
  }

  return textResponse(
    `✅ Cooperative takeover requested from PID ${ownerPid}.\n\n` +
      `The holder will close its Todo and release the worktree mutex on its next heartbeat ` +
      `(within one minute). Reason recorded: "${reason}".\n\n` +
      `Then call 'start_task' again for ${projectDir}.`
  );
}
