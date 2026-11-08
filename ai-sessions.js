/**
 * AI session index for a task.
 *
 * WHY
 * ---
 * The monitor closes a session when the work is done, and the conversation that
 * did the work disappears with it. The Zettly Todo is the durable record of the
 * task, so it must also carry the session identity: with the OpenCode session ID
 * the owner can reopen the exact conversation instead of starting over.
 *
 * HONESTY
 * -------
 * Only OpenCode session keys (`ses_...`) can be resumed. Codex and Antigravity
 * report a per-process key (`proc-...`) that identifies the monitor card but no
 * resumable conversation. Those are listed and marked as not resumable rather
 * than pretending otherwise.
 */

const MAX_SESSIONS = 10;

import { createRequire } from "node:module";
import os from "node:os";

const requireCjs = createRequire(import.meta.url);
let detectTool = () => "unknown";
let sessionTitle = () => "";
try {
  ({ detectTool } = requireCjs("./agent-tool.cjs"));
  ({ sessionTitle } = requireCjs("./opencode-session-title.cjs"));
} catch {
  detectTool = () => "unknown";
  sessionTitle = () => "";
}

export function isResumableSessionKey(key) {
  return /^ses_[A-Za-z0-9]/.test(String(key || "").trim());
}

function clean(value, limit) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
}

/**
 * Insert or refresh one session entry. The newest report moves to the front and
 * the list is capped so the Todo block cannot grow without bound.
 */
export function recordAiSession(state, { key, agent, machine, title, source, phase, now } = {}) {
  const sessionKey = clean(key, 200);
  if (!state || !sessionKey) return state;

  const at = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString();
  const list = Array.isArray(state.aiSessions) ? state.aiSessions : [];
  const existing = list.find((item) => item && item.key === sessionKey);

  const entry = {
    key: sessionKey,
    agent: clean(agent || existing?.agent || "unknown", 40) || "unknown",
    machine: clean(machine || existing?.machine || "", 120),
    title: clean(title || existing?.title || "", 200),
    source: clean(source || existing?.source || "", 40),
    phase: clean(phase || existing?.phase || "", 40),
    startedAt: existing?.startedAt || at,
    lastSeenAt: at,
  };

  state.aiSessions = [entry, ...list.filter((item) => item && item.key !== sessionKey)]
    .slice(0, MAX_SESSIONS);
  return state;
}

/** One human-readable line per session, for the Zettly Todo block. */
export function renderAiSessions(state) {
  const list = Array.isArray(state?.aiSessions) ? state.aiSessions : [];
  return list.map((item) => {
    const parts = [item.key, item.agent || "unknown"];
    if (item.machine) parts.push(item.machine);
    if (item.title) parts.push(`"${item.title}"`);
    parts.push(isResumableSessionKey(item.key) ? "resumable" : "tidak bisa di-resume (proses)");
    return parts.join(" · ");
  });
}

export { MAX_SESSIONS };

/**
 * Describe the session that is saving right now: agent tool, machine, and the
 * OpenCode conversation title. Every lookup is best-effort and returns a safe
 * default when the source is unavailable.
 */
export function currentSessionContext({ key = "", env = process.env } = {}) {
  let machine = String(env.DEVWF_MACHINE || "").trim();
  if (!machine) {
    try {
      machine = os.hostname();
    } catch {
      machine = "unknown";
    }
  }
  let agent = "unknown";
  try {
    agent = detectTool({ env, commandLine: String(process.argv.slice(0, 2).join(" ")) }) || "unknown";
  } catch {
    agent = "unknown";
  }
  let title = "";
  try {
    title = sessionTitle(String(key || ""), env) || "";
  } catch {
    title = "";
  }
  return { agent, machine, title };
}
