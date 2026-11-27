/**
 * @zettly-code DWF-CLAIM-MONITOR-001
 * @purpose Broadcast session snapshots with open-source-safe activeClaim metadata to the optional DevWorkflow Monitor.
 */
/**
 * Mengirim snapshot state ke monitor pusat - dan TIDAK PERNAH menggagalkan
 * pekerjaan kalau monitor mati.
 *
 * MENGAPA JALUR TERPISAH
 * ---------------------
 * Adapter database yang ada menyimpan per (user, proyek) dan tidak mengenal
 * sesi, mesin, rencana, atau fase. Yang dibutuhkan dashboard adalah "apa yang
 * sedang dikerjakan, di mana, sampai langkah berapa" - satu baris per sesi.
 * Jadi laporan ini jalur sendiri, bukan memperluas skema riwayat.
 *
 * ATURAN KERAS
 * ------------
 * 1. Tidak pernah melempar: monitor yang mati tidak boleh menghentikan commit
 *    atau menyimpan state.
 * 2. Tidak pernah menahan: permintaan dibatasi 2 detik dan tidak ditunggu.
 * 3. Tidak pernah mengirim isi berkas, hanya metadata yang memang sudah
 *    ditampilkan `get_workflow_status`.
 * 4. Tidak dikirim bila `DEVWF_MONITOR_URL` kosong - default-nya mati.
 */

import os from "node:os";
import {buildTaskProvenance} from './task-provenance.js';
import { createRequire } from "node:module";

// Judul sesi dibaca dari opencode.db. Dimuat lewat createRequire + try/catch
// supaya mesin tanpa berkas itu (mis. CLI saja) tetap jalan seperti biasa.
const requireCjs = createRequire(import.meta.url);
let sessionTitle = () => "";
let updateSessionTitle = () => false;
let detectTool = () => "unknown";
try {
  ({ sessionTitle, updateSessionTitle } = requireCjs("./opencode-session-title.cjs"));
  ({ detectTool } = requireCjs("./agent-tool.cjs"));

  if (typeof sessionTitle !== "function") sessionTitle = () => "";
  if (typeof updateSessionTitle !== "function") updateSessionTitle = () => false;
  if (typeof detectTool !== "function") detectTool = () => "unknown";
} catch {
  sessionTitle = () => "";
  updateSessionTitle = () => false;
  detectTool = () => "unknown";
}

const DEFAULT_TIMEOUT_MS = 1200;

export function monitorUrl(env = process.env) {
  return typeof env.DEVWF_MONITOR_URL === "string" ? env.DEVWF_MONITOR_URL.trim() : "";
}

/**
 * URL lokal monitor server yang bisa dibuka di browser dari mesin ini.
 * Dibaca dari DEVWF_LOCAL_URL. Bila tidak dikonfigurasi, dikosongkan (tidak
 * ditampilkan) agar tidak menyajikan URL yang salah.
 */
export function localMonitorUrl(env = process.env) {
  return typeof env.DEVWF_LOCAL_URL === "string" ? env.DEVWF_LOCAL_URL.trim() : "";
}

export function machineName(env = process.env) {
  const explicit = typeof env.DEVWF_MACHINE === "string" ? env.DEVWF_MACHINE.trim() : "";
  if (explicit) return explicit;
  try {
    return os.hostname();
  } catch {
    return "unknown";
  }
}

/**
 * Generate a unique card key per topic within a session (Zettelkasten card identity).
 */
export function cardKeyFor(sessionKey, title, taskId = '') {
  const baseKey = String(sessionKey || '').trim();
  if (!baseKey) return '';
  const cleanTitle = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!cleanTitle && !taskId) return baseKey;
  const tag = cleanTitle || String(taskId || '').slice(0, 16);
  return `${baseKey}::${tag}`;
}

/** Ringkasan satu sesi, bentuk yang dipakai dashboard. */
export function buildSnapshot({ state, sessionKey = "", projectPath = "", sessionStartedAt = "", env = process.env } = {}) {
  const s = state || {};  const plan = Array.isArray(s.plan) ? s.plan : [];
  const dod = Array.isArray(s.definitionOfDone) ? s.definitionOfDone : [];
  const revision = Number(s.dodRevision) || 0;

  const dodDone = dod.filter((i) => i && i.status === "done" && Number(i.revision) === revision).length;
  const dodWaived = dod.filter((i) => i && i.status === "waived").length;

  const projectName = String(projectPath || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || "";

  const cleanTitle = sessionTitle(sessionKey, env) || String(s.taskDescription || "").slice(0, 200);

  // Zettelkasten chaining: one card per task, so the server needs the task's
  // identity and, when this card continues a previous one, the identity of
  // the previous card. A parent without an id is treated as absent so it can
  // never create a false link.
  //
  // Two parent shapes coexist after the merge: this lineage captured
  // {taskId, title, startedAt}; main's assignWorkflowIdentity captures
  // {id, description, title, todoId}. Both normalize to one record.
  const taskId = String(s.workflowTaskId || "");
  const phase = String(s.currentPhase || "idle");
  const isClaimed = Boolean(
    phase &&
      !["idle", "closed", "done", "cancelled", "archived", "handed-off"].includes(phase) &&
      String(s.taskDescription || "").trim() !== "",
  );
  const sentryLink = s.zettly?.externalLinks?.sentry || null;
  const origin = s.taskOrigin && typeof s.taskOrigin === "object" ? s.taskOrigin : null;
  const sentryIssueId = String(
    sentryLink?.issueId || (origin?.system === "sentry" ? origin.id : "") || "",
  ).trim();
  const sentryShortId = String(
    sentryLink?.shortId || (origin?.system === "sentry" && origin.label !== origin.id ? origin.label : "") || "",
  ).trim();
  const activeClaim = {
    claimed: isClaimed,
    status: isClaimed ? "in_progress" : "idle",
    taskId,
    todoId: Number.isSafeInteger(Number(s.zettly?.todoId)) && Number(s.zettly?.todoId) > 0 ? Number(s.zettly.todoId) : null,
    source: origin && origin.system ? { system: String(origin.system), id: String(origin.id || ""), label: String(origin.label || "") } : null,
    sentryIssueId: sentryIssueId || null,
    sentryShortId: sentryShortId || null,
  };
  const parent = s.parentTask && typeof s.parentTask === "object" ? s.parentTask : null;
  const parentId = parent ? String(parent.taskId || parent.id || "") : "";
  const parentTask = parentId
    ? {
        taskId: parentId,
        title: String(parent.title || parent.description || ""),
        startedAt: String(parent.startedAt || ""),
      }
    : null;

  return {
    ...buildTaskProvenance(s),
    sessionKey,
    taskId,
    activeClaim,
    parentTask,
    machine: machineName(env),
    projectPath: String(projectPath || ""),
    projectName,
    task: String(s.taskDescription || ""),
    taskType: String(s.taskType || ""),
    phase: String(s.currentPhase || "idle"),
    plan,
    planDone: plan.filter((i) => i && i.status === "done").length,
    planTotal: plan.length,
    dodDone,
    dodTotal: dod.length,
    dodWaived,
    ownerPid: Number(s.owner && s.owner.pid) || null,
    // Process identity for the reaper. The public monitor payload does not
    // expose these; the privileged reaper API does.
    ownerStartedAt: String(s.owner?.startedAt || ""),
    ownerExecutable: String(s.owner?.executable || ""),
    startedAt: sessionStartedAt || "",
    // Judul percakapan OpenCode, bila bisa dibaca. Dipakai kartu di tablet
    // supaya orang tahu sesi mana yang dimaksud, bukan kode `ses_...`.
    // Bila kosong, jatuh ke taskDescription agar kartu di monitor tetap informatif.
    sessionTitle: cleanTitle,
    // Alat AI pemanggil: codex, antigravity, opencode, atau unknown bila tidak
    // ada petunjuk. Tidak pernah menebak.
    agentTool: detectTool({ env, commandLine: String(process.argv.slice(0, 2).join(' ')) }),
    activeBuild: s.activeBuild && typeof s.activeBuild === "object" ? s.activeBuild : null,
    // Refinement history. Bounded so a runaway session cannot bloat the
    // snapshot: the state file already caps the list, and this is the second
    // gate before it crosses the network.
    refinement: boundedRefinement(s.refinement),
    // Lokasi proyek. Path lokal menjawab "ada di mana" untuk mesin ini; remote
    // git tetap berguna dari perangkat lain. Dikosongkan bila memang bukan repo.
    repositoryPath: String(s.repository?.path || ""),
    repositoryRemote: String(s.repository?.remote || ""),
    // Release yang benar-benar menjalankan sesi ini. Diisi oleh bootstrap
    // managed saat ia men-spawn server; kosong pada instalasi tanpa bootstrap.
    // Tanpa ini "connected" tidak membedakan build baru dari build lama.
    releaseVersion: releaseVersion(env),
    releaseRevision: releaseRevision(env),
    // Versions of the tools the fleet depends on, so the monitor can show
    // whether every device really can run the same work.
    toolchain: cachedToolchain,
  };
}

function releaseVersion(env) {
  const value = typeof env.DEVWF_RELEASE_VERSION === "string" ? env.DEVWF_RELEASE_VERSION.trim() : "";
  return value.slice(0, 40);
}

/**
 * The refinement payload that crosses the network.
 *
 * Only the fields the monitor renders survive, and the history is capped here
 * as well as in the handler: an old state file written by a previous release
 * can still carry a longer list, and the snapshot must stay a fixed size no
 * matter what is on disk.
 */
function boundedRefinement(refinement) {
  if (!refinement || typeof refinement !== "object" || Array.isArray(refinement)) return null;

  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  const list = (value, max) => (Array.isArray(value)
    ? value.filter(item => typeof item === "string").slice(0, max).map(item => item.slice(0, 300))
    : []);

  const history = Array.isArray(refinement.history)
    ? refinement.history.slice(-10).map(entry => ({
        revision: Number(entry && entry.revision) || 0,
        at: text(entry && entry.at, 40),
        description: text(entry && entry.description, 2000),
        newContext: text(entry && entry.newContext, 4000),
        plan: list(entry && entry.plan, 20),
        definitionOfDone: list(entry && entry.definitionOfDone, 20),
      }))
    : [];

  return {
    revision: Number(refinement.revision) || 0,
    context: text(refinement.context, 8000),
    previousDescription: text(refinement.previousDescription, 2000),
    updatedAt: text(refinement.updatedAt, 40),
    history,
  };
}

function releaseRevision(env) {
  const value = typeof env.DEVWF_RELEASE_REVISION === "string" ? env.DEVWF_RELEASE_REVISION.trim() : "";
  return value.slice(0, 40);
}

/**
 * The detected tool versions, filled once per process.
 *
 * buildSnapshot is synchronous and runs on every report, so the versions are
 * detected asynchronously at startup and only READ here. Spawning `gh --version`
 * inside every snapshot would be both slow and pointless: a tool does not change
 * version mid-session.
 */
let cachedToolchain = null;

/** Stores the detected toolchain for later snapshots. */
export function setToolchain(toolchain) {
  cachedToolchain = toolchain && typeof toolchain === "object" ? toolchain : null;
}

/** The toolchain as last detected, or null before the first detection. */
export function getToolchain() {
  return cachedToolchain;
}

/**
 * Token bersama untuk endpoint tulis monitor.
 *
 * Kosong berarti header tidak dikirim sama sekali. Itu penting untuk monitor
 * lama yang belum mewajibkan token: pelaporan tetap jalan seperti sebelumnya,
 * dan server yang sudah mewajibkannya akan menolak dengan jelas di log.
 */
export function monitorToken(env = process.env) {
  return typeof env.DEVWF_MONITOR_TOKEN === "string" ? env.DEVWF_MONITOR_TOKEN.trim() : "";
}

async function post({ env, path, payload, fetchImpl, timeoutMs }) {
  const base = monitorUrl(env);
  if (!base || !payload) return false;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  const headers = { "content-type": "application/json" };
  const token = monitorToken(env);
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetchImpl(base.replace(/\/+$/, "") + path, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    return Boolean(response && response.ok);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Kirim snapshot. Mengembalikan true bila terkirim.
 *
 * Pemanggil pada jalur penyimpanan state sengaja TIDAK menunggu hasilnya:
 * laporan yang lambat tidak boleh memperlambat penyimpanan yang sedang terjadi.
 */
export async function reportSnapshot({ env = process.env, snapshot, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!snapshot) return false;
  return post({ env, path: "/api/session", payload: snapshot, fetchImpl, timeoutMs });
}

/** Kirim satu peristiwa (task dimulai, langkah selesai, commit, dst). */
export async function reportEvent({ env = process.env, event, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!event || !event.kind) return false;
  return post({ env, path: "/api/event", payload: { machine: machineName(env), ...event }, fetchImpl, timeoutMs });
}

/**
 * Ringkasan sesi untuk sebuah peristiwa, diambil dari state saat ini.
 *
 * Tanpa ini setiap pemanggil harus mengoper lima field yang sama, dan satu
 * pemanggil yang lupa akan menghasilkan baris tanpa nama proyek di dashboard.
 */
export function eventFor(state, kind, detail = "", sessionKey = "") {
  const s = state || {};
  const projectPath = String(s.projectDir || "");
  return {
    sessionKey,
    kind,
    detail: String(detail || "").slice(0, String(kind).startsWith("build_") ? 12000 : 1000),
    projectName: projectPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "",
    task: String(s.taskDescription || ""),
  };
}

/**
 * Kirim peristiwa tanpa pernah melempar, tetapi DITUNGGU.
 *
 * MENGAPA DITUNGGU: proses MCP/CLI bisa keluar segera setelah handler selesai
 * (`node index.js call ...`, sesi OpenCode ditutup). Permintaan yang tidak
 * ditunggu dibunuh sebelum terkirim, dan dashboard tidak pernah melihat
 * peristiwanya - gejala yang membuat tabel events tetap kosong meski handler
 * jelas memanggil fungsi ini.
 *
 * Batas waktunya ada di dalam `reportEvent` (1,2 detik); kegagalan apa pun
 * dikembalikan sebagai false dan tidak pernah dilempar ke pemanggil.
 */
export async function reportEventSafe(state, kind, detail = "", sessionKey = "") {
  try {
    const payload = eventFor(state, kind, detail, sessionKey);
    return await reportEvent({ event: payload }).catch(() => false);
  } catch {
    return false;
  }
}

/**
 * Ambil daftar sesi aktif dari monitor server.
 * Tidak pernah melempar: kegagalan jaringan dikembalikan sebagai { ok: false, error: ... }.
 */
export async function fetchActiveSessions({
  env = process.env,
  limit = 20,
  fetchImpl = fetch,
  timeoutMs = 3000,
} = {}) {
  const base = monitorUrl(env);
  if (!base) {
    return {
      ok: false,
      error: "DEVWF_MONITOR_URL tidak dikonfigurasi.",
      sessions: [],
    };
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  const headers = { "content-type": "application/json" };
  const token = monitorToken(env);
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));
    const url = `${base.replace(/\/+$/, "")}/api/sessions?limit=${lim}`;
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller ? controller.signal : undefined,
    });
    if (!response || !response.ok) {
      return {
        ok: false,
        error: `HTTP ${response ? response.status : "no response"} dari monitor server`,
        sessions: [],
      };
    }
    const data = await response.json();
    return {
      ok: true,
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      health: data.health || null,
      machines: Array.isArray(data.machines) ? data.machines : [],
      summary: Array.isArray(data.summary) ? data.summary : [],
      raw: data,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err && err.message ? err.message : err),
      sessions: [],
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ambil laporan durasi build dari monitor.
 *
 * Sama seperti fetchActiveSessions: tidak pernah melempar, timeout 3 detik, dan
 * kegagalan jaringan dikembalikan sebagai { ok: false, error }.
 */
export async function fetchBuildReport({
  env = process.env,
  days = 30,
  project = "",
  host = "",
  fetchImpl = fetch,
  timeoutMs = 3000,
} = {}) {
  const base = monitorUrl(env);
  if (!base) {
    return { ok: false, error: "DEVWF_MONITOR_URL tidak dikonfigurasi.", report: null };
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  const headers = { "content-type": "application/json" };
  const token = monitorToken(env);
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const params = new URLSearchParams({ days: String(Math.min(30, Math.max(1, Number(days) || 30))) });
    if (project) params.set("project", String(project));
    if (host) params.set("host", String(host));
    const url = `${base.replace(/\/+$/, "")}/api/builds/report?${params.toString()}`;
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller ? controller.signal : undefined,
    });
    if (!response || !response.ok) {
      return {
        ok: false,
        error: `monitor menjawab HTTP ${response ? response.status : "tidak diketahui"}`,
        report: null,
      };
    }
    const data = await response.json();
    return { ok: true, error: "", report: data || null };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), report: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { sessionTitle, updateSessionTitle };





