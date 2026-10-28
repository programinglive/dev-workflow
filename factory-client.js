/**
 * Factory task integration for the real Factory API.
 *
 * Factory keeps tasks in SQLite table `factory_tasks` and only exposes three
 * write paths:
 *   - POST /api/factory  { action: create_task | move_task | update_task }
 *   - POST /api/work     { action: start | heartbeat | finish }
 *
 * There is no "set any status" endpoint. `running` is a work session, and
 * `review` / `blocked` / `paused` are outcomes of finishing that session.
 * `done` is an approval that the owner may record, but Factory accepts it only
 * for a task that is already in `review`. This module encodes those rules
 * instead of pretending the API is a generic CRUD store.
 *
 * Authentication uses a PocketBase `activity_users` token sent as a Bearer
 * header, which Factory accepts for non-browser clients. The token can be
 * supplied directly (FACTORY_TOKEN) or obtained from an email/password pair.
 *
 * Every network call accepts an optional fetch implementation so the rules
 * above can be tested without a live Factory.
 */

import { createHash, randomUUID } from "crypto";
import os from "os";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

export const DEFAULT_POCKETBASE_URL = "https://pocketbase.programinglive.com";

/** Statuses that still need attention. `done` and `cancelled` are terminal. */
export const ACTIVE_STATUSES = ["running", "queued", "backlog", "review", "blocked"];

/** Every status Factory can actually hold. */
export const VALID_STATUSES = ["backlog", "queued", "running", "review", "blocked", "done", "cancelled"];

/** Statuses reachable by finishing a work session, and the matching outcome. */
const WORK_OUTCOMES = { review: "review", blocked: "blocked", paused: "paused" };

/** Statuses reachable through POST /api/factory { action: move_task }. */
const MOVABLE_STATUSES = ["backlog", "queued", "cancelled", "done"];

/**
 * Values accepted by POST /api/factory { action: create_task }.
 *
 * `queued` is deliberately not the default: Factory enqueues a worker run for
 * it and rejects the task (409) unless `acceptance` contains a ```run block.
 */
const CREATABLE_STATUSES = ["backlog", "queued"];
const CREATABLE_PRIORITIES = ["low", "normal", "high"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_ORDER = { running: 0, queued: 1, backlog: 2, review: 3, blocked: 4, done: 5, cancelled: 6 };
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

const TOKEN_TTL_MS = 10 * 60 * 1000;
const tokenCache = new Map();

function clean(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

/**
 * Reads Factory configuration from an environment object.
 *
 * Returns null unless a URL and one usable credential set are present. Two
 * credential shapes are supported:
 *   - FACTORY_TOKEN (a PocketBase activity_users token)
 *   - FACTORY_EMAIL + FACTORY_PASSWORD (exchanged for a token on demand)
 */
export function readFactoryConfig(env = process.env) {
  const url = clean(env.FACTORY_URL) || clean(env.FACTORY_API_URL);
  if (!url) return null;

  const token = clean(env.FACTORY_TOKEN);
  const email = clean(env.FACTORY_EMAIL);
  const password = clean(env.FACTORY_PASSWORD);
  if (!token && !(email && password)) return null;

  return {
    url: trimSlash(url),
    token,
    email,
    password,
    pocketBaseUrl: trimSlash(clean(env.FACTORY_PB_URL) || DEFAULT_POCKETBASE_URL),
    machineId: clean(env.FACTORY_MACHINE_ID),
    deviceId: clean(env.FACTORY_DEVICE_ID),
    // Berkas identitas perangkat yang dipakai bersama dengan CLI Factory.
    // Tanpa ini satu mesin muncul sebagai dua perangkat di papan.
    deviceFile: clean(env.FACTORY_DEVICE_FILE),
    agent: clean(env.FACTORY_AGENT) || "dev-workflow-mcp",
    // Sesi editor yang sedang berjalan. Papan Factory memakainya untuk
    // menunjukkan sesi mana yang mengerjakan, bukan hanya perangkatnya.
    clientSessionId: clean(env.OPENCODE_SESSION_ID) || clean(env.CLIENT_SESSION_ID),
    clientSessionTitle: clean(env.OPENCODE_SESSION_TITLE) || clean(env.CLIENT_SESSION_TITLE),
  };
}

export function isConfigured(env = process.env) {
  return readFactoryConfig(env) !== null;
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/**
 * Derives a stable UUID from a name (same input, same id).
 *
 * Factory keys devices by UUID, so a random id per process would create a new
 * device row on every run. Deriving it from the machine name keeps one row per
 * machine without needing a state file.
 */
export function deviceIdFor(seed) {
  const hash = createHash("sha1").update(String(seed || "dev-workflow-mcp")).digest("hex").split("");
  hash[12] = "5";
  hash[16] = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  const value = hash.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join("-");
}

/**
 * Reads the device id this machine shares with the Factory CLI.
 *
 * The CLI stores a random UUID in `~/.config/programinglive-factory/device.json`.
 * The MCP server used to derive its own id from the machine name, so one
 * machine appeared as two devices on the board and a task held by the other
 * tool looked like another machine's work. Reading and creating the same file
 * keeps one machine to one identity, whichever tool runs first.
 *
 * Returns null when the file cannot be used, so the caller falls back to the
 * name-derived id instead of failing to claim at all.
 */
export function sharedDeviceId(deviceFile) {
  if (!deviceFile) return null;
  try {
    const id = JSON.parse(readFileSync(deviceFile, "utf8"))?.id;
    if (typeof id === "string" && UUID_RE.test(id)) return id;
  } catch {
    // Berkas belum ada atau rusak: dibuat di bawah.
  }

  const id = randomUUID();
  try {
    mkdirSync(path.dirname(deviceFile), { recursive: true, mode: 0o700 });
    // "wx" gagal kalau proses lain menang balapan; id itu yang dipakai.
    writeFileSync(deviceFile, JSON.stringify({ id }), { flag: "wx", mode: 0o600 });
    return id;
  } catch {
    try {
      const existing = JSON.parse(readFileSync(deviceFile, "utf8"))?.id;
      if (typeof existing === "string" && UUID_RE.test(existing)) return existing;
    } catch {
      // Tetap gagal: biar pemanggil memakai id turunan nama mesin.
    }
    return null;
  }
}

/** Builds the `device` object Factory expects on every work call. */
export function deviceFromConfig(config) {
  const name = (config.machineId || os.hostname() || "unknown").slice(0, 100);
  return {
    id: config.deviceId || sharedDeviceId(config.deviceFile) || deviceIdFor(name),
    name,
    platform: String(process.platform).slice(0, 60),
    agent: String(config.agent || "dev-workflow-mcp").slice(0, 40),
  };
}

/**
 * Sesi editor yang sedang berjalan, kalau diketahui.
 *
 * Papan Factory memakai ini untuk menjawab "sesi mana yang mengerjakan task
 * ini", bukan sekadar "perangkat mana". Tanpa nilai, sesi kerja tetap dibuat -
 * perangkat lama tidak boleh gagal hanya karena variabel ini belum diset.
 */
export function clientSessionFromConfig(config) {
  const id = String(config?.clientSessionId || "").trim();
  if (!id) return null;
  return { id: id.slice(0, 120), title: String(config?.clientSessionTitle || "").trim().slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Record mapping and ordering
// ---------------------------------------------------------------------------

/**
 * Maps a Factory task row to the shape the agent consumes.
 *
 * `projects` is the project list returned by the same API call, used to turn
 * the opaque projectId into a readable name.
 */
export function mapTaskRecord(record = {}, projects = []) {
  const byId = new Map((projects || []).map((project) => [project.id, project.name]));
  const work = record.work || null;

  return {
    id: record.id ?? null,
    taskKey: record.id ? String(record.id).slice(0, 8) : null,
    title: record.title ?? null,
    status: record.status ?? null,
    priority: record.priority || "normal",
    projectId: record.projectId ?? null,
    projectName: byId.get(record.projectId) ?? null,
    description: record.description || null,
    acceptance: record.acceptance || null,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    work: work
      ? {
          id: work.id ?? null,
          state: work.state ?? null,
          activityStatus: work.activityStatus ?? null,
          step: work.step ?? null,
          summary: work.summary ?? null,
          deviceName: work.device?.name ?? null,
          startedAt: work.startedAt ?? null,
        }
      : null,
  };
}

/**
 * Orders tasks so the most actionable one comes first: status, then priority.
 * Returns a new array; the input is not mutated.
 */
export function sortTasks(tasks = []) {
  return [...tasks].sort((a, b) => {
    const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    return (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
  });
}

/** Human-readable rendering of a task queue. */
export function formatTaskList(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return "No tasks in the Factory queue match this filter.";
  }

  const lines = [`${tasks.length} task(s) in Factory:`, ""];

  tasks.forEach((task, index) => {
    const meta = [task.status, task.priority, task.projectName].filter(Boolean).join(" · ");
    lines.push(`${index + 1}. [${task.taskKey || task.id}] ${task.title}`);
    if (meta) lines.push(`   ${meta}`);
    if (task.work?.state === "active") {
      const who = task.work.deviceName ? ` on ${task.work.deviceName}` : "";
      lines.push(`   active session${who}${task.work.step ? `: ${task.work.step}` : ""}`);
    }
    if (task.acceptance) lines.push(`   acceptance: ${firstLine(task.acceptance)}`);
  });

  return lines.join("\n");
}

function firstLine(value) {
  const line = String(value).split(/\r?\n/).find((part) => part.trim() !== "") || "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

// ---------------------------------------------------------------------------
// Status transition rules
// ---------------------------------------------------------------------------

/**
 * Decides which Factory endpoint can produce a status, before any network call.
 *
 * Throws for statuses the agent must not set, so the caller gets an actionable
 * message instead of a silent no-op.
 */
export function planStatusTransition(status) {
  const value = typeof status === "string" ? status.trim() : "";

  // `paused` is a work outcome, not a task status: Factory stores it as
  // backlog after the session closes. Handle outcomes before the status check.
  if (WORK_OUTCOMES[value]) {
    return { kind: "work-finish", outcome: WORK_OUTCOMES[value] };
  }

  if (!VALID_STATUSES.includes(value)) {
    throw new Error(`Unknown status "${value}". Factory accepts: ${VALID_STATUSES.join(", ")}.`);
  }

  if (value === "running") {
    throw new Error(
      "Use claim_factory_task to move a task to running: Factory records that as a work session, not a status edit.",
    );
  }

  // MOVABLE_STATUSES: backlog, queued, cancelled, done
  return { kind: "move", status: value };
}

/** Payload for POST /api/work { action: "start" }. */
export function buildWorkStartPayload({ taskId, device, step, takeoverReason, clientSession, now = null } = {}) {
  if (!taskId) throw new Error("taskId is required to start a work session.");
  if (!device?.id) throw new Error("A device with an id is required to start a work session.");
  // Alasan yang hanya berisi spasi dianggap tidak ada, jadi Factory tetap
  // menjawab dengan permintaan alasan takeover, bukan pesan format.
  const reason = typeof takeoverReason === "string" ? takeoverReason.trim() : "";
  return {
    action: "start",
    taskId,
    device,
    step: String(step || "Working on the task").slice(0, 240),
    ...(reason ? { takeoverReason: reason } : {}),
    ...(clientSession?.id ? { clientSession: { id: String(clientSession.id).slice(0, 120), title: String(clientSession.title || "").slice(0, 200) } } : {}),
    ...(now ? { now } : {}),
  };
}

/** Payload for POST /api/work { action: "finish" }. */
export function buildWorkFinishPayload({ sessionId, deviceId, outcome, summary, now = null } = {}) {
  if (!sessionId) throw new Error("sessionId is required to finish a work session.");
  if (!deviceId) throw new Error("deviceId is required to finish a work session.");
  if (!WORK_OUTCOMES[outcome]) {
    throw new Error(`Unknown work outcome "${outcome}". Expected one of: ${Object.keys(WORK_OUTCOMES).join(", ")}.`);
  }

  const text = typeof summary === "string" ? summary.trim() : "";
  if (text.length < 3) throw new Error("A summary of at least 3 characters is required to finish a work session.");

  return {
    action: "finish",
    sessionId,
    deviceId,
    outcome,
    summary: text.slice(0, 2000),
    ...(now ? { now } : {}),
  };
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

async function resolveToken(config, fetchImpl = fetch) {
  if (config.token) return config.token;

  const key = `${config.pocketBaseUrl}|${config.email}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const response = await fetchImpl(`${config.pocketBaseUrl}/api/collections/activity_users/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: config.email, password: config.password }),
  });

  if (!response.ok) {
    throw new Error(
      `Factory login failed (HTTP ${response.status}). Check FACTORY_EMAIL and FACTORY_PASSWORD, or set FACTORY_TOKEN.`,
    );
  }

  const body = await response.json();
  if (!body.token) throw new Error("Factory login returned no token.");

  tokenCache.set(key, { token: body.token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return body.token;
}

/** Test helper: forget cached tokens (for example after a password change). */
export function clearTokenCache() {
  tokenCache.clear();
}

async function request(config, path, { method = "GET", body, fetchImpl = fetch } = {}) {
  const token = await resolveToken(config, fetchImpl);
  const response = await fetchImpl(`${config.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const detail = parsed.error || parsed.message || text || response.statusText;
    // Body dan status ikut dibawa ke pemanggil, supaya penolakan takeover
    // bisa diterjemahkan jadi arahan yang bisa dijalankan.
    const error = new Error(`Factory request failed (HTTP ${response.status}): ${detail}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }

  return parsed;
}

/** Reads the whole workspace: projects, tasks and events. */
export async function readWorkspace(config, fetchImpl = fetch) {
  return request(config, "/api/factory", { fetchImpl });
}

/**
 * Lists tasks, newest first inside each status group.
 *
 * Factory returns every task of the owner in one payload, so filtering happens
 * here. That keeps the client usable against older servers without query
 * parameters.
 */
export async function listTasks(config, options = {}, fetchImpl = fetch) {
  const workspace = await readWorkspace(config, fetchImpl);
  const statuses = Array.isArray(options.statuses) && options.statuses.length ? options.statuses : ACTIVE_STATUSES;
  const project = typeof options.project === "string" ? options.project.trim().toLowerCase() : "";
  const limit = Number.isFinite(options.limit) ? Math.min(Math.max(options.limit, 1), 200) : 50;

  const mapped = (workspace.tasks || [])
    .map((task) => mapTaskRecord(task, workspace.projects || []))
    .filter((task) => statuses.includes(task.status))
    .filter((task) => {
      if (!project) return true;
      return [task.projectId, task.projectName].filter(Boolean).some((value) => String(value).toLowerCase().includes(project));
    });

  return sortTasks(mapped).slice(0, limit);
}

/** Finds one task by id, or null. */
export async function findTask(config, taskId, fetchImpl = fetch) {
  const workspace = await readWorkspace(config, fetchImpl);
  const record = (workspace.tasks || []).find((task) => task.id === taskId);
  if (!record) return null;
  return mapTaskRecord(record, workspace.projects || []);
}

/**
 * Claims a task by opening a work session, which is what makes it `running` in
 * the Factory UI.
 */
export async function claimTask(config, { recordId, device, step, takeoverReason } = {}, fetchImpl = fetch) {
  if (!recordId) throw new Error("recordId is required to claim a task.");

  const payload = buildWorkStartPayload({
    taskId: recordId,
    device: device || deviceFromConfig(config),
    step,
    takeoverReason,
    clientSession: clientSessionFromConfig(config),
  });
  const body = await request(config, "/api/work", { method: "POST", body: payload, fetchImpl });
  const session = body.session || null;
  if (!session) return null;
  // Pemanggil perlu tahu kalau ia baru menggeser perangkat lain, supaya bisa
  // melaporkan pengambil alihan itu, bukan menyebutnya klaim biasa.
  return { ...session, tookOver: Boolean(body.tookOver), previousHolder: body.previousHolder || null };
}

/**
 * Reports that a work session is still alive, and what it is doing.
 *
 * Factory marks a session stale after 120 seconds without a report, so a
 * claimed task that never reports looks abandoned on the board even while the
 * work continues. `step` is optional: the server keeps the previous value.
 */
export async function heartbeatWork(config, { sessionId, deviceId, step, clientSession } = {}, fetchImpl = fetch) {
  if (!sessionId) throw new Error("sessionId is required to report a heartbeat.");
  if (!deviceId) throw new Error("deviceId is required to report a heartbeat.");

  const text = typeof step === "string" ? step.trim() : "";
  const payload = {
    action: "heartbeat",
    sessionId,
    deviceId,
    ...(text ? { step: text.slice(0, 240) } : {}),
    ...(clientSession?.id ? { clientSession: { id: String(clientSession.id).slice(0, 120), title: String(clientSession.title || "").slice(0, 200) } } : {}),
  };
  const body = await request(config, "/api/work", { method: "POST", body: payload, fetchImpl });
  return body.session || null;
}

/**
 * Finishes the active work session of a task.
 *
 * Factory only accepts an outcome for a session that exists and belongs to the
 * caller's device, so both are checked first to produce a clear message.
 */
export async function finishWork(config, { taskId, outcome, summary, device } = {}, fetchImpl = fetch) {
  const deviceId = (device || deviceFromConfig(config)).id;
  const task = await findTask(config, taskId, fetchImpl);
  if (!task) throw new Error(`No task with id "${taskId}" is visible to this account.`);

  const session = task.work;
  if (!session || session.state !== "active") {
    throw new Error(
      `Task "${task.title}" has no active work session. Use claim_factory_task first, then report the outcome.`,
    );
  }

  const payload = buildWorkFinishPayload({ sessionId: session.id, deviceId, outcome, summary });
  const body = await request(config, "/api/work", { method: "POST", body: payload, fetchImpl });
  return body.session || null;
}

/**
 * Reports a status change using the one Factory endpoint that supports it.
 *
 * - review / blocked / paused -> finish the active work session
 * - backlog / queued / cancelled -> move_task
 * - running / done -> rejected with an explanation
 */
export async function updateTaskStatus(config, { recordId, status, reason, nextAction, device } = {}, fetchImpl = fetch) {
  if (!recordId) throw new Error("recordId is required to update a task.");

  const plan = planStatusTransition(status);

  if (plan.kind === "move") {
    await request(config, "/api/factory", {
      method: "POST",
      body: { action: "move_task", id: recordId, status: plan.status },
      fetchImpl,
    });
    return { id: recordId, status: plan.status };
  }

  const summary = buildSummary({ reason, nextAction, status });
  const session = await finishWork(config, { taskId: recordId, outcome: plan.outcome, summary, device }, fetchImpl);
  return { id: recordId, status: plan.outcome, session };
}

/**
 * Creates a task on the Factory board.
 *
 * Factory validates the payload strictly (see its zod schema), so the same
 * limits are enforced here to give the agent an actionable message instead of
 * an opaque HTTP 400.
 *
 * `status` defaults to `backlog` on purpose. Factory only enqueues a worker run
 * for `queued`, and a queued task without a ```run block is rejected with 409.
 * Recording work should never start execution as a side effect.
 */
export async function createTask(config, input = {}, fetchImpl = fetch) {
  const projectId = clean(input.projectId);
  const title = clean(input.title) || "";
  const description = clean(input.description) || "";
  const acceptance = clean(input.acceptance) || "";
  const priority = clean(input.priority) || "normal";
  const status = clean(input.status) || "backlog";

  if (!projectId) throw new Error("projectId is required. Use list_factory_projects to find one.");
  if (!UUID_RE.test(projectId)) throw new Error(`projectId "${projectId}" is not a UUID.`);
  if (title.length < 3 || title.length > 140) {
    throw new Error("title must be 3-140 characters.");
  }
  if (acceptance.length < 3 || acceptance.length > 3000) {
    throw new Error("acceptance must be 3-3000 characters and should state what proves the work is done.");
  }
  if (description.length > 4000) throw new Error("description must be at most 4000 characters.");
  if (!CREATABLE_PRIORITIES.includes(priority)) {
    throw new Error(`priority must be one of: ${CREATABLE_PRIORITIES.join(", ")}.`);
  }
  if (!CREATABLE_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${CREATABLE_STATUSES.join(", ")}.`);
  }

  const body = await request(config, "/api/factory", {
    method: "POST",
    body: { action: "create_task", task: { projectId, title, description, acceptance, priority, status } },
    fetchImpl,
  });

  return { id: body.id ?? null, runId: body.runId ?? null, status };
}

/** Lists the owner's projects so a task can reference a real projectId. */
export async function listProjects(config, fetchImpl = fetch) {
  const workspace = await readWorkspace(config, fetchImpl);
  return (workspace.projects || []).map((project) => ({
    id: project.id ?? null,
    name: project.name ?? null,
    repository: project.repository ?? null,
    branch: project.branch ?? null,
    stack: project.stack ?? null,
  }));
}

/** Human-readable rendering of the project list. */
export function formatProjectList(projects = []) {
  if (!Array.isArray(projects) || projects.length === 0) {
    return "No projects in this Factory workspace yet. Create one in the Factory UI first.";
  }

  const lines = [`${projects.length} project(s) in Factory:`, ""];
  projects.forEach((project, index) => {
    lines.push(`${index + 1}. ${project.name}  [${project.id}]`);
    const meta = [project.stack, project.branch].filter(Boolean).join(" · ");
    if (meta) lines.push(`   ${meta}`);
    if (project.repository) lines.push(`   ${project.repository}`);
  });
  return lines.join("\n");
}

/** Builds the finish summary, which Factory requires (3-2000 chars). */
export function buildSummary({ reason, nextAction, status } = {}) {
  const parts = [clean(reason), clean(nextAction)].filter(Boolean);
  const text = parts.length ? parts.join(" — ") : `Status dilaporkan sebagai ${clean(status) || "review"}.`;
  return text.length < 3 ? `${text} (dilaporkan agen)` : text.slice(0, 2000);
}

export { MOVABLE_STATUSES, WORK_OUTCOMES, CREATABLE_STATUSES, CREATABLE_PRIORITIES };
