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
    startedAt: sessionStartedAt || "",
    // Judul percakapan OpenCode, bila bisa dibaca. Dipakai kartu di tablet
    // supaya orang tahu sesi mana yang dimaksud, bukan kode `ses_...`.
    // Bila kosong, jatuh ke taskDescription agar kartu di monitor tetap informatif.
    sessionTitle: cleanTitle,
    // Alat AI pemanggil: codex, antigravity, opencode, atau unknown bila tidak
    // ada petunjuk. Tidak pernah menebak.
    agentTool: detectTool({ env, commandLine: String(process.argv.slice(0, 2).join(' ')) }),
    activeBuild: s.activeBuild && typeof s.activeBuild === "object" ? s.activeBuild : null,
    // Lokasi proyek. Path lokal menjawab "ada di mana" untuk mesin ini; remote
    // git tetap berguna dari perangkat lain. Dikosongkan bila memang bukan repo.
    repositoryPath: String(s.repository?.path || ""),
    repositoryRemote: String(s.repository?.remote || ""),
  };
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

export { sessionTitle, updateSessionTitle };





