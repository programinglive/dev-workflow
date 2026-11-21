/**
 * Request-level session attribution for the MCP transport.
 *
 * WHY THIS EXISTS
 * ---------------
 * One MCP process serves several agent sessions. The state file is per session,
 * but `index.js` used to switch sessions only when the request carried
 * `ai.opencode/sessionID`. A request without that metadata silently reused the
 * previous request's session, so a tool call could read or write another
 * agent's workflow state.
 *
 * The rule now is fail-closed:
 *   - a session-scoped tool without a verified session identity is rejected;
 *   - only tools that do not touch session state may run without an identity.
 *
 * The rejection is recoverable: the client reconnects with the session metadata
 * and retries. No state is read or written on the rejected path.
 */

import { sessionKeyFromRequest } from "./workflow-state.js";
import { DEVWORKFLOW_V2_TOOL_NAMES } from "./src/engineering-audit.js";

export { sessionKeyFromRequest };

/**
 * Tools that are safe to run without a verified MCP session identity.
 *
 * These read shared, non-session data (focus, fleet, Sentry, MCP catalog,
 * project knowledge) or operate on the monitor. They must not read or write
 * the per-session workflow state.
 */
export const NON_SESSION_SCOPED_TOOLS = new Set([
  "get_current_focus",
  "set_focus",
  "list_active_sessions",
  "get_integration_status",
  "get_sentry_issue",
  "list_sentry_issues",
  "inventory_sentry_issues",
  "recommend_mcp_tools",
  "build_report",
  "project_summary",
  "project_summary_data",
  "project_summary_db",
  "security_audit",
  "search_project",
  ...DEVWORKFLOW_V2_TOOL_NAMES,
]);

export const SESSION_IDENTITY_REQUIRED_MESSAGE =
  "SESSION_IDENTITY_REQUIRED: this tool reads or writes session-scoped workflow state, " +
  "but the MCP request did not include ai.opencode/sessionID metadata. " +
  "Reconnect the client so it sends the session identity, then retry. " +
  "No state was read or written.";

export function isSessionScopedTool(name) {
  return !NON_SESSION_SCOPED_TOOLS.has(String(name || ""));
}

/**
 * Decide whether a request may proceed and which session it belongs to.
 *
 * @param {object} request MCP CallToolRequest
 * @returns {{ok: true, sessionId: string|null, toolName: string} |
 *           {ok: false, error: string, toolName: string}}
 */
export function resolveRequestSession(request, options = {}) {
  const toolName = String(request?.params?.name || "");
  const sessionId = sessionKeyFromRequest(request, options);

  if (!sessionId && isSessionScopedTool(toolName)) {
    return { ok: false, error: SESSION_IDENTITY_REQUIRED_MESSAGE, toolName };
  }

  return { ok: true, sessionId, toolName };
}
