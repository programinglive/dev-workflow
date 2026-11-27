/**
 * @zettly-code DWF-CLAIM-COORD-001
 * @purpose Pure + local/monitor-backed active AI session claim discovery, normalization, and duplicate-claim prevention without requiring Zettly or an external monitor.
 * @invariant Works 100% offline using local session state files and optionally merges live DevWorkflow Monitor (/api/sessions) claims when DEVWF_MONITOR_URL is configured.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fetchActiveSessions, monitorUrl } from "./monitor.js";

/**
 * How long a claim stays believable.
 *
 * The monitor treats a session as "possibly stuck" after 15 minutes without a
 * report, so a claim older than that is no longer a reliable signal that
 * someone is actively working. Keep this aligned with the monitor's LIVE window.
 */
export const CLAIM_STALE_MS = 15 * 60 * 1000;

const PHASES_WITHOUT_WORK = new Set(["idle", "closed", "done", "cancelled", "archived", "handed-off"]);
const SHORT_ID_PATTERN = /\b([A-Z][A-Z0-9_-]{1,24}-[0-9A-Z]{1,8})\b/g;

function ageMs(updatedAt, now) {
  if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) {
    return Math.max(0, now - updatedAt);
  }
  const parsed = Date.parse(String(updatedAt || ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

/**
 * Decide whether one claim should be reported to a caller.
 *
 * @returns {{claimed: boolean, reason: 'held'|'own'|'stale'|'idle'|'unknown', ageMs: number|null}}
 */
export function summarizeClaim({ claim, now = Date.now(), ownSessionKey = "" } = {}) {
  const c = claim || {};
  const age = ageMs(c.updatedAt, now);

  if (!c.sessionKey) return { claimed: false, reason: "unknown", ageMs: age };
  if (PHASES_WITHOUT_WORK.has(String(c.phase || ""))) return { claimed: false, reason: "idle", ageMs: age };
  if (ownSessionKey && c.sessionKey === ownSessionKey) return { claimed: false, reason: "own", ageMs: age };
  if (age === null || age > CLAIM_STALE_MS) return { claimed: false, reason: "stale", ageMs: age };

  return { claimed: true, reason: "held", ageMs: age };
}

/** "3m", "1j 12m", "45d" - the same shape the monitor uses. */
export function formatClaimAge(ms) {
  if (!Number.isFinite(ms)) return "?";
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}j ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}d`;
}

/**
 * Extract structured claim identifiers from a monitor session row, snapshot, or local state object.
 */
export function extractClaimIdentifiers(raw = {}) {
  const s = raw || {};
  const sessionKey = String(s.sessionKey || s.session_key || "").trim();
  const phase = String(s.phase || s.currentPhase || "idle").trim();
  const machine = String(s.machine || "").trim();
  const agentTool = String(s.agentTool || s.agent_tool || s.agent || "unknown").trim();
  const projectName =
    String(s.projectName || s.project_name || "").trim() ||
    String(s.projectPath || s.project_path || s.projectDir || "")
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ||
    "";
  const task = String(s.task || s.taskDescription || s.session_title || s.sessionTitle || "").trim();
  const updatedIso =
    s.updatedAt ||
    s.updated_at ||
    (typeof s.owner?.updatedAt === "number"
      ? new Date(s.owner.updatedAt).toISOString()
      : s.owner?.updatedAt) ||
    s.taskStartedAt ||
    s.started_at ||
    s.startedAt ||
    "";

  const workflowTaskIds = new Set();
  const sentryIssueIds = new Set();
  const sentryShortIds = new Set();
  const zettlyTodoIds = new Set();
  const sources = new Set();

  const addWorkflowId = (v) => {
    const id = String(v || "").trim();
    if (id) workflowTaskIds.add(id);
  };
  const addSentryId = (v) => {
    const id = String(v || "").trim();
    if (/^\d{1,30}$/.test(id)) {
      sentryIssueIds.add(id);
      sources.add(`sentry:${id}`);
    }
  };
  const addShortId = (v) => {
    const rawText = String(v || "").trim().toUpperCase();
    if (!rawText) return;
    for (const match of rawText.matchAll(SHORT_ID_PATTERN)) {
      const token = match[1];
      if (!/^(DOD|PLAN|UTF|HTTP|SHA|PID|AF|RFC|ISO|UTC|CLI|MCP|SQL|PHP|CSS|DOM|API|URL|SSH|TLS|JWT)-\d+$/.test(token)) {
        sentryShortIds.add(token);
      }
    }
  };
  const addTodoId = (v) => {
    const n = Number(v);
    if (Number.isSafeInteger(n) && n > 0) {
      zettlyTodoIds.add(n);
      sources.add(`zettly:${n}`);
    }
  };

  addWorkflowId(s.workflowTaskId || s.workflow_task_id || s.taskId || s.task_id);
  if (s.activeClaim && typeof s.activeClaim === "object") {
    addWorkflowId(s.activeClaim.taskId);
    addTodoId(s.activeClaim.todoId);
    addSentryId(s.activeClaim.sentryIssueId);
    addShortId(s.activeClaim.sentryShortId);
    if (s.activeClaim.source?.system && s.activeClaim.source?.id) {
      sources.add(`${s.activeClaim.source.system}:${s.activeClaim.source.id}`);
      if (s.activeClaim.source.system === "sentry") {
        addSentryId(s.activeClaim.source.id);
        addShortId(s.activeClaim.source.label);
      } else if (s.activeClaim.source.system === "zettly") {
        addTodoId(s.activeClaim.source.id);
      }
    }
  }

  const origin = s.taskOrigin || s.task_origin_json || null;
  if (origin && typeof origin === "object" && origin.system) {
    const sys = String(origin.system).trim();
    const id = String(origin.id || "").trim();
    if (sys && id) {
      sources.add(`${sys}:${id}`);
      if (sys === "sentry") {
        addSentryId(id);
        addShortId(origin.label);
      } else if (sys === "zettly") {
        addTodoId(id);
      }
    }
  }

  const relations = Array.isArray(s.taskRelations)
    ? s.taskRelations
    : Array.isArray(s.task_relations_json)
      ? s.task_relations_json
      : [];
  for (const rel of relations) {
    if (!rel || typeof rel !== "object") continue;
    if (rel.system === "sentry") {
      addSentryId(rel.id);
      addShortId(rel.label);
    } else if (rel.system === "zettly" && !String(rel.id || "").startsWith("focus:")) {
      addTodoId(rel.id);
    }
  }

  if (s.zettly && typeof s.zettly === "object") {
    addTodoId(s.zettly.todoId);
    addWorkflowId(s.zettly.taskId);
    const sentryLink = s.zettly.externalLinks?.sentry;
    if (sentryLink && typeof sentryLink === "object") {
      addSentryId(sentryLink.issueId);
      addShortId(sentryLink.shortId);
    }
  }

  addShortId(task);

  return {
    sessionKey,
    machine,
    agentTool,
    agent: agentTool,
    projectName,
    task,
    phase,
    updatedAt: updatedIso,
    ownerPid: Number(s.ownerPid || s.owner_pid || s.owner?.pid) || null,
    workflowTaskIds: [...workflowTaskIds],
    sentryIssueIds: [...sentryIssueIds],
    sentryShortIds: [...sentryShortIds],
    zettlyTodoIds: [...zettlyTodoIds],
    sources: [...sources],
  };
}

function scanLocalSessionClaimFiles(stateFile) {
  if (typeof stateFile !== "string" || !stateFile.trim()) return [];
  const resolved = path.resolve(stateFile);
  const segments = resolved.split(path.sep);
  const projIdx = segments.lastIndexOf("projects");
  const candidateFiles = new Set();

  if (projIdx > 0) {
    const projectsRoot = segments.slice(0, projIdx + 1).join(path.sep);
    if (existsSync(projectsRoot)) {
      try {
        for (const pEntry of readdirSync(projectsRoot, { withFileTypes: true })) {
          if (!pEntry.isDirectory()) continue;
          const usersRoot = path.join(projectsRoot, pEntry.name, "users");
          if (!existsSync(usersRoot)) continue;
          for (const uEntry of readdirSync(usersRoot, { withFileTypes: true })) {
            if (!uEntry.isDirectory()) continue;
            const uDir = path.join(usersRoot, uEntry.name);
            for (const fEntry of readdirSync(uDir, { withFileTypes: true })) {
              if (fEntry.isFile() && fEntry.name.startsWith("workflow-state.") && fEntry.name.endsWith(".json")) {
                candidateFiles.add(path.join(uDir, fEntry.name));
              }
            }
          }
        }
      } catch {
        // Best-effort scan
      }
    }
  } else {
    const dir = path.dirname(resolved);
    if (existsSync(dir)) {
      try {
        for (const fEntry of readdirSync(dir, { withFileTypes: true })) {
          if (fEntry.isFile() && fEntry.name.startsWith("workflow-state.") && fEntry.name.endsWith(".json")) {
            candidateFiles.add(path.join(dir, fEntry.name));
          }
        }
      } catch {}
    }
  }

  const results = [];
  for (const file of candidateFiles) {
    try {
      const m = /^workflow-state\.(.+)\.json$/.exec(path.basename(file));
      const fileSessionKey = m ? m[1] : "";
      if (!fileSessionKey || fileSessionKey === "compat-project") continue;
      let raw = readFileSync(file, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const disk = JSON.parse(raw);
      if (!disk || typeof disk !== "object") continue;
      results.push(
        extractClaimIdentifiers({
          ...disk,
          sessionKey: fileSessionKey,
        }),
      );
    } catch {
      // Skip unreadable or malformed state files
    }
  }
  return results;
}

/**
 * Collect all live session claims from local session state files AND optional DevWorkflow Monitor (`/api/sessions`).
 * Works 100% offline when DEVWF_MONITOR_URL is unconfigured or unreachable.
 */
export async function collectActiveSessionClaims({
  ownSessionKey = "",
  stateFile = "",
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 1500,
  now = Date.now(),
} = {}) {
  const bySessionKey = new Map();

  for (const localClaim of scanLocalSessionClaimFiles(stateFile)) {
    const verdict = summarizeClaim({ claim: localClaim, now, ownSessionKey });
    if (verdict.claimed) {
      bySessionKey.set(localClaim.sessionKey, { ...localClaim, ageMs: verdict.ageMs, claimOrigin: "local" });
    }
  }

  if (monitorUrl(env)) {
    try {
      const remote = await fetchActiveSessions({ env, limit: 50, fetchImpl, timeoutMs });
      if (remote.ok && Array.isArray(remote.sessions)) {
        for (const row of remote.sessions) {
          if (row && (row.state === "ended" || row.reaper_state === "CONFIRMED_ORPHAN")) continue;
          const claim = extractClaimIdentifiers(row);
          const verdict = summarizeClaim({ claim, now, ownSessionKey });
          if (!verdict.claimed) continue;
          bySessionKey.set(claim.sessionKey, { ...claim, ageMs: verdict.ageMs, claimOrigin: "monitor" });
        }
      }
    } catch {
      // Never fail if monitor is unreachable
    }
  }

  return [...bySessionKey.values()];
}

/**
 * Check if a requested task (`args` or Sentry issue object) is already claimed by another active AI session.
 */
export function findMatchingActiveClaim(target = {}, claims = [], { ownSessionKey = "", now = Date.now() } = {}) {
  const requestedWorkflowId = String(target.taskId || target.workflowTaskId || "").trim();
  const requestedTodoId =
    Number(target.zettlyTodoId || target.todoId || (target.source?.system === "zettly" ? target.source.id : 0)) || null;
  const requestedSentryId = String(
    target.sentryIssueId ||
      target.verifiedSourceIssue?.issueId ||
      (target.source?.system === "sentry" ? target.source.id : "") ||
      (target.id && /^\d{1,30}$/.test(String(target.id)) ? target.id : ""),
  ).trim();

  const requestedShortIds = new Set();
  const collectShort = (v) => {
    const text = String(v || "").trim().toUpperCase();
    if (!text) return;
    for (const m of text.matchAll(SHORT_ID_PATTERN)) {
      const token = m[1];
      if (!/^(DOD|PLAN|UTF|HTTP|SHA|PID|AF|RFC|ISO|UTC|CLI|MCP|SQL|PHP|CSS|DOM|API|URL|SSH|TLS|JWT)-\d+$/.test(token)) {
        requestedShortIds.add(token);
      }
    }
  };
  collectShort(target.shortId);
  collectShort(target.verifiedSourceIssue?.shortId);
  collectShort(target.source?.label);
  collectShort(target.description);

  for (const rawClaim of Array.isArray(claims) ? claims : []) {
    const claim = Array.isArray(rawClaim.sentryIssueIds) ? rawClaim : extractClaimIdentifiers(rawClaim);
    const verdict = summarizeClaim({ claim, now, ownSessionKey });
    if (!verdict.claimed) continue;

    if (requestedWorkflowId && claim.workflowTaskIds.includes(requestedWorkflowId)) {
      return { matchedBy: "taskId", value: requestedWorkflowId, claim, ageMs: verdict.ageMs };
    }
    if (requestedSentryId && claim.sentryIssueIds.includes(requestedSentryId)) {
      return { matchedBy: "sentryIssueId", value: requestedSentryId, claim, ageMs: verdict.ageMs };
    }
    if (requestedTodoId && claim.zettlyTodoIds.includes(requestedTodoId)) {
      return { matchedBy: "zettlyTodoId", value: String(requestedTodoId), claim, ageMs: verdict.ageMs };
    }
    for (const shortId of requestedShortIds) {
      if (claim.sentryShortIds.includes(shortId)) {
        return { matchedBy: "sentryShortId", value: shortId, claim, ageMs: verdict.ageMs };
      }
    }
  }

  return null;
}

/**
 * Format an activeClaim object for attaching to Sentry issues or status outputs.
 */
export function toIssueActiveClaim(match) {
  if (!match || !match.claim) return null;
  const c = match.claim;
  return {
    claimed: true,
    status: "in_progress",
    matchedBy: match.matchedBy,
    sessionKey: c.sessionKey,
    agentTool: c.agentTool || "unknown",
    machine: c.machine || "unknown",
    projectName: c.projectName || "",
    phase: c.phase || "coding",
    task: c.task || "",
    taskId: c.workflowTaskIds?.[0] || "",
    todoId: c.zettlyTodoIds?.[0] || null,
    updatedAt: c.updatedAt || "",
  };
}

/**
 * Format a clear refusal message when `start_task` detects that another live AI session already claimed the task/issue.
 */
export function formatDuplicateClaimRefusal(match) {
  const c = match.claim;
  const ageText = Number.isFinite(match.ageMs) ? `${formatClaimAge(match.ageMs)} ago` : "just now";
  const todoNote = c.zettlyTodoIds?.length ? `\nTracked Todo: #${c.zettlyTodoIds[0]}` : "";
  return (
    `⚠️ Refused: this task/issue (${match.matchedBy}: ${match.value}) is already claimed and in progress by another live AI session.\n\n` +
    `Claimed by  : ${c.agentTool || "unknown"} on ${c.machine || "local"} [sessionId=${c.sessionKey}]\n` +
    `Project     : ${c.projectName || "(unknown)"}\n` +
    `Phase       : ${c.phase || "coding"} (updated ${ageText})\n` +
    `Active Task : "${c.task || "(unnamed task)"}"${todoNote}\n\n` +
    `Choose an unclaimed issue/task so two AI sessions do not duplicate work.\n` +
    `(If you are intentionally taking over or overriding a stuck claim, pass 'forceClaim: true' on 'start_task'.)\n\n` +
    `Task NOT started; the previous workflow was not changed.`
  );
}

/**
 * One line per live claim, excluding the caller's own claim and stale ones.
 *
 * @returns {string[]}
 */
export function describeClaims({ claims = [], now = Date.now(), ownSessionKey = "" } = {}) {
  const lines = [];

  for (const claim of Array.isArray(claims) ? claims : []) {
    const result = summarizeClaim({ claim, now, ownSessionKey });
    if (!result.claimed) continue;

    const parts = [claim.projectName || "(tanpa proyek)", claim.agent || claim.agentTool || "unknown"]; // language-allow: existing localized claim view summary
    if (claim.machine) parts.push(claim.machine);
    if (claim.task) parts.push(`"${String(claim.task).slice(0, 80)}"`);
    parts.push(`${formatClaimAge(result.ageMs)} lalu`); // language-allow: existing localized claim view summary

    lines.push(parts.join(" · "));
  }

  return lines;
}

/**
 * The block `start_task` prepends to its success message, or '' when free.
 */
export function claimReportBlock({ claims = [], now = Date.now(), ownSessionKey = "" } = {}) {
  const lines = describeClaims({ claims, now, ownSessionKey });
  if (!lines.length) return "";

  return [
    "🔒 Task yang sedang dikerjakan sesi lain saat ini:", // language-allow: existing localized claim view header
    ...lines.map((line) => `  • ${line}`),
    "Pilih task yang belum tercantum di atas supaya dua sesi tidak berebut pekerjaan yang sama.", // language-allow: existing localized claim view footer
  ].join("\n");
}
