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
import { createGitFacade } from "../../git-facade.js";

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

  // When asked, produce the bounded revert record too. Read-only: it lists what
  // could be unwound and why each refusal happened, and changes nothing. The
  // facade resolves the active project dir, which start_task already pinned.
  let revertNote = "";
  if (args.showRevertPlan === true) {
    const git = createGitFacade();
    const plan = await planRevert({ state, git });
    const parts = [];
    parts.push(
      plan.candidates.length
        ? `Revert candidates (${plan.candidates.length}): ${plan.candidates.map((s) => s.slice(0, 10)).join(", ")}`
        : "No revert candidates: nothing this session made is eligible to unwind."
    );
    if (plan.refused.length) {
      parts.push(
        `Refused: ${plan.refused.map((r) => `${r.sha.slice(0, 10)} (${r.why})`).join("; ")}`
      );
    }
    if (plan.dirty.length) {
      parts.push(`Dirty working tree (${plan.dirty.length}): ${plan.dirty.slice(0, 10).join(", ")}`);
    }
    revertNote = ` ${parts.join(". ")}. Revert is recorded only; nothing is executed.`;
  }

  const client = await resolveClient(context);
  if (!client) {
    return { ok: true, confirmed: false, note: `Checkpoint written but Zettly is not configured; not confirmed.${revertNote}` };
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
      note: `Checkpoint written to Todo #${todoId} but not confirmed: the element was not readable back.${revertNote}`,
    };
  }

  if (stored.checkpointedAt !== checkpointedAt) {
    return {
      ok: true,
      confirmed: false,
      note: `Checkpoint written to Todo #${todoId} but not confirmed: stored timestamp ${stored.checkpointedAt} does not match ${checkpointedAt}.${revertNote}`,
    };
  }

  return {
    ok: true,
    confirmed: true,
    note: `Checkpoint confirmed in Zettly Todo #${todoId} at ${checkpointedAt}.${revertNote}`,
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

/**
 * Revert record: which of this session's commits COULD be unwound.
 *
 * WHY A RECORD, NEVER AN ACTION (9 November 2026)
 * ------------------------------------------------
 * When a machine returns after a handoff, the owner may want to undo what that
 * session did. Undoing automatically is how tasks get stranded: a pushed
 * commit, or a commit that is not this session's, would be erased without
 * consent. So planRevert only PRODUCES a bounded plan -- candidates, refusals
 * with a reason, and the dirty files -- and leaves every action to a human.
 *
 * The `git` object is the shared git facade (or a test fake mirroring it), so
 * the scoping rules stay unit-testable while production reuses the same
 * helpers the commit and release handlers already rely on.
 */
export async function planRevert({ state, git }) {
  const commits = state?.checkpoint?.commits || [];
  const candidates = [];
  const refused = [];

  const defaultBranch = await git.defaultBranch();
  for (const sha of commits) {
    const remoteBranches = await git.remoteBranchesContaining(sha);
    if (remoteBranches.includes(defaultBranch)) {
      refused.push({ sha, why: "already on the remote default branch" });
      continue;
    }
    const author = await git.authorEmail(sha);
    const session = await git.sessionEmail();
    if (author && session && author !== session) {
      refused.push({
        sha,
        why: `author ${author} is not this session's identity ${session}`,
      });
      continue;
    }
    candidates.push(sha);
  }

  const dirty = await git.statusPorcelain();
  return { candidates, refused, dirty };
}
