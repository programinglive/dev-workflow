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

async function resolveClient(context = {}) {
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
