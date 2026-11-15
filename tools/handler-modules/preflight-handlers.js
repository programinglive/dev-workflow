import { textResponse } from "./shared.js";

/**
 * Record that the agent received the bounded instruction summary.
 *
 * This is an observable operation constraint, not proof of comprehension. The
 * server validates the README fingerprint and the task scope against the
 * current preflight record, so a stale or invented acknowledgment is rejected.
 */
export async function handleAcknowledgeInstructions(args, workflowState) {
  const record = workflowState.state.preflight;
  if (!record || record.ok !== true) {
    return textResponse(
      "⚠️ No preflight record for this task. Run 'start_task' first so the server can record the repository instructions."
    );
  }

  const fingerprint = typeof args.fingerprint === "string" ? args.fingerprint.trim() : "";
  const scope = typeof args.scope === "string" ? args.scope.trim() : "";
  const expectedFingerprint = record.preflightFingerprint || record.readme?.fingerprint || "";
  const expectedScope = record.projectRoot || "";

  if (!fingerprint || fingerprint !== expectedFingerprint) {
    return textResponse(
      "⚠️ Instruction acknowledgment rejected: the fingerprint does not match the current preflight. " +
        "Use the README fingerprint shown by 'start_task'."
    );
  }

  if (!scope || scope !== expectedScope) {
    return textResponse(
      `⚠️ Instruction acknowledgment rejected: the scope does not match the task preflight root (${expectedScope}).`
    );
  }

  workflowState.state.instructionAcknowledgment = {
    fingerprint,
    scope,
    at: new Date().toISOString(),
  };
  await workflowState.save();

  return textResponse(
    `✅ Instructions acknowledged for ${scope}.\n` +
      `Fingerprint: ${fingerprint.slice(0, 12)}…\n` +
      `This records that the agent received the bounded instruction summary; it does not prove comprehension.`
  );
}
