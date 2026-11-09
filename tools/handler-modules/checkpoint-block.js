/**
 * The machine-readable half of a Zettly checkpoint.
 *
 * WHY THIS EXISTS (9 November 2026)
 * ---------------------------------
 * Plan and DoD are already rendered into the Todo description as human-readable
 * text, and that is what a person reads. But a handoff needs fields a person
 * does not read: which machine owns the task, when it was checkpointed, the base
 * commit, the commits this session made, and whether it was handed over.
 *
 * `mergeBlock()` deletes the whole dev-workflow region and re-inserts only what
 * `blockFor()` produces, so anything added elsewhere is erased on the next sync.
 * The element therefore has to be rendered by `blockFor()` itself, and read by a
 * parser that bypasses `zettly-context.js` -- which deliberately strips these
 * regions and truncates descriptions.
 *
 * The payload is data, never instructions. It is written by us and read back by
 * us, so it is not sanitized on read; sanitizing would mangle legitimate values
 * (a summary starting with `{` is JSON-parsed by `sanitize()`).
 */

export const CHECKPOINT_ATTRIBUTE = "data-dev-workflow-state";

/** Fields a checkpoint carries. Anything absent is null/[] rather than missing. */
export function normalizePayload(payload = {}) {
  return {
    machine: typeof payload.machine === "string" ? payload.machine : null,
    checkpointedAt:
      typeof payload.checkpointedAt === "string" ? payload.checkpointedAt : null,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    baseSha: typeof payload.baseSha === "string" ? payload.baseSha : null,
    commits: Array.isArray(payload.commits)
      ? payload.commits.filter((sha) => typeof sha === "string")
      : [],
    handover:
      payload.handover && typeof payload.handover === "object"
        ? payload.handover
        : null,
  };
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Renders the element that `blockFor()` appends to the description.
 *
 * `</script` inside the JSON would close the element early, so any occurrence is
 * escaped as `<\/script`. JSON.parse accepts that escape in a string, and the
 * payload contains no script tags of its own.
 */
export function renderCheckpointElement(workflowTaskId, payload = {}) {
  const json = JSON.stringify(normalizePayload(payload)).replace(
    /<\/script/gi,
    "<\\/script"
  );
  return `<script type="application/json" ${CHECKPOINT_ATTRIBUTE}="${escapeAttribute(
    workflowTaskId
  )}">${json}</script>`;
}

/**
 * Reads the element back out of a description.
 *
 * Returns null when the element is absent or unparseable. A Todo created before
 * this element existed simply has no checkpoint, which is not an error.
 */
export function parseCheckpointElement(description) {
  if (typeof description !== "string" || description.length === 0) return null;

  // The attribute is ours and appears once per block. Anchoring on it avoids
  // matching unrelated <script> elements a description may carry.
  const match = new RegExp(
    `<script[^>]*${CHECKPOINT_ATTRIBUTE}\\s*=\\s*"[^"]*"[^>]*>([\\s\\S]*?)<\\/script>`,
    "i"
  ).exec(description);

  if (!match) return null;

  try {
    return normalizePayload(JSON.parse(match[1].replace(/<\\\/script/gi, "</script")));
  } catch {
    return null;
  }
}
