/**
 * Dev Workflow Start-Task Guard Plugin for OpenCode (1.x and 2.x).
 *
 * Hard-enforces the shared workflow rule that every OpenCode session — regardless
 * of which LLM model is active (including lightweight/free Flash models) — MUST
 * call `dev-workflow` `start_task` (or `resume_session`) before executing shell
 * commands or modifying files.
 *
 * This guarantees every task is registered on the central monitor and automatically
 * classified/committed in Zettly Priority Queue (https://zettly.programinglive.com/priority).
 *
 * Escape hatch: set DEVWF_GUARD_DISABLED=1 in the environment to bypass.
 */

const GATED_TOOLS = new Set([
  "bash",
  "shell",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "multiedit",
  "notebookedit",
])

const REGISTRATION_TOOL_PATTERN = /(?:^|[:_./-])(start_task|resume_session)$/i

const registeredSessions = new Set<string>()

export function _resetGuardState(): void {
  registeredSessions.clear()
}

export function normalizeToolName(toolName: unknown): string {
  return String(toolName ?? "").trim().toLowerCase()
}

export function isRegistrationTool(toolName: unknown): boolean {
  const normalized = normalizeToolName(toolName)
  return normalized.length > 0 && REGISTRATION_TOOL_PATTERN.test(normalized)
}

export function isGatedTool(toolName: unknown): boolean {
  const normalized = normalizeToolName(toolName)
  return GATED_TOOLS.has(normalized)
}

export function evaluateToolCall(toolName: unknown, sessionID: unknown): void {
  if (process.env.DEVWF_GUARD_DISABLED === "1") {
    return
  }

  const sid = String(sessionID ?? "default").trim() || "default"

  if (isRegistrationTool(toolName)) {
    registeredSessions.add(sid)
    return
  }

  if (!isGatedTool(toolName)) {
    return
  }

  if (registeredSessions.has(sid)) {
    return
  }

  const normalized = normalizeToolName(toolName)
  throw new Error(
    `[dev-workflow-guard] BLOCKED: You must call dev-workflow \`start_task\` (or \`resume_session\`) BEFORE running \`${normalized}\`. ` +
      `Every task must be registered and prioritized in Zettly Priority Queue (https://zettly.programinglive.com/priority) before executing commands or modifying files. ` +
      `Call \`get_current_focus\` and \`start_task\` with description, type, projectDir, definitionOfDone, and plan, then retry.`
  )
}

/**
 * Dual-shape OpenCode plugin object (supports both OpenCode 2.x `setup()` and
 * OpenCode 1.x `server()` plugin loaders).
 */
const DevWorkflowGuardPlugin = {
  id: "dev-workflow-guard",

  // OpenCode 2.x entrypoint: `{ tool, sessionID, agent, messageID, id, input }`.
  async setup(ctx: any) {
    await ctx?.tool?.hook?.("execute.before", (e: any) => {
      evaluateToolCall(e?.tool, e?.sessionID)
    })
  },

  // OpenCode 1.x entrypoint: `tool.execute.before(input, output)`.
  async server() {
    return {
      "tool.execute.before": (input: any) => {
        evaluateToolCall(input?.tool, input?.sessionID)
      },
    }
  },
}

export default DevWorkflowGuardPlugin
export { DevWorkflowGuardPlugin }
