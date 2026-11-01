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

const DEFAULT_TIMEOUT_MS = 1200;

export function monitorUrl(env = process.env) {
  return typeof env.DEVWF_MONITOR_URL === "string" ? env.DEVWF_MONITOR_URL.trim() : "";
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

/** Ringkasan satu sesi, bentuk yang dipakai dashboard. */
export function buildSnapshot({ state, sessionKey = "", projectPath = "", sessionStartedAt = "", env = process.env } = {}) {
  const s = state || {};
  const plan = Array.isArray(s.plan) ? s.plan : [];
  const dod = Array.isArray(s.definitionOfDone) ? s.definitionOfDone : [];
  const revision = Number(s.dodRevision) || 0;

  const dodDone = dod.filter((i) => i && i.status === "done" && Number(i.revision) === revision).length;
  const dodWaived = dod.filter((i) => i && i.status === "waived").length;

  const projectName = String(projectPath || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || "";

  return {
    sessionKey,
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
export function eventFor(state, kind, detail = "") {
  const s = state || {};
  const projectPath = String(s.projectDir || "");
  return {
    sessionKey: "",
    kind,
    detail: String(detail || "").slice(0, 1000),
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
export async function reportEventSafe(state, kind, detail = "") {
  try {
    const payload = eventFor(state, kind, detail);
    return await reportEvent({ event: payload }).catch(() => false);
  } catch {
    return false;
  }
}




