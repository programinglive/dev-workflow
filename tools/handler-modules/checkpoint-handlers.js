/**
 * Checkpoint tools: write the current task's authoritative state into Zettly,
 * and read it back to prove the write landed.
 *
 * WHY READ-BACK (9 November 2026)
 * -------------------------------
 * A checkpoint that claims to be written but cannot be read is worse than no
 * checkpoint: another machine trusts it and continues from a fiction. The PATCH
 * acknowledgement is not proof -- `mergeBlock()` rewrites the region, and a
 * short-circuit can skip the write entirely. So success means: we asked, then we
 * read the same Todo and found our element with a matching timestamp.
 */
import { resolveZettlyConfig, createZettlyClient, zettlySyncEnabled } from "../../zettly-client.js";
import { syncZettlyTask } from "../../zettly-workflow.js";
import { parseCheckpointElement } from "./checkpoint-block.js";
import { exec } from "../../exec.js";

export async function resolveClient(context = {}) {
  if (context.client) return context.client;
  const env = context.env || process.env;
  if (!zettlySyncEnabled(env)) return null;
  const config = await resolveZettlyConfig(env);
  if (!config) return null;
  return createZettlyClient(config, { fetchImpl: context.fetchImpl || fetch });
}

/** Commits this session made, measured from the base recorded at start_task. */
export async function listSessionCommits({ projectDir, baseSha } = {}) {
  if (!projectDir || !baseSha) return [];
  try {
    const { stdout } = await exec(
      `git -C ${JSON.stringify(projectDir)} rev-list ${baseSha}..HEAD`
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((sha) => /^[a-f0-9]{40}$/.test(sha));
  } catch {
    return [];
  }
}

/**
 * Write a checkpoint and prove it.
 *
 * Returns ok:false only when nothing could be written (no task, sync disabled).
 * A write that happened but could not be read back returns ok:true with
 * confirmed:false, because the data is probably there and the caller must know
 * the difference before relying on it.
 */
export async function handleCheckpointTask(args = {}, context = {}) {
  const workflowState = context.workflowState;
  const state = workflowState?.state;

  if (!state || !state.taskDescription) {
    return { ok: false, confirmed: false, note: "No task has been started; nothing to checkpoint." };
  }

  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  const checkpointedAt = new Date().toISOString();

  state.checkpoint = state.checkpoint || {};
  state.checkpoint.checkpointedAt = checkpointedAt;
  if (summary) state.checkpoint.summary = summary;
  state.checkpoint.commits = await listSessionCommits({
    projectDir: state.projectDir,
    baseSha: state.checkpoint.baseSha,
  });

  // force: the payload hash can otherwise short-circuit the write when only the
  // checkpoint changed, which is precisely the field this tool exists to write.
  const synced = await syncZettlyTask(workflowState, {
    ...(context.env ? { env: context.env } : {}),
    ...(context.client ? { client: context.client } : {}),
    force: true,
  });

  if (!synced?.ok) {
    return {
      ok: false,
      confirmed: false,
      note: `Checkpoint not written: ${synced?.note || "Zettly sync failed"}`,
    };
  }

  const todoId = Number(state.zettly?.todoId);
  if (!Number.isSafeInteger(todoId) || todoId < 1) {
    return { ok: true, confirmed: false, note: "Checkpoint written but no Zettly Todo is linked; not confirmed." };
  }

  const client = await resolveClient(context);
  if (!client) {
    return { ok: true, confirmed: false, note: "Checkpoint written but Zettly is not configured; not confirmed." };
  }

  let stored = null;
  try {
    const response = await client.request("GET", `/todos/${todoId}`);
    stored = parseCheckpointElement(response?.data?.description || "");
  } catch {
    stored = null;
  }

  if (!stored) {
    return {
      ok: true,
      confirmed: false,
      note: `Checkpoint written to Todo #${todoId} but not confirmed: the element was not readable back.`,
    };
  }

  if (stored.checkpointedAt !== checkpointedAt) {
    return {
      ok: true,
      confirmed: false,
      note: `Checkpoint written to Todo #${todoId} but not confirmed: stored timestamp ${stored.checkpointedAt} does not match ${checkpointedAt}.`,
    };
  }

  return {
    ok: true,
    confirmed: true,
    note: `Checkpoint confirmed in Zettly Todo #${todoId} at ${checkpointedAt}.`,
  };
}

/**
 * Records that a task was handed from this machine to another one.
 *
 * The record is mandatory-reason: a handoff without a reason is useless to the
 * machine that picks the task up, and silent continuation on the source machine
 * is exactly what strands tasks. The marker lands in the checkpoint (not only
 * in local state) so both machines can read it.
 */
export async function handleHandoffTask(args = {}, context = {}) {
  const workflowState = context.workflowState;
  const state = workflowState?.state;

  if (!state || !state.taskDescription) {
    return { ok: false, confirmed: false, note: "No task has been started; nothing to hand off." };
  }

  const to = typeof args.to === "string" ? args.to.trim() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";

  if (!to) {
    return { ok: false, confirmed: false, note: "A handoff needs a target machine ('to')." };
  }
  if (!reason) {
    return {
      ok: false,
      confirmed: false,
      note: "A handoff requires a non-empty reason: the machine that picks the task up must know why it is taking over.",
    };
  }
  if (to === (state.machine || "")) {
    return {
      ok: false,
      confirmed: false,
      note: `The target is the same machine as the current one (${to}); nothing to hand off.`,
    };
  }

  state.checkpoint = state.checkpoint || {};
  state.checkpoint.handover = {
    from: state.machine || "unknown",
    to,
    reason,
    at: new Date().toISOString(),
    sessionKey: workflowState?.sessionId || "",
  };

  // The handoff IS a checkpoint: write and prove it, so the target machine can
  // read the marker even if this process dies before it does.
  const result = await handleCheckpointTask(
    { summary: `handed off to ${to}: ${reason}` },
    context
  );

  return {
    ok: result.ok,
    confirmed: result.confirmed,
    note: `Handoff to ${to} recorded. ${result.note}`,
  };
}

/**
 * Reads the handover marker without acting on it.
 *
 * The guard is the only thing allowed to stop a session from continuing work on
 * a handed-off task; it must be cheap and side-effect free, so callers can run
 * it at the top of start_task and get_current_focus on every invocation.
 */
export function handoffGuard(state = {}) {
  const handover = state.checkpoint?.handover;
  if (!handover || typeof handover !== "object" || !handover.to) {
    return { handedOver: false };
  }
  // The marker only binds the SOURCE machine: the target is the one allowed to
  // continue, so a marker whose target is this machine is inert here. This is
  // what lets the receiving machine adopt the payload and keep working while
  // the source stays refused.
  if (state.machine && handover.to === state.machine) {
    return { handedOver: false, target: true };
  }
  return {
    handedOver: true,
    from: handover.from || "unknown",
    to: handover.to,
    reason: handover.reason || "",
    at: handover.at || "",
  };
}

/**
 * Explicit acknowledgement that a machine returns and takes the task back.
 *
 * The acknowledgement is appended to the checkpoint summary first, so the fact
 * of returning is itself recorded; only then is the marker cleared. Clearing it
 * silently would let the original machine work while the other machine still
 * believes it owns the task.
 */
export async function handleAcknowledgeHandover(args = {}, context = {}) {
  const workflowState = context.workflowState;
  const state = workflowState?.state;

  const guard = handoffGuard(state || {});
  if (!guard.handedOver) {
    return { ok: false, confirmed: false, note: "No handover is recorded for this task; nothing to acknowledge." };
  }

  const acknowledgedAt = new Date().toISOString();
  state.checkpoint = state.checkpoint || {};
  state.checkpoint.summary = [
    state.checkpoint.summary,
    `Machine ${state.machine || "unknown"} acknowledged the handover from ${guard.from} on ${acknowledgedAt} and resumes the task locally.`,
  ]
    .filter(Boolean)
    .join(" | ");
  state.checkpoint.handover = null;

  const result = await handleCheckpointTask(
    { summary: state.checkpoint.summary },
    context
  );

  return {
    ok: result.ok,
    confirmed: result.confirmed,
    note: `Handover from ${guard.from} acknowledged. ${result.note}`,
  };
}
