/**
 * Cross-machine checkpoint transfer.
 *
 * WHY SSH + A FIXED COMMAND (9 November 2026)
 * -------------------------------------------
 * A machine that picks up a task from another machine must not pull files
 * over SSH (that is monitor-owned state) and must not trust a stale copy.
 * It refreshes the source machine's checkpoint THROUGH the source's own
 * dev-workflow process: one fixed, non-interactive command that calls
 * `checkpoint_task` with an explicit session key. No free-form shell string
 * ever crosses the wire, mirroring the erp-ci bridge pattern.
 *
 * The Zettly Todo remains the single record. A failed refresh does not lose
 * the task: the last confirmed checkpoint still sits in Zettly, and the
 * fallback adopts exactly that, flagged as not confirmed.
 */
import { spawn } from "node:child_process";
import { handleCheckpointTask, resolveClient } from "./checkpoint-handlers.js";
import { parseCheckpointElement } from "./checkpoint-block.js";

/**
 * Resolves a machine display name to an SSH alias, case-insensitively.
 *
 * Returns null instead of guessing: a name that does not resolve must be asked
 * about, never silently mapped to the local machine.
 */
export function resolveMachineAlias(name, aliases = {}) {
  if (typeof name !== "string" || !name.trim()) return null;
  const key = name.trim().toLowerCase();
  for (const [alias, value] of Object.entries(aliases)) {
    if (String(alias).toLowerCase() === key || String(value).toLowerCase() === key) {
      return value;
    }
  }
  return null;
}

/**
 * Builds the fixed remote command.
 *
 * `nodePath` must be absolute: a non-interactive SSH shell has no PATH
 * (lesson already paid for in managed/rollout.cjs). `sessionKey` is the
 * remote session that owns the task; when unknown it is omitted and the
 * remote process uses its default session context.
 */
export function buildRemoteCheckpointCommand({ alias, sessionKey = "", nodePath, scriptPath, timeoutMs = 120000 }) {
  return {
    command: "ssh",
    args: [
      "-o",
      "BatchMode=yes",
      alias,
      nodePath,
      scriptPath,
      "call",
      "checkpoint_task",
      ...(sessionKey ? ["--session", sessionKey] : []),
    ],
    timeoutMs,
  };
}

/** Runs the fixed command and rejects on non-zero exit or timeout. */
function defaultRunRemoteCheckpoint(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Remote checkpoint timed out after ${spec.timeoutMs} ms`));
    }, spec.timeoutMs);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Remote checkpoint exited with code ${code}: ${stderr.trim() || "no stderr"}`));
    });
  });
}

/** Reads the last checkpoint element out of the shared Zettly Todo. */
async function readStoredCheckpoint(context) {
  const state = context.workflowState?.state;
  const client = await resolveClient(context);
  if (!client || !state?.zettly?.todoId) return null;
  try {
    const response = await client.request("GET", `/todos/${state.zettly.todoId}`);
    return parseCheckpointElement(response?.data?.description || "");
  } catch {
    return null;
  }
}

/**
 * Adopts a checkpoint payload into this session and records who it came from.
 *
 * The handover marker points FROM the source machine TO this one, so the
 * source is the machine the guard later refuses to continue on; this machine
 * is the target and may keep working.
 */
function adoptPayload(state, stored, { from, to, reason, sessionKey }) {
  state.checkpoint = state.checkpoint || {};
  if (stored.summary) state.checkpoint.summary = stored.summary;
  if (stored.baseSha) state.checkpoint.baseSha = stored.baseSha;
  if (Array.isArray(stored.commits) && stored.commits.length) {
    state.checkpoint.commits = stored.commits;
  }
  state.checkpoint.handover = {
    from,
    to,
    reason,
    at: new Date().toISOString(),
    sessionKey: sessionKey || "",
  };
}

/**
 * Takes a task over from another machine, or checkpoints locally.
 *
 * - no `from`, or `from` is this machine: a plain local checkpoint_task.
 * - `from` is another machine: a reason is mandatory (it becomes the handover
 *   marker the source will read), the source's checkpoint is refreshed over
 *   SSH, and the payload is adopted from Zettly. When the refresh fails, the
 *   last readable Zettly checkpoint is adopted instead and flagged
 *   confirmed:false rather than blocking the takeover.
 */
export async function handleFetchTask(args = {}, context = {}) {
  const state = context.workflowState?.state;
  if (!state || !state.taskDescription) {
    return { ok: false, confirmed: false, note: "No task has been started; nothing to fetch into." };
  }

  const from = typeof args.from === "string" ? args.from.trim() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";

  const isLocal = !from || from.toLowerCase() === (state.machine || "").toLowerCase();
  if (isLocal) {
    const result = await handleCheckpointTask({ summary: reason }, context);
    return { ...result, local: true };
  }

  if (!reason) {
    return {
      ok: false,
      confirmed: false,
      note: `Fetching from ${from} records a handover marker that the source machine will read; a reason is required.`,
    };
  }

  const aliases = context.machineAliases || {};
  const alias = resolveMachineAlias(from, aliases);
  if (alias === null) {
    const available = Object.keys(aliases).join(", ") || "none configured";
    return {
      ok: false,
      confirmed: false,
      note: `Machine "${from}" does not resolve to an SSH alias. Available machines: ${available}.`,
    };
  }

  const sessionKey =
    typeof args.sessionKey === "string"
      ? args.sessionKey.trim()
      : state.checkpoint?.handover?.sessionKey || "";
  const spec = buildRemoteCheckpointCommand({
    alias,
    sessionKey,
    nodePath: context.nodePath,
    scriptPath: context.scriptPath,
  });
  const run = context.runRemoteCheckpoint || defaultRunRemoteCheckpoint;

  let remoteError = null;
  try {
    await run(spec);
  } catch (error) {
    remoteError = error;
  }

  const stored = await readStoredCheckpoint(context);
  if (!stored) {
    return {
      ok: false,
      confirmed: false,
      note: remoteError
        ? `The remote checkpoint refresh failed (${String(remoteError.message || remoteError)}) and no readable checkpoint exists in Zettly Todo #${state.zettly?.todoId}.`
        : "No readable checkpoint exists in the Zettly Todo.",
    };
  }

  adoptPayload(state, stored, {
    from: stored.machine || from,
    to: state.machine || "unknown",
    reason,
    sessionKey,
  });

  const result = await handleCheckpointTask({ summary: `adopted from ${from}: ${reason}` }, context);

  if (remoteError) {
    return {
      ok: result.ok,
      confirmed: false,
      note: `Remote refresh failed (${String(remoteError.message || remoteError)}); adopted the last readable Zettly checkpoint instead, so this adoption is not confirmed fresh. ${result.note}`,
    };
  }

  return {
    ...result,
    note: `Checkpoint adopted from ${from}. ${result.note}`,
  };
}
