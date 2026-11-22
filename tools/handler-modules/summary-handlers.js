import fs from "fs/promises";
import path from "path";
import { sanitize } from "../../security/sanitizer.js";
import { textResponse, generateProjectSummary, summarizeHistory, PROJECT_SUMMARY_FILENAME } from "./shared.js";

/**
 * Format a structured summary payload (`{ totalTasks, taskTypes, lastActive, updatedAt, recentTasks }`)
 * built from either `project-summary.json` or SQLite `project_summary` into the canonical human-readable block.
 */
export function formatPersistedProjectSummary(parsed, sourceLabel = "persisted data") {
  const safe = sanitize(parsed || {});
  const taskTypes = safe.taskTypes && typeof safe.taskTypes === "object" ? safe.taskTypes : {};
  const recentTasks = Array.isArray(safe.recentTasks) ? safe.recentTasks : [];
  const typeMix = Object.entries(taskTypes)
    .map(([t, c]) => `${t}: ${c}`)
    .join(", ");
  const lastActive = safe.lastActive ? new Date(safe.lastActive).toLocaleDateString() : "Never";
  const updated = safe.updatedAt ? new Date(safe.updatedAt).toLocaleString() : "Unknown";
  const recentLines = recentTasks
    .map((e, i) => `${i + 1}. ${e.description} (${e.type})`)
    .join("\n");

  return (
    `🧠 Project Knowledge Summary (from ${sourceLabel})\n\n` +
    `📊 Stats\n` +
    `- Total tasks completed: ${safe.totalTasks ?? 0}\n` +
    `- Recent task mix: ${typeMix}\n` +
    `- Last active: ${lastActive}\n` +
    `- Updated: ${updated}\n\n` +
    `📝 Recent tasks (last 5)\n${recentLines}`
  );
}

/**
 * Unified Project Knowledge Summary service (`resolveUnifiedProjectSummary`).
 *
 * Consolidates `project_summary` (in-memory), `project_summary_data` (persisted JSON file),
 * and `project_summary_db` (per-user SQLite table) into a single authoritative service.
 *
 * @param {object} workflowState
 * @param {object} options
 * @param {"memory"|"file"|"db"|"auto"} [options.source="memory"]
 */
export async function resolveUnifiedProjectSummary(workflowState, { source = "memory" } = {}) {
  const mode = String(source || "memory").toLowerCase();

  if (mode === "file" || mode === "auto") {
    const summaryPath = path.join(path.dirname(workflowState.stateFile), PROJECT_SUMMARY_FILENAME);
    try {
      const data = await fs.readFile(summaryPath, "utf-8");
      const parsed = JSON.parse(data);
      return textResponse(formatPersistedProjectSummary(parsed, "persisted data"));
    } catch {
      if (mode === "file" || mode === "auto") {
        const summary = generateProjectSummary(workflowState?.state?.history);
        return textResponse(summary);
      }
    }
  }

  if (mode === "db") {
    try {
      const { getSummaryForUser } = await import("../../db/index.js");
      const userId = process.env.DEV_WORKFLOW_USER_ID || "default";
      const projectPath = path.dirname(path.dirname(path.dirname(path.dirname(workflowState.stateFile))));

      const summary = await getSummaryForUser(userId, projectPath);
      if (!summary) {
        return textResponse("📜 No project summary in database yet.");
      }
      return textResponse(formatPersistedProjectSummary(summary, "SQLite"));
    } catch {
      return textResponse("📜 Database module not available. Use 'project_summary' or 'project_summary_data' instead.");
    }
  }

  const summary = generateProjectSummary(workflowState?.state?.history);
  return textResponse(summary);
}

export function handleProjectSummary(workflowState, args = {}) {
  const requestedSource = typeof args?.source === "string" ? args.source.trim().toLowerCase() : "memory";
  if (requestedSource === "file" || requestedSource === "db" || requestedSource === "auto") {
    return resolveUnifiedProjectSummary(workflowState, { source: requestedSource });
  }
  const summary = generateProjectSummary(workflowState.state.history);
  return textResponse(summary);
}

export async function handleProjectSummaryData(workflowState) {
  return await resolveUnifiedProjectSummary(workflowState, { source: "file" });
}

export async function handleProjectSummaryDb(workflowState) {
  return await resolveUnifiedProjectSummary(workflowState, { source: "db" });
}

export function handleViewHistory(args, workflowState) {
  const message = summarizeHistory(workflowState.state.history, args.limit || 10);
  if (!message) {
    return textResponse("📜 No workflow history yet.");
  }

  return textResponse(message);
}
