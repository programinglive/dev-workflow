/**
 * Satu penanda "proses MCP mana yang sedang hidup" per direktori state.
 *
 * Protokol Kepemilikan v2 (Gate-Serialized & Capability-Fenced):
 *   1. Semua mutasi dan verifikasi kritis pada `mcp-process.lock` diserialisasi
 *      melalui gerbang eksklusif lintas-proses (`mcp-process.gate.lock`) yang
 *      diterbitkan secara atomik menggunakan `writeFileSync(tmp) + linkSync(tmp, gate)`.
 *   2. Berkas lock utama (`mcp-process.lock`) selalu ditulis lengkap ke berkas
 *      sementara lalu dipasang secara atomik, sehingga pembaca tidak pernah
 *      melihat berkas 0-byte atau setengah tertulis (partial initialization).
 *   3. Kepemilikan diikat ke kapabilitas `(pid, leaseId, incarnationId)` —
 *      kesamaan PID saja TIDAK PERNAH memberikan hak adopsi, penyegaran detak
 *      jantung, masuk ulang (re-entry), atau pelepasan lock.
 *   4. Detak jantung yang terlambat/kedaluwarsa TIDAK PERNAH mengizinkan
 *      pengambilalihan selama proses pemegang asli masih hidup.
 *   5. Kegagalan I/O atau izin (`EACCES`, `ENOSPC`, dsb.) selalu gagal tertutup
 *      (`acquired: false, wrote: false`).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  linkSync,
  statSync,
  readdirSync,
} from "fs";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";

export const LOCK_FILENAME = "mcp-process.lock";
export const GATE_FILENAME = "mcp-process.gate.lock";
export const LOCK_PROTOCOL_VERSION = 2;

export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = Math.floor(DEFAULT_LOCK_STALE_MS / 3);
export const DEFAULT_GATE_TIMEOUT_MS = 5000;
export const PARTIAL_INIT_GRACE_MS = 80;

/** Waktu mulai proses OS ini (ms epoch) dan token inkarnasi unik proses ini. */
export const SELF_PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1000);
export const PROCESS_INCARNATION_ID = `inc-${process.pid}-${SELF_PROCESS_STARTED_AT_MS.toString(36)}-${randomUUID().slice(0, 8)}`;

/**
 * Error khusus saat proses kehilangan kepemilikan lock proyek di tengah operasi
 * penyimpanan (persistence fencing).
 */
export class ProjectOwnershipLostError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProjectOwnershipLostError";
    this.code = "PROJECT_OWNERSHIP_LOST";
    this.details = details;
  }
}

/** Peta lease aktif yang dipegang proses ini per direktori lock kanonik. */
const heldLeases = new Map();

/** Peta kedalaman re-entrancy gerbang lock untuk proses ini. */
const activeGateDepth = new Map();

/** Direktori lock dan lease aktif utama yang diingat proses ini. */
let rememberedLockDir = null;
let rememberedLeaseId = null;
let rememberedPid = null;
let rememberedIncarnationId = null;

/** Hanya untuk tes: mengganti pemeriksa "proses hidup" dan "proses pemegang". */
let isAliveOverride = null;
let isHolderOverride = null;

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  const duration = Math.max(1, Math.min(200, Math.trunc(Number(ms) || 1)));
  try {
    Atomics.wait(SLEEP_BUFFER, 0, 0, duration);
  } catch {
    const end = Date.now() + duration;
    while (Date.now() < end) {
      // Fallback spin bila Atomics.wait tidak tersedia di lingkungan khusus.
    }
  }
}

export function generateLeaseId(pid = process.pid, now = Date.now()) {
  let suffix = "";
  try {
    suffix = randomUUID().slice(0, 8);
  } catch {
    suffix = Math.random().toString(16).slice(2, 10);
  }
  return `lease-${pid}-${now}-${suffix}`;
}

export function isLegacyLock(lock) {
  if (!lock || typeof lock !== "object") return false;
  if (typeof lock.leaseId !== "string" || lock.leaseId.trim() === "") return true;
  if (Number.isFinite(Number(lock.protocolVersion)) && Number(lock.protocolVersion) < 2) {
    return true;
  }
  return false;
}

export function getRememberedLockLease() {
  return {
    dir: rememberedLockDir,
    leaseId: rememberedLeaseId,
    pid: rememberedPid,
    incarnationId: rememberedIncarnationId,
  };
}

export function getHeldLeaseForDir(dir, pid = process.pid) {
  if (!dir) return null;
  const resolved = path.resolve(dir);
  const entry = heldLeases.get(resolved);
  if (entry && entry.pid === pid) {
    return { ...entry };
  }
  if (
    rememberedLockDir &&
    path.resolve(rememberedLockDir) === resolved &&
    rememberedPid === pid &&
    rememberedLeaseId
  ) {
    return {
      dir: resolved,
      pid: rememberedPid,
      leaseId: rememberedLeaseId,
      incarnationId: rememberedIncarnationId,
    };
  }
  return null;
}

export function bindHeldLease({
  dir,
  pid = process.pid,
  leaseId,
  incarnationId = PROCESS_INCARNATION_ID,
  makePrimary = true,
} = {}) {
  if (!dir || !leaseId) return null;
  const resolved = path.resolve(dir);
  const record = {
    dir: resolved,
    pid,
    leaseId,
    incarnationId: incarnationId || PROCESS_INCARNATION_ID,
  };
  heldLeases.set(resolved, record);
  if (makePrimary) {
    rememberLockLease(record);
  }
  return { ...record };
}

export function clearHeldLeasesForTests() {
  heldLeases.clear();
  rememberedLockDir = null;
  rememberedLeaseId = null;
  rememberedPid = null;
  rememberedIncarnationId = null;
}

/** Lokasi berkas lock untuk satu direktori state. */
export function processLockPath({ dir }) {
  return path.join(dir, LOCK_FILENAME);
}

/** Lokasi berkas gerbang eksklusif untuk satu direktori state. */
export function processGatePath({ dir }) {
  return path.join(dir, GATE_FILENAME);
}

/**
 * Direktori `.state` milik PROYEK untuk sebuah berkas state.
 */
export function projectLockDir(stateFilePath) {
  const resolved = path.resolve(stateFilePath);
  let current = path.dirname(resolved);
  const { root } = path.parse(current);

  {
    let probe = path.dirname(resolved);
    const { root: probeRoot } = path.parse(probe);
    while (true) {
      if (path.basename(path.dirname(probe)) === "projects") {
        return probe;
      }
      const parent = path.dirname(probe);
      if (parent === probe || probe === probeRoot) {
        break;
      }
      probe = parent;
    }
  }

  while (true) {
    if (path.basename(current) === ".state") {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current || current === root) {
      break;
    }

    current = parent;
  }

  return path.dirname(resolved);
}

/**
 * Membaca status berkas lock secara eksplisit:
 *   - missing: berkas tidak ada
 *   - ok: berkas valid dengan pid numerik
 *   - corrupt: berkas ada tetapi bukan JSON valid / pid tidak valid
 *   - unreadable: berkas ada tetapi gagal dibaca karena izin/IO
 */
export function readProcessLockDetailed({ dir, waitForPartialInit = false }) {
  const file = processLockPath({ dir });
  const deadline = waitForPartialInit ? Date.now() + PARTIAL_INIT_GRACE_MS : 0;

  while (true) {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { status: "missing", lock: null };
      }
      return { status: "unreadable", lock: null, error };
    }

    try {
      const clean = typeof raw === "string" && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const parsed = JSON.parse(clean);
      if (!parsed || typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || parsed.pid <= 0) {
        return { status: "corrupt", lock: null, raw };
      }
      return { status: "ok", lock: parsed };
    } catch (error) {
      if (waitForPartialInit && Date.now() < deadline) {
        try {
          const st = statSync(file);
          if (Date.now() - st.mtimeMs <= PARTIAL_INIT_GRACE_MS) {
            sleepSync(5);
            continue;
          }
        } catch {
          return { status: "missing", lock: null };
        }
      }
      return { status: "corrupt", lock: null, error, raw };
    }
  }
}

/**
 * Membaca isi lock, atau null bila tidak ada / tidak terbaca.
 */
export function readProcessLock({ dir }) {
  const res = readProcessLockDetailed({ dir });
  return res.status === "ok" ? res.lock : null;
}

function defaultIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function isKnownDevWorkflowCommandLine(commandLine) {
  const text = String(commandLine || "").trim();
  if (!text) return false;
  // Tolak eksekusi `node -e` / `--eval` generik yang sering dipakai proses lain,
  // kecuali secara eksplisit menjalankan modul dev-workflow / process-lock.
  if (/\bnode(?:\.exe)?\b[^]*\s(?:-e|--eval)\b/i.test(text) || /\s(?:-e|--eval)\b/i.test(text)) {
    return /dev-workflow|ManagedMCP|process-lock|workflow-state|workflow-handlers/i.test(text);
  }
  return /ManagedMCP|dev-workflow|index\.m?js|cli\.m?js|process-lock|node:test|--test/i.test(text);
}

/**
 * Apakah proses dengan PID itu benar-benar pemegang lock dev-workflow yang
 * menulis berkas lock tersebut?
 *
 * Membedakan:
 *   1. Proses non-Node yang memakai ulang PID (mis. Calendar.app, notepad.exe).
 *   2. Proses Node.js LAIN yang memakai ulang PID (mis. `node -e ...` atau server
 *      lain, maupun proses baru yang lahir SETELAH `existingLock.startedAt`).
 *   3. Inkarnasi lama dari `process.pid` kita sendiri.
 *
 * Mengembalikan true/false bila bisa dipastikan, null bila tidak - dan null
 * selalu diperlakukan sebagai "masih hidup" (fail-closed).
 */
export function defaultIsHolderProcess(pid, existingLock = null) {
  if (!Number.isFinite(pid) || pid <= 0) return null;

  if (pid === process.pid) {
    if (existingLock && existingLock.incarnationId) {
      return existingLock.incarnationId === PROCESS_INCARNATION_ID;
    }
    return true;
  }

  const lockStartedAt = Number(existingLock?.processStartedAt ?? existingLock?.startedAt);

  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
          windowsHide: true,
        },
      );
      const text = String(out || "").trim();
      if (!text || /^INFO:/i.test(text)) {
        // PID tidak ditemukan di tabel proses OS (mis. PID sintetis pada unit test).
        return null;
      }
      const firstLine = text.split(/\r?\n/)[0] || "";
      const match = /^"([^"]+)"/.exec(firstLine);
      if (!match) return null;
      const imageName = match[1].toLowerCase();
      if (imageName !== "node.exe") {
        return false;
      }

      // Verifikasi baris perintah dan waktu lahir proses untuk mendeteksi PID
      // reuse oleh proses Node.js lain di Windows.
      try {
        const psScript =
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
          `if ($p) { [pscustomobject]@{ cmd = [string]$p.CommandLine; start = ([DateTimeOffset]($p.CreationDate)).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`;
        const cimOut = execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", psScript],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 3000,
            windowsHide: true,
          },
        );
        const cimText = String(cimOut || "").trim();
        if (cimText) {
          const info = JSON.parse(cimText);
          if (Number.isFinite(lockStartedAt) && Number.isFinite(info.start)) {
            // Bila proses OS lahir > 2.5 detik SETELAH lock ditulis, PID telah dipakai ulang.
            if (info.start > lockStartedAt + 2500) {
              return false;
            }
          }
          if (info.cmd) {
            return isKnownDevWorkflowCommandLine(info.cmd);
          }
        }
      } catch {
        // Gagal menginspeksi CIM: fail-closed (kembalikan null agar tidak mencuri lock).
        return null;
      }
      return true;
    } catch {
      return null;
    }
  }

  // Linux / POSIX: baca /proc/<pid>/cmdline bila tersedia, lalu ps.
  try {
    if (existsSync(`/proc/${pid}/cmdline`)) {
      const rawCmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+/g, " ").trim();
      if (!rawCmd) return false;
      if (!isKnownDevWorkflowCommandLine(rawCmd)) {
        return false;
      }
    }
  } catch {
    // Lanjutkan ke ps bila /proc tidak dapat dibaca.
  }

  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "etimes=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const line = String(out || "").trim();
    if (!line) return false;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) {
      return isKnownDevWorkflowCommandLine(line);
    }
    const elapsedSec = Number(match[1]);
    const command = match[2];
    if (Number.isFinite(lockStartedAt) && Number.isFinite(elapsedSec)) {
      const approxProcStart = Date.now() - elapsedSec * 1000;
      if (approxProcStart > lockStartedAt + 3000) {
        return false;
      }
    }
    return isKnownDevWorkflowCommandLine(command);
  } catch {
    return null;
  }
}

function safeHostname() {
  try {
    return os.hostname();
  } catch {
    return "";
  }
}

function lockStamp(lock) {
  const value = Number(lock?.heartbeatAt ?? lock?.updatedAt ?? lock?.startedAt);
  return Number.isFinite(value) ? value : 0;
}

function sameLockIdentity(a, b) {
  if (!a || !b) return false;
  if (a.pid !== b.pid) return false;
  if ((a.leaseId || null) !== (b.leaseId || null)) return false;
  if ((a.incarnationId || null) !== (b.incarnationId || null)) return false;
  if (Number.isFinite(a.startedAt) && Number.isFinite(b.startedAt) && a.startedAt !== b.startedAt) {
    return false;
  }
  return true;
}

/**
 * Menerbitkan berkas JSON secara atomik tanpa jendela berkas 0-byte:
 * tulis isi lengkap ke berkas sementara, lalu pasang dengan `linkSync` (eksklusif)
 * atau ganti di bawah perlindungan gerbang (`replaceIfExists`).
 */
function publishCompleteJsonFile(targetFile, payloadObj, { replaceIfExists = false, pid = process.pid } = {}) {
  const tmpFile = `${targetFile}.init.${pid}.${Date.now()}-${Math.random().toString(16).slice(2, 10)}.tmp`;
  const content = JSON.stringify(payloadObj);
  writeFileSync(tmpFile, content, { encoding: "utf8", flag: "wx" });
  try {
    try {
      linkSync(tmpFile, targetFile);
      return;
    } catch (linkError) {
      if (linkError && linkError.code === "EEXIST") {
        if (!replaceIfExists) {
          throw linkError;
        }
        // Di bawah gerbang eksklusif (`mcp-process.gate.lock`), kita berhak
        // mengganti berkas target secara atomik.
        renameSync(tmpFile, targetFile);
        return;
      }
      if (
        linkError &&
        (linkError.code === "ENOSYS" || linkError.code === "EXDEV" || linkError.code === "EPERM")
      ) {
        if (!replaceIfExists) {
          writeFileSync(targetFile, content, { encoding: "utf8", flag: "wx" });
          return;
        }
        renameSync(tmpFile, targetFile);
        return;
      }
      throw linkError;
    }
  } finally {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {}
  }
}

function isGateStale(gateFile, { isAlive, isHolderProcess, shouldConsultDefaultHolder, host }) {
  let raw;
  try {
    raw = readFileSync(gateFile, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    return false;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      const st = statSync(gateFile);
      return Date.now() - st.mtimeMs > 250;
    } catch {
      return false;
    }
  }

  const gatePid = Number(parsed?.pid);
  if (!Number.isFinite(gatePid) || gatePid <= 0) {
    return true;
  }

  const sameHost = !parsed.host || !host || parsed.host === host;
  if (!sameHost) return false;

  if (gatePid === process.pid) {
    if (parsed.incarnationId && parsed.incarnationId !== PROCESS_INCARNATION_ID) {
      return true;
    }
    return false;
  }

  if (!isAlive(gatePid)) {
    return true;
  }

  if (shouldConsultDefaultHolder) {
    const holder = isHolderProcess(gatePid, parsed);
    if (holder === false) {
      return true;
    }
  }

  return false;
}

function tryRecoverStaleGate(gateFile, expectedCheckFn) {
  if (typeof expectedCheckFn === "function" && !expectedCheckFn()) {
    return false;
  }
  const tombstone = `${gateFile}.stale.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    renameSync(gateFile, tombstone);
  } catch {
    return false;
  }
  try {
    unlinkSync(tombstone);
  } catch {}
  return true;
}

/**
 * Mengambil gerbang eksklusif (`mcp-process.gate.lock`) untuk satu direktori lock.
 * Mendukung re-entrancy di dalam proses & inkarnasi yang sama.
 */
function acquireLockGate(
  dir,
  {
    pid = process.pid,
    timeoutMs = DEFAULT_GATE_TIMEOUT_MS,
    isAlive = currentIsAlive(),
    isHolderProcess = currentIsHolderProcess(),
  } = {},
) {
  const resolvedDir = path.resolve(dir);
  const existingEntry = activeGateDepth.get(resolvedDir);
  if (existingEntry && existingEntry.pid === pid && existingEntry.incarnationId === PROCESS_INCARNATION_ID) {
    existingEntry.count += 1;
    let released = false;
    return {
      ok: true,
      reentrant: true,
      release() {
        if (released) return;
        released = true;
        existingEntry.count -= 1;
      },
    };
  }

  try {
    mkdirSync(resolvedDir, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: (error && (error.code || error.message)) || "EACCES",
    };
  }

  const gateFile = processGatePath({ dir: resolvedDir });
  const host = safeHostname();
  const shouldConsultDefaultHolder =
    isHolderProcess !== defaultIsHolderProcess ||
    (isAlive === defaultIsAlive && !isAliveOverride);
  const deadline = Date.now() + Math.max(50, Number(timeoutMs) || DEFAULT_GATE_TIMEOUT_MS);
  const gateToken = `${pid}-${PROCESS_INCARNATION_ID}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  while (true) {
    const gatePayload = {
      pid,
      incarnationId: PROCESS_INCARNATION_ID,
      token: gateToken,
      startedAt: SELF_PROCESS_STARTED_AT_MS,
      acquiredAt: Date.now(),
      host,
    };

    try {
      publishCompleteJsonFile(gateFile, gatePayload, { replaceIfExists: false, pid });
      const entry = {
        pid,
        incarnationId: PROCESS_INCARNATION_ID,
        token: gateToken,
        gateFile,
        count: 1,
      };
      activeGateDepth.set(resolvedDir, entry);

      let released = false;
      return {
        ok: true,
        reentrant: false,
        release() {
          if (released) return;
          released = true;
          entry.count -= 1;
          if (entry.count <= 0) {
            activeGateDepth.delete(resolvedDir);
            try {
              const diskRaw = readFileSync(gateFile, "utf8");
              const diskGate = JSON.parse(diskRaw);
              if (diskGate && diskGate.token === gateToken) {
                unlinkSync(gateFile);
              }
            } catch {}
          }
        },
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        return {
          ok: false,
          error: (error && (error.code || error.message)) || "GATE_WRITE_ERROR",
        };
      }
    }

    if (isGateStale(gateFile, { isAlive, isHolderProcess, shouldConsultDefaultHolder, host })) {
      tryRecoverStaleGate(gateFile, () =>
        isGateStale(gateFile, { isAlive, isHolderProcess, shouldConsultDefaultHolder, host }),
      );
      continue;
    }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: "LOCK_GATE_TIMEOUT",
      };
    }

    sleepSync(2);
  }
}

/**
 * Menjalankan `fn` (sinkron atau asinkron) di dalam gerbang eksklusif `dir`.
 */
export function withLockGate(dir, fn, options = {}) {
  const gate = acquireLockGate(dir, options);
  if (!gate.ok) {
    const err = new Error(`Failed to acquire lock gate for ${dir}: ${gate.error}`);
    err.code = gate.error || "LOCK_GATE_FAILED";
    throw err;
  }

  let isAsync = false;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      isAsync = true;
      return result.finally(() => {
        gate.release();
      });
    }
    return result;
  } finally {
    if (!isAsync) {
      gate.release();
    }
  }
}

function rememberLockLease({
  dir,
  pid = process.pid,
  leaseId = null,
  incarnationId = PROCESS_INCARNATION_ID,
}) {
  const resolved = dir ? path.resolve(dir) : null;
  rememberedLockDir = resolved;
  rememberedPid = resolved ? pid : null;
  rememberedLeaseId = resolved ? leaseId : null;
  rememberedIncarnationId = resolved ? incarnationId : null;
  if (resolved && leaseId) {
    heldLeases.set(resolved, {
      dir: resolved,
      pid,
      leaseId,
      incarnationId: incarnationId || PROCESS_INCARNATION_ID,
    });
  }
}

/**
 * Evaluasi apakah sebuah berkas lock yang sedang ada di disk masih dimiliki
 * oleh proses yang hidup.
 *
 * ATURAN KEAMANAN (F4 & F8):
 *   - Waktu detak jantung yang lewat (`age > staleMs`) TIDAK PERNAH membuat
 *     proses yang masih hidup dianggap mati.
 *   - Pemegang dianggap mati HANYA bila `!alive` atau `holderIsOurs === false`.
 */
function evaluateLockHolderLiveness(existing, {
  pid = process.pid,
  incarnationId = PROCESS_INCARNATION_ID,
  now = Date.now(),
  staleMs = DEFAULT_LOCK_STALE_MS,
  isAlive = currentIsAlive(),
  isHolderProcess = currentIsHolderProcess(),
  host = safeHostname(),
}) {
  const sameHost = !existing.host || !host || existing.host === host;
  const shouldConsultDefaultHolder =
    isHolderProcess !== defaultIsHolderProcess ||
    (isAlive === defaultIsAlive && !isAliveOverride);

  let alive = true;
  let holderIsOurs = null;

  if (sameHost) {
    if (existing.pid === process.pid && pid === process.pid) {
      // Lock menunjuk PID OS kita sendiri. Bila ditulis oleh inkarnasi proses
      // SEBELUMNYA (`existing.incarnationId !== PROCESS_INCARNATION_ID`) dan
      // tidak tercatat di memori `heldLeases` proses ini, maka inkarnasi lama
      // tersebut sudah mati sebelum OS memberikan PID ini kepada kita — KECUALI
      // pemeriksa pemegang eksplisit (`isHolderProcess !== defaultIsHolderProcess`)
      // menyatakan pemegang masih hidup.
      const heldHere = heldLeases.get(path.resolve(existing._lockDir || ""));
      if (isHolderProcess !== defaultIsHolderProcess) {
        holderIsOurs = isHolderProcess(existing.pid, existing);
        alive = holderIsOurs !== false;
      } else if (
        existing.incarnationId &&
        existing.incarnationId !== PROCESS_INCARNATION_ID &&
        (!heldHere || heldHere.leaseId !== existing.leaseId)
      ) {
        alive = false;
        holderIsOurs = false;
      } else {
        alive = true;
        holderIsOurs = true;
      }
    } else {
      alive = Boolean(isAlive(existing.pid));
      if (alive && shouldConsultDefaultHolder) {
        holderIsOurs = isHolderProcess(existing.pid, existing);
      }
    }
  }

  const age = Math.max(0, now - lockStamp(existing));
  const staleHeartbeat = Number.isFinite(staleMs) && staleMs > 0 && age > staleMs;
  const isConfirmedDead = !alive || holderIsOurs === false;

  return {
    sameHost,
    alive,
    holderIsOurs,
    age,
    staleHeartbeat,
    isConfirmedDead,
    isLegacy: isLegacyLock(existing),
  };
}

/**
 * Mencoba menjadi pemegang lock secara atomik di bawah gerbang eksklusif
 * dengan token kepemilikan (`leaseId`) dan identitas inkarnasi (`incarnationId`).
 *
 * Mengembalikan:
 *   { acquired: true, leaseId, incarnationId }
 *   { acquired: true, recovered: true, tookOverFrom: <pid>, leaseId, incarnationId }
 *   { acquired: false, holder: {...}, reason?: string }
 *   { acquired: false, wrote: false, error: <code/message> }  (Fail-Closed F6)
 */
export function acquireProcessLock({
  dir,
  pid = process.pid,
  now = Date.now(),
  leaseId = undefined,
  incarnationId = PROCESS_INCARNATION_ID,
  projectDir = undefined,
  staleMs = DEFAULT_LOCK_STALE_MS,
  allowStaleTakeover = false,
  force = false,
  remember = true,
  isAlive = currentIsAlive(),
  isHolderProcess = currentIsHolderProcess(),
  writeFileImpl = writeFileSync,
  hooks = null,
}) {
  if (!dir) {
    return { acquired: false, wrote: false, error: "INVALID_LOCK_DIR" };
  }

  const resolvedDir = path.resolve(dir);
  const lockFile = processLockPath({ dir: resolvedDir });
  const effectiveLeaseId = leaseId || generateLeaseId(pid, now);
  const effectiveIncarnationId = incarnationId || PROCESS_INCARNATION_ID;
  const host = safeHostname();
  const usingDefaultWriter = writeFileImpl === writeFileSync;

  try {
    mkdirSync(resolvedDir, { recursive: true });
  } catch (error) {
    return {
      acquired: false,
      wrote: false,
      error: (error && (error.code || error.message)) || "unknown",
    };
  }

  // Jalur injeksi writer khusus untuk unit test kegagalan tulis (mis. EACCES).
  if (!usingDefaultWriter) {
    const existing = readProcessLock({ dir: resolvedDir });
    if (existing) {
      const liveness = evaluateLockHolderLiveness(
        { ...existing, _lockDir: resolvedDir },
        { pid, incarnationId: effectiveIncarnationId, now, staleMs, isAlive, isHolderProcess, host },
      );
      if (!liveness.isConfirmedDead && (!force || liveness.isLegacy)) {
        return { acquired: false, holder: existing };
      }
    }
    const tookOverFrom = existing && existing.pid !== pid ? existing.pid : undefined;
    const payload = {
      protocolVersion: LOCK_PROTOCOL_VERSION,
      pid,
      incarnationId: effectiveIncarnationId,
      leaseId: effectiveLeaseId,
      startedAt: now,
      processStartedAt: pid === process.pid ? SELF_PROCESS_STARTED_AT_MS : now,
      heartbeatAt: now,
      host,
      ...(projectDir ? { projectDir } : {}),
    };
    try {
      writeFileImpl(lockFile, JSON.stringify(payload), "utf8");
      bindHeldLease({
        dir: resolvedDir,
        pid,
        leaseId: effectiveLeaseId,
        incarnationId: effectiveIncarnationId,
        makePrimary: Boolean(remember),
      });
      return tookOverFrom
        ? {
            acquired: true,
            recovered: true,
            tookOverFrom,
            leaseId: effectiveLeaseId,
            incarnationId: effectiveIncarnationId,
          }
        : { acquired: true, leaseId: effectiveLeaseId, incarnationId: effectiveIncarnationId };
    } catch (error) {
      return {
        acquired: false,
        wrote: false,
        error: (error && (error.code || error.message)) || "unknown",
      };
    }
  }

  // Langkah 1: Observasi awal (dengan toleransi inisialisasi parsial) untuk
  // mendukung hook deterministik sebelum masuk gerbang komit.
  const preDetailed = readProcessLockDetailed({ dir: resolvedDir, waitForPartialInit: true });
  if (preDetailed.status === "unreadable") {
    return {
      acquired: false,
      wrote: false,
      error: (preDetailed.error && (preDetailed.error.code || preDetailed.error.message)) || "EACCES",
      holder: { pid: -1, startedAt: null, host },
    };
  }

  if (preDetailed.status === "corrupt" || preDetailed.status === "ok") {
    if (typeof hooks?.onBeforeClaim === "function") {
      hooks.onBeforeClaim({
        dir: resolvedDir,
        status: preDetailed.status,
        existing: preDetailed.lock,
      });
    }
  }

  // Langkah 2: Masuk gerbang eksklusif (`mcp-process.gate.lock`).
  const gate = acquireLockGate(resolvedDir, { pid, isAlive, isHolderProcess });
  if (!gate.ok) {
    return {
      acquired: false,
      wrote: false,
      error: gate.error || "LOCK_GATE_FAILED",
    };
  }

  try {
    const detailed = readProcessLockDetailed({ dir: resolvedDir, waitForPartialInit: true });

    if (detailed.status === "unreadable") {
      return {
        acquired: false,
        wrote: false,
        error: (detailed.error && (detailed.error.code || detailed.error.message)) || "EACCES",
        holder: { pid: -1, startedAt: null, host },
      };
    }

    let tookOverFrom = undefined;
    let preservedStartedAt = now;

    if (detailed.status === "corrupt") {
      tookOverFrom = "corrupt";
    } else if (detailed.status === "ok") {
      const existing = detailed.lock;
      const heldForDir = getHeldLeaseForDir(resolvedDir, pid);
      const callerLeaseId = leaseId || heldForDir?.leaseId || null;

      // Re-entry HANYA diizinkan bila pemanggil memegang kapabilitas `leaseId`
      // yang cocok (atau berkas adalah lock v1 tanpa leaseId milik PID & inkarnasi ini).
      const hasMatchingCapability = existing.leaseId
        ? existing.pid === pid && Boolean(callerLeaseId) && existing.leaseId === callerLeaseId
        : existing.pid === pid && (!existing.incarnationId || existing.incarnationId === effectiveIncarnationId);

      if (hasMatchingCapability) {
        preservedStartedAt = Number.isFinite(existing.startedAt) ? existing.startedAt : now;
      } else {
        const liveness = evaluateLockHolderLiveness(
          { ...existing, _lockDir: resolvedDir },
          { pid, incarnationId: effectiveIncarnationId, now, staleMs, isAlive, isHolderProcess, host },
        );

        // Bila proses pemegang masih hidup (`!liveness.isConfirmedDead`):
        //   1. Lock legacy v1 yang masih hidup TIDAK BOLEH diambil alih bahkan dengan `force: true`.
        //   2. Tanpa `force: true`, lock milik proses hidup TIDAK PERNAH diambil alih
        //      (meskipun detak jantungnya sudah lama / `staleHeartbeat === true`).
        //   3. Kesamaan PID tanpa `leaseId` yang cocok (`existing.pid === pid`)
        //      tetap ditolak (`lease_mismatch`) bila inkarnasinya belum terbukti mati.
        if (!liveness.isConfirmedDead) {
          if (liveness.isLegacy) {
            return {
              acquired: false,
              reason: "legacy_writer_active",
              holder: { ...existing, ageMs: liveness.age, staleHeartbeat: liveness.staleHeartbeat },
            };
          }
          if (!force) {
            return {
              acquired: false,
              reason: existing.pid === pid ? "lease_mismatch" : "foreign_lock",
              holder: {
                ...existing,
                ageMs: liveness.age,
                staleHeartbeat: liveness.staleHeartbeat,
                ...(existing.pid === pid ? { leaseMismatch: true } : {}),
              },
            };
          }
        }

        tookOverFrom = existing.pid;
      }
    }

    const payload = {
      protocolVersion: LOCK_PROTOCOL_VERSION,
      pid,
      incarnationId: effectiveIncarnationId,
      leaseId: effectiveLeaseId,
      startedAt: preservedStartedAt,
      processStartedAt: pid === process.pid ? SELF_PROCESS_STARTED_AT_MS : now,
      heartbeatAt: now,
      host,
      ...(projectDir ? { projectDir } : {}),
    };

    try {
      publishCompleteJsonFile(lockFile, payload, {
        replaceIfExists: detailed.status !== "missing",
        pid,
      });
    } catch (writeErr) {
      return {
        acquired: false,
        wrote: false,
        error: (writeErr && (writeErr.code || writeErr.message)) || "unknown",
      };
    }

    bindHeldLease({
      dir: resolvedDir,
      pid,
      leaseId: effectiveLeaseId,
      incarnationId: effectiveIncarnationId,
      makePrimary: Boolean(remember),
    });

    return tookOverFrom !== undefined
      ? {
          acquired: true,
          recovered: true,
          tookOverFrom,
          leaseId: effectiveLeaseId,
          incarnationId: effectiveIncarnationId,
        }
      : {
          acquired: true,
          leaseId: effectiveLeaseId,
          incarnationId: effectiveIncarnationId,
        };
  } finally {
    gate.release();
  }
}

/**
 * Melepas lock hanya bila memang milik proses DAN kapabilitas lease kita (F3 & F8).
 */
export function releaseProcessLock({
  dir = rememberedLockDir,
  pid = process.pid,
  leaseId = undefined,
  preserveRemembered = false,
  hooks = null,
} = {}) {
  if (!dir) return false;
  const resolvedDir = path.resolve(dir);
  const existing = readProcessLock({ dir: resolvedDir });

  if (!existing || existing.pid !== pid) return false;

  const heldForDir = getHeldLeaseForDir(resolvedDir, pid);
  const expectedLeaseId = leaseId !== undefined ? leaseId : heldForDir?.leaseId || null;

  // Bila lock di disk memiliki leaseId, pemanggil WAJIB menyajikan leaseId yang cocok.
  if (existing.leaseId) {
    if (!expectedLeaseId || existing.leaseId !== expectedLeaseId) {
      return false;
    }
  }

  if (typeof hooks?.onBeforeRelease === "function") {
    hooks.onBeforeRelease({ dir: resolvedDir, existing, expectedLeaseId });
  }

  const gate = acquireLockGate(resolvedDir, { pid });
  if (!gate.ok) return false;

  let removed = false;
  try {
    const current = readProcessLock({ dir: resolvedDir });
    if (!current || current.pid !== pid) {
      return false;
    }
    if (current.leaseId) {
      if (!expectedLeaseId || current.leaseId !== expectedLeaseId) {
        return false;
      }
    }
    if (existing.incarnationId && current.incarnationId && current.incarnationId !== existing.incarnationId) {
      return false;
    }

    const lockFile = processLockPath({ dir: resolvedDir });
    const tombstone = `${lockFile}.rel.${pid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      renameSync(lockFile, tombstone);
      removed = true;
      try {
        unlinkSync(tombstone);
      } catch {}
    } catch {
      try {
        unlinkSync(lockFile);
        removed = true;
      } catch {
        removed = false;
      }
    }
  } finally {
    gate.release();
  }

  if (removed) {
    const currentHeld = heldLeases.get(resolvedDir);
    if (currentHeld && currentHeld.pid === pid && (!expectedLeaseId || currentHeld.leaseId === expectedLeaseId)) {
      heldLeases.delete(resolvedDir);
    }
    if (
      !preserveRemembered &&
      rememberedLockDir &&
      path.resolve(rememberedLockDir) === resolvedDir &&
      (!rememberedPid || rememberedPid === pid) &&
      (!expectedLeaseId || !rememberedLeaseId || rememberedLeaseId === expectedLeaseId)
    ) {
      rememberedLockDir = null;
      rememberedLeaseId = null;
      rememberedPid = null;
      rememberedIncarnationId = null;
    }
  }

  return removed;
}

/**
 * Melepas lock aktif yang sedang dipegang proses ini saat keluar (exit handler).
 */
export function releaseActiveProcessLock({ pid = process.pid, fallbackDir = null } = {}) {
  let released = false;
  if (rememberedLockDir && rememberedLeaseId) {
    released = releaseProcessLock({
      dir: rememberedLockDir,
      pid,
      leaseId: rememberedLeaseId,
    });
  }
  if (fallbackDir) {
    const resolvedFallback = path.resolve(fallbackDir);
    const heldFallback = getHeldLeaseForDir(resolvedFallback, pid);
    if (heldFallback && heldFallback.leaseId) {
      const fallbackReleased = releaseProcessLock({
        dir: resolvedFallback,
        pid,
        leaseId: heldFallback.leaseId,
      });
      released = released || fallbackReleased;
    }
  }
  return released;
}

/**
 * Mendeteksi keberadaan penulis legacy (v1 tanpa `leaseId` / `protocolVersion: 2`)
 * yang masih hidup pada direktori awal, direktori target, atau penunjuk sesi.
 */
export function detectIncompatibleLegacyWriters({
  fromDir = null,
  toDir = null,
  projectDir = null,
  pid = process.pid,
  now = Date.now(),
  staleMs = DEFAULT_LOCK_STALE_MS,
  isAlive = currentIsAlive(),
  isHolderProcess = currentIsHolderProcess(),
} = {}) {
  const dirsToCheck = new Set();
  if (toDir) dirsToCheck.add(path.resolve(toDir));
  if (fromDir) dirsToCheck.add(path.resolve(fromDir));

  // Bila berada di tata letak `<base>/projects/<bucket>`, periksa juga apakah
  // ada penunjuk sesi di `<base>/sessions/*.json` yang menunjuk `projectDir`
  // atau `toDir` sementara proses legacy memegang lock di bucket startup-nya.
  const resolvedTo = toDir ? path.resolve(toDir) : null;
  if (resolvedTo && path.basename(path.dirname(resolvedTo)) === "projects") {
    const projectsRoot = path.dirname(resolvedTo);
    const baseDir = path.dirname(projectsRoot);
    const sessionsDir = path.join(baseDir, "sessions");
    if (existsSync(sessionsDir) && existsSync(projectsRoot)) {
      const targetNorm = projectDir ? path.resolve(projectDir).replace(/\\/g, "/").toLowerCase() : "";
      try {
        for (const sEntry of readdirSync(sessionsDir, { withFileTypes: true })) {
          if (!sEntry.isFile() || !sEntry.name.endsWith(".json") || sEntry.name.startsWith("focus-")) continue;
          try {
            const ptr = JSON.parse(readFileSync(path.join(sessionsDir, sEntry.name), "utf8"));
            const ptrProj = typeof ptr?.projectDir === "string" ? path.resolve(ptr.projectDir).replace(/\\/g, "/").toLowerCase() : "";
            const ptrDirPath = typeof ptr?.projectDirPath === "string" ? path.resolve(ptr.projectDirPath) : "";
            if ((targetNorm && ptrProj === targetNorm) || (ptrDirPath && ptrDirPath === resolvedTo)) {
              // Sesi ini menunjuk proyek target; periksa semua bucket yang punya lock legacy.
              for (const bEntry of readdirSync(projectsRoot, { withFileTypes: true })) {
                if (bEntry.isDirectory()) {
                  dirsToCheck.add(path.join(projectsRoot, bEntry.name));
                }
              }
            }
          } catch {}
        }
      } catch {}
    }
  }

  for (const checkDir of dirsToCheck) {
    const lock = readProcessLock({ dir: checkDir });
    if (!lock || lock.pid === pid) continue;
    if (!isLegacyLock(lock)) continue;

    const liveness = evaluateLockHolderLiveness(
      { ...lock, _lockDir: checkDir },
      { pid, now, staleMs, isAlive, isHolderProcess },
    );
    if (!liveness.isConfirmedDead) {
      return {
        detected: true,
        dir: checkDir,
        holder: { ...lock, ageMs: liveness.age, staleHeartbeat: liveness.staleHeartbeat, legacy: true },
      };
    }
  }

  return { detected: false, holder: null };
}

/**
 * Tahap 1 dari Transisi Lock Dua-Fase (F7):
 *   1. Tolak bila ada penulis legacy (v1) yang masih hidup pada jalur transisi.
 *   2. Ambil lock pada `toDir` secara atomik TANPA melepas `fromDir` terlebih dahulu.
 *   3. Kembalikan objek `staged` yang dapat di-`commitProcessLockTransition`
 *      setelah state tersimpan, atau di-`rollbackProcessLockTransition` bila gagal.
 */
export function stageProcessLockTransition({
  fromDir = rememberedLockDir,
  toDir,
  projectDir = undefined,
  pid = process.pid,
  now = Date.now(),
  staleMs = DEFAULT_LOCK_STALE_MS,
  force = false,
  isAlive = currentIsAlive(),
  isHolderProcess = currentIsHolderProcess(),
} = {}) {
  if (!toDir) {
    return { ok: false, reason: "missing_target_dir" };
  }

  const targetDir = path.resolve(toDir);
  const sourceDir = fromDir ? path.resolve(fromDir) : null;
  const previousLease = getRememberedLockLease();
  const heldSourceLease = sourceDir ? getHeldLeaseForDir(sourceDir, pid) : null;

  // Periksa penulis legacy yang tidak kompatibel (F4).
  const legacyCheck = detectIncompatibleLegacyWriters({
    fromDir: sourceDir,
    toDir: targetDir,
    projectDir,
    pid,
    now,
    staleMs,
    isAlive,
    isHolderProcess,
  });
  if (legacyCheck.detected) {
    return {
      ok: false,
      reason: "legacy_writer_active",
      holder: legacyCheck.holder,
      fromDir: sourceDir,
      dir: targetDir,
    };
  }

  if (sourceDir && sourceDir === targetDir) {
    const existing = readProcessLock({ dir: targetDir });
    const heldTarget = getHeldLeaseForDir(targetDir, pid);
    if (existing && existing.pid === pid) {
      // F8: Jangan pernah mengadopsi lease milik proses/inkarnasi lain hanya karena PID sama.
      if (existing.leaseId && (!heldTarget || heldTarget.leaseId !== existing.leaseId)) {
        return {
          ok: false,
          reason: "lease_mismatch",
          holder: existing,
          fromDir: sourceDir,
          dir: targetDir,
        };
      }
      const refreshed = refreshProcessLock({
        dir: targetDir,
        pid,
        leaseId: heldTarget?.leaseId || undefined,
        now,
      });
      if (refreshed) {
        return {
          ok: true,
          staged: true,
          relocated: false,
          fromDir: sourceDir,
          dir: targetDir,
          pid,
          leaseId: existing.leaseId || heldTarget?.leaseId || null,
          incarnationId: existing.incarnationId || PROCESS_INCARNATION_ID,
          previousLease,
          heldSourceLease,
        };
      }
    }
  }

  const foreign = activeForeignLock({
    dir: targetDir,
    pid,
    now,
    staleMs,
    isAlive,
    isHolderProcess,
  });

  if (foreign && (!force || foreign.legacy)) {
    return {
      ok: false,
      reason: foreign.legacy ? "legacy_writer_active" : "foreign_lock",
      holder: foreign,
      fromDir: sourceDir,
      dir: targetDir,
    };
  }

  const acquired = acquireProcessLock({
    dir: targetDir,
    pid,
    now,
    projectDir,
    staleMs,
    allowStaleTakeover: false,
    force,
    // Jangan jadikan primary sebelum commit berhasil, supaya kegagalan di tengah
    // transisi tetap mempertahankan ikatan asal.
    remember: false,
    isAlive,
    isHolderProcess,
  });

  if (!acquired.acquired || acquired.wrote === false) {
    if (previousLease.dir) {
      rememberLockLease(previousLease);
    }
    return {
      ok: false,
      reason: acquired.wrote === false ? "write_error" : acquired.reason || "acquire_failed",
      error: acquired.error,
      holder: acquired.holder || null,
      fromDir: sourceDir,
      dir: targetDir,
    };
  }

  return {
    ok: true,
    staged: true,
    relocated: Boolean(sourceDir && sourceDir !== targetDir),
    fromDir: sourceDir,
    dir: targetDir,
    pid,
    leaseId: acquired.leaseId,
    incarnationId: acquired.incarnationId || PROCESS_INCARNATION_ID,
    tookOverFrom: acquired.tookOverFrom,
    previousLease,
    heldSourceLease,
  };
}

/**
 * Tahap 2 (Commit) dari Transisi Lock Dua-Fase (F7):
 * Mengikat detak jantung utama ke `staged.dir` dan melepas `staged.fromDir`
 * HANYA setelah seluruh perubahan state dan metadata proyek berhasil disimpan.
 */
export function commitProcessLockTransition(staged) {
  if (!staged || !staged.ok) {
    return { ok: false, reason: "invalid_staged_transition" };
  }

  bindHeldLease({
    dir: staged.dir,
    pid: staged.pid || process.pid,
    leaseId: staged.leaseId,
    incarnationId: staged.incarnationId || PROCESS_INCARNATION_ID,
    makePrimary: true,
  });

  let releasedSource = false;
  if (staged.relocated && staged.fromDir && staged.fromDir !== staged.dir) {
    const sourceLeaseId =
      staged.heldSourceLease?.leaseId ||
      (staged.previousLease?.dir && path.resolve(staged.previousLease.dir) === path.resolve(staged.fromDir)
        ? staged.previousLease.leaseId
        : undefined);
    if (sourceLeaseId) {
      releasedSource = releaseProcessLock({
        dir: staged.fromDir,
        pid: staged.pid || process.pid,
        leaseId: sourceLeaseId,
        preserveRemembered: true,
      });
    }
  }

  return {
    ok: true,
    committed: true,
    relocated: staged.relocated,
    releasedSource,
    fromDir: staged.fromDir,
    dir: staged.dir,
    leaseId: staged.leaseId,
    incarnationId: staged.incarnationId,
    tookOverFrom: staged.tookOverFrom,
  };
}

/**
 * Tahap 2 Alternatif (Rollback) dari Transisi Lock Dua-Fase (F7):
 * Melepas lock `staged.dir` yang baru diambil dan memulihkan ikatan detak
 * jantung ke `staged.previousLease`.
 */
export function rollbackProcessLockTransition(staged) {
  if (!staged || !staged.ok) return false;

  if (staged.relocated && staged.dir && staged.dir !== staged.fromDir && staged.leaseId) {
    releaseProcessLock({
      dir: staged.dir,
      pid: staged.pid || process.pid,
      leaseId: staged.leaseId,
      preserveRemembered: true,
    });
  }

  if (staged.previousLease && staged.previousLease.dir) {
    rememberLockLease(staged.previousLease);
  }
  return true;
}

/**
 * Pembungkus satu langkah untuk pemindahan lock langsung (kompatibilitas API).
 */
export function relocateProcessLock(options = {}) {
  const staged = stageProcessLockTransition(options);
  if (!staged.ok) {
    return staged;
  }
  return commitProcessLockTransition(staged);
}

/**
 * Memverifikasi di bawah gerbang eksklusif bahwa proses ini masih memegang
 * kepemilikan sah atas proyek (`dir` atau `projectLockDir(stateFile)`).
 */
export function verifyProjectOwnership({
  dir = null,
  stateFile = null,
  expectedLeaseId = null,
  pid = process.pid,
  requireLease = false,
  isAlive = currentIsAlive(),
  isHolderProcess = currentIsHolderProcess(),
} = {}) {
  const lockDir = dir
    ? path.resolve(dir)
    : stateFile
      ? projectLockDir(stateFile)
      : rememberedLockDir;

  if (!lockDir) {
    return { ok: true, unlocked: true };
  }

  const held = getHeldLeaseForDir(lockDir, pid);
  const effectiveExpectedLease = expectedLeaseId || held?.leaseId || null;

  const detailed = readProcessLockDetailed({ dir: lockDir, waitForPartialInit: true });

  if (detailed.status === "unreadable") {
    return {
      ok: false,
      reason: "lock_unreadable",
      lockDir,
    };
  }

  if (detailed.status === "corrupt") {
    if (requireLease || effectiveExpectedLease) {
      return {
        ok: false,
        reason: "lock_corrupt",
        lockDir,
      };
    }
    return { ok: true, unlocked: true, lockDir };
  }

  if (detailed.status === "missing") {
    if (requireLease || effectiveExpectedLease) {
      return {
        ok: false,
        reason: "lock_missing",
        expectedLeaseId: effectiveExpectedLease,
        lockDir,
      };
    }
    return { ok: true, unlocked: true, lockDir };
  }

  const diskLock = detailed.lock;

  if (effectiveExpectedLease) {
    if (diskLock.pid !== pid || diskLock.leaseId !== effectiveExpectedLease) {
      return {
        ok: false,
        reason: "lease_replaced",
        expectedLeaseId: effectiveExpectedLease,
        actualLeaseId: diskLock.leaseId || null,
        actualPid: diskLock.pid,
        lockDir,
      };
    }
    return { ok: true, lock: diskLock, lockDir };
  }

  // Tidak ada `effectiveExpectedLease` yang dipegang proses ini untuk `lockDir`.
  // Bila di disk ada lock:
  if (diskLock.pid !== pid) {
    const liveness = evaluateLockHolderLiveness(
      { ...diskLock, _lockDir: lockDir },
      { pid, isAlive, isHolderProcess },
    );
    if (!liveness.isConfirmedDead) {
      return {
        ok: false,
        reason: "foreign_owner_active",
        actualPid: diskLock.pid,
        actualLeaseId: diskLock.leaseId || null,
        lockDir,
      };
    }
    return { ok: true, unlocked: true, lockDir };
  }

  // `diskLock.pid === pid`, tetapi proses/instans ini TIDAK memegang `diskLock.leaseId`!
  if (diskLock.leaseId) {
    return {
      ok: false,
      reason: "unheld_lease_on_same_pid",
      actualLeaseId: diskLock.leaseId,
      actualPid: diskLock.pid,
      lockDir,
    };
  }

  return { ok: true, lock: diskLock, lockDir };
}

/**
 * Menjalankan operasi mutasi terproteksi (`fn`) sambil memegang gerbang eksklusif
 * `mcp-process.gate.lock` dan memverifikasi kepemilikan proyek secara atomik (F5).
 */
export function withProjectOwnershipFence(
  {
    dir = null,
    stateFile = null,
    expectedLeaseId = null,
    pid = process.pid,
    requireLease = false,
    operation = "state_mutation",
  } = {},
  fn,
) {
  const lockDir = dir
    ? path.resolve(dir)
    : stateFile
      ? projectLockDir(stateFile)
      : rememberedLockDir;

  if (!lockDir || !existsSync(lockDir)) {
    if (requireLease || expectedLeaseId) {
      throw new ProjectOwnershipLostError(
        `Project ownership lost before ${operation}: lock directory does not exist (${lockDir}).`,
        { lockDir, expectedLeaseId, operation, reason: "lock_dir_missing" },
      );
    }
    return fn();
  }

  return withLockGate(lockDir, () => {
    const check = verifyProjectOwnership({
      dir: lockDir,
      expectedLeaseId,
      pid,
      requireLease,
    });
    if (!check.ok) {
      throw new ProjectOwnershipLostError(
        `Project ownership fence rejected ${operation} in ${lockDir}: ${check.reason}`,
        { ...check, operation },
      );
    }
    return fn();
  });
}

/**
 * Pesan yang dicatat saat proses lain sudah memegang lock, atau null bila tidak
 * ada yang perlu dilaporkan.
 */
export function lockWarning(result) {
  if (!result) return null;

  if (result.wrote === false) {
    return (
      `Tidak bisa menulis penanda proses ke ${LOCK_FILENAME} (${result.error}). ` +
      "Deteksi proses MCP ganda tidak akan bekerja sampai ini diperbaiki."
    );
  }

  if (result.acquired !== false || !result.holder) return null;

  const started = Number.isFinite(result.holder.startedAt)
    ? new Date(result.holder.startedAt).toISOString()
    : "waktu tidak diketahui";

  return (
    `Proses dev-workflow MCP lain (PID ${result.holder.pid}, hidup sejak ${started}) ` +
    "masih berjalan dan memakai direktori state yang sama. " +
    "Proses yang lebih tua memegang environment saat ia dijalankan, jadi kredensial Factory " +
    "dan state workflow bisa berbeda antar proses. Tutup OpenCode lalu buka lagi untuk " +
    "memastikan hanya satu proses yang hidup."
  );
}

/**
 * Menyegarkan penanda milik kita sendiri di bawah gerbang eksklusif dengan
 * verifikasi kapabilitas `leaseId` (F1 & F8).
 */
export function refreshProcessLock({
  dir = rememberedLockDir,
  pid = process.pid,
  leaseId = undefined,
  now = Date.now(),
  writeFileImpl = writeFileSync,
  hooks = null,
} = {}) {
  if (!dir) return false;
  const resolvedDir = path.resolve(dir);

  const existing = readProcessLock({ dir: resolvedDir });
  if (!existing || existing.pid !== pid) return false;

  const heldForDir = getHeldLeaseForDir(resolvedDir, pid);
  const expectedLeaseId = leaseId !== undefined ? leaseId : heldForDir?.leaseId || null;

  if (existing.leaseId) {
    if (!expectedLeaseId || existing.leaseId !== expectedLeaseId) {
      return false;
    }
  }

  if (typeof hooks?.onBeforeCommit === "function") {
    hooks.onBeforeCommit({ dir: resolvedDir, existing, expectedLeaseId });
  }

  if (writeFileImpl !== writeFileSync) {
    try {
      const updated = { ...existing, heartbeatAt: now };
      writeFileImpl(processLockPath({ dir: resolvedDir }), JSON.stringify(updated), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  const gate = acquireLockGate(resolvedDir, { pid });
  if (!gate.ok) return false;

  try {
    const current = readProcessLock({ dir: resolvedDir });
    if (!current || current.pid !== pid) {
      return false;
    }
    if (current.leaseId) {
      if (!expectedLeaseId || current.leaseId !== expectedLeaseId) {
        return false;
      }
    }
    if (existing.incarnationId && current.incarnationId && current.incarnationId !== existing.incarnationId) {
      return false;
    }

    const updated = {
      ...current,
      heartbeatAt: now,
    };

    publishCompleteJsonFile(processLockPath({ dir: resolvedDir }), updated, {
      replaceIfExists: true,
      pid,
    });
    return true;
  } catch {
    return false;
  } finally {
    gate.release();
  }
}

/**
 * Pemegang lock lain yang masih hidup, atau null.
 *
 * ATURAN KEAMANAN (F4 & F8):
 *   - Bila proses pemegang masih hidup (`!liveness.isConfirmedDead`), fungsi ini
 *     SELALU mengembalikan pemegang tersebut (dengan `staleHeartbeat: true/false`
 *     dan `legacy: true/false`) — detak jantung yang lewat batas TIDAK membuat
 *     proses hidup diabaikan.
 *   - Bila `lock.pid === pid` tetapi `lock.leaseId` berbeda dari lease yang
 *     dipegang proses ini (dan inkarnasinya belum terbukti mati), lock tersebut
 *     juga dilaporkan sebagai lock asing (`leaseMismatch: true`).
 */
export function activeForeignLock({
  dir = rememberedLockDir,
  pid = process.pid,
  leaseId = undefined,
  now = Date.now(),
  staleMs = DEFAULT_LOCK_STALE_MS,
  isAlive = currentIsAlive(),
  isHolderProcess = currentIsHolderProcess(),
} = {}) {
  if (!dir) return null;
  const resolvedDir = path.resolve(dir);

  const detailed = readProcessLockDetailed({ dir: resolvedDir, waitForPartialInit: true });
  if (detailed.status === "unreadable") {
    return {
      pid: -1,
      startedAt: null,
      host: safeHostname(),
      ageMs: 0,
      unreadable: true,
    };
  }
  if (detailed.status !== "ok" || !detailed.lock) return null;

  const lock = detailed.lock;
  const heldForDir = getHeldLeaseForDir(resolvedDir, pid);
  const expectedLeaseId = leaseId !== undefined ? leaseId : heldForDir?.leaseId || null;

  if (lock.pid === pid) {
    if (!lock.leaseId) return null;
    if (expectedLeaseId && lock.leaseId === expectedLeaseId) return null;

    const liveness = evaluateLockHolderLiveness(
      { ...lock, _lockDir: resolvedDir },
      { pid, now, staleMs, isAlive, isHolderProcess },
    );
    if (liveness.isConfirmedDead) return null;

    return {
      ...lock,
      ageMs: liveness.age,
      staleHeartbeat: liveness.staleHeartbeat,
      legacy: liveness.isLegacy,
      leaseMismatch: true,
    };
  }

  const liveness = evaluateLockHolderLiveness(
    { ...lock, _lockDir: resolvedDir },
    { pid, now, staleMs, isAlive, isHolderProcess },
  );
  if (liveness.isConfirmedDead) return null;

  return {
    ...lock,
    ageMs: liveness.age,
    staleHeartbeat: liveness.staleHeartbeat,
    legacy: liveness.isLegacy,
  };
}

/** Mengingat direktori lock supaya detak jantung tidak perlu parameter. */
export function rememberLockDir(dir, leaseId = null, pid = process.pid) {
  rememberLockLease({ dir, pid, leaseId });
}

export function setIsAliveForTests(fn) {
  isAliveOverride = typeof fn === "function" ? fn : null;
}

export function setIsHolderForTests(fn) {
  isHolderOverride = typeof fn === "function" ? fn : null;
}

export function setIsHolderProcessForTests(fn) {
  isHolderOverride = typeof fn === "function" ? fn : null;
}

export function currentIsAlive() {
  return isAliveOverride || defaultIsAlive;
}

export function currentIsHolderProcess() {
  return isHolderOverride || defaultIsHolderProcess;
}
