/**
 * Factory task integration backed by PocketBase `activity_tasks`.
 *
 * Read and write helpers are separated from the HTTP layer so the filtering,
 * ordering and payload rules can be tested without a network or a database.
 *
 * Configuration is entirely environment-driven. With no configuration the MCP
 * server behaves exactly as before; these tools simply report that Factory is
 * not set up. No credentials are baked into the code.
 */

const ACTIVE_STATUSES = ["open", "in_progress", "blocked"];
const VALID_STATUSES = ["open", "in_progress", "blocked", "done"];
const STATUS_ORDER = { in_progress: 0, open: 1, blocked: 2, done: 3 };
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

export const TASKS_COLLECTION = "activity_tasks";

function clean(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Reads Factory configuration from an environment object.
 * Returns null unless a URL and both credential fields are present.
 */
export function readFactoryConfig(env = process.env) {
  const url = clean(env.FACTORY_PB_URL);
  const identity = clean(env.FACTORY_PB_IDENTITY);
  const password = clean(env.FACTORY_PB_PASSWORD);

  if (!url || !identity || !password) return null;

  return {
    url: url.replace(/\/+$/, ""),
    identity,
    password,
    machineId: clean(env.FACTORY_MACHINE_ID),
  };
}

export function isConfigured(env = process.env) {
  return readFactoryConfig(env) !== null;
}

/** Escapes a value for use inside a PocketBase filter string literal. */
function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Builds a PocketBase filter for task queries.
 * Defaults to the active statuses so finished work does not clutter the queue.
 */
export function buildTaskFilter({ statuses = ACTIVE_STATUSES, project = null } = {}) {
  const statusList = Array.isArray(statuses) && statuses.length > 0 ? statuses : ACTIVE_STATUSES;
  const parts = [statusList.map((s) => `status = ${quote(s)}`).join(" || ")];

  if (project) parts.push(`project = ${quote(project)}`);

  return parts.join(" && ");
}

/** Maps a PocketBase record to the shape the agent consumes. */
export function mapTaskRecord(record = {}) {
  return {
    id: record.id ?? null,
    taskKey: record.task_key ?? null,
    title: record.title ?? null,
    project: record.project ?? null,
    status: record.status ?? null,
    nextAction: record.next_action ?? null,
    priority: record.priority || "normal",
    category: record.category ?? null,
    domain: record.domain ?? null,
    blockedReason: record.blocked_reason || null,
    decisionNeeded: Boolean(record.decision_needed),
    effortMinutes: typeof record.effort_minutes === "number" ? record.effort_minutes : null,
    rankOverride: typeof record.rank_override === "number" ? record.rank_override : null,
  };
}

/**
 * Orders tasks so the most actionable one comes first:
 * status, then explicit rank override, then priority.
 * Returns a new array; the input is not mutated.
 */
export function sortTasks(tasks = []) {
  return [...tasks].sort((a, b) => {
    const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;

    const aRank = typeof a.rankOverride === "number" ? a.rankOverride : null;
    const bRank = typeof b.rankOverride === "number" ? b.rankOverride : null;
    if (aRank !== null || bRank !== null) {
      if (aRank === null) return 1;
      if (bRank === null) return -1;
      if (aRank !== bRank) return aRank - bRank;
    }

    return (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
  });
}

/** Payload for claiming a task: move it to in_progress and stamp the session. */
export function buildClaimPatch({ sessionId, machineId = null, now = new Date().toISOString() }) {
  const patch = {
    status: "in_progress",
    started_at: now,
    session_id: sessionId,
  };
  if (machineId) patch.machine_id = machineId;
  return patch;
}

/** Payload for reporting a task status change back to Factory. */
export function buildStatusPatch({ status, reason = null, nextAction = null, now = new Date().toISOString() }) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Unknown status "${status}". Expected one of: ${VALID_STATUSES.join(", ")}.`);
  }

  const patch = { status };

  if (status === "done") {
    patch.completed_at = now;
  }

  if (status === "blocked") {
    if (!reason) {
      throw new Error("A reason is required when marking a task blocked.");
    }
    patch.blocked_reason = reason;
  }

  if (nextAction) patch.next_action = nextAction;

  return patch;
}

/** Human-readable rendering of a task queue. */
export function formatTaskList(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return "No open tasks in the Factory queue.";
  }

  const lines = [`${tasks.length} task(s) in the Factory queue:`, ""];

  tasks.forEach((task, index) => {
    const meta = [task.status, task.priority, task.project].filter(Boolean).join(" · ");
    lines.push(`${index + 1}. [${task.taskKey || task.id}] ${task.title}`);
    lines.push(`   ${meta}`);
    if (task.nextAction) lines.push(`   next: ${task.nextAction}`);
    if (task.blockedReason) lines.push(`   blocked: ${task.blockedReason}`);
    if (task.decisionNeeded) lines.push("   needs your decision");
  });

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

async function authenticate(config, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.url}/api/admins/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: config.identity, password: config.password }),
  });

  if (!response.ok) {
    throw new Error(`Factory authentication failed (HTTP ${response.status}). Check FACTORY_PB_IDENTITY and FACTORY_PB_PASSWORD.`);
  }

  const body = await response.json();
  const token = body.token || body.admin?.token;
  if (!token) throw new Error("Factory authentication returned no token.");
  return token;
}

async function request(config, path, { method = "GET", body, token, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${config.url}${path}`, {
    method,
    headers: {
      Authorization: token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`Factory request failed (HTTP ${response.status}): ${parsed.message || text}`);
  }

  return parsed;
}

/** Fetches the task queue. */
export async function listTasks(config, options = {}, fetchImpl = fetch) {
  const token = await authenticate(config, fetchImpl);
  const filter = buildTaskFilter(options);
  const query = new URLSearchParams({
    perPage: String(options.limit || 50),
    filter,
    sort: "-created",
  });

  const body = await request(
    config,
    `/api/collections/${TASKS_COLLECTION}/records?${query}`,
    { token, fetchImpl },
  );

  return sortTasks((body.items || []).map(mapTaskRecord));
}

/** Claims a task: marks it in_progress with the given session. */
export async function claimTask(config, { recordId, sessionId, now }, fetchImpl = fetch) {
  if (!recordId) throw new Error("recordId is required to claim a task.");

  const token = await authenticate(config, fetchImpl);
  const patch = buildClaimPatch({ sessionId, machineId: config.machineId, now });

  const body = await request(
    config,
    `/api/collections/${TASKS_COLLECTION}/records/${recordId}`,
    { method: "PATCH", body: patch, token, fetchImpl },
  );

  return mapTaskRecord(body);
}

/** Reports a status change for a task. */
export async function updateTaskStatus(config, { recordId, status, reason, nextAction, now }, fetchImpl = fetch) {
  if (!recordId) throw new Error("recordId is required to update a task.");

  const token = await authenticate(config, fetchImpl);
  const patch = buildStatusPatch({ status, reason, nextAction, now });

  const body = await request(
    config,
    `/api/collections/${TASKS_COLLECTION}/records/${recordId}`,
    { method: "PATCH", body: patch, token, fetchImpl },
  );

  return mapTaskRecord(body);
}
