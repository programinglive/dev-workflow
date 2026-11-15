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
  lstatSync,
  readdirSync,
  realpathSync,
} from "fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import net from "node:net";
import os from "os";
import path from "path";

export const LOCK_FILENAME = "mcp-process.lock";
export const GATE_FILENAME = "mcp-process.gate.lock";
export const GATE_RECOVER_FILENAME = "mcp-process.gate.recover.lock";
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

export const OPTION_B_LOCK_PROTOCOL_VERSION = 3;
export const SUPPORTED_KERNEL_MUTEX_PLATFORMS = new Set(["win32", "linux"]);

/** Map of active OS-owned worktree mutex capabilities keyed by canonical worktree identity. */
const heldWorktreeMutexes = new Map();

function normalizeWorktreeString(targetPath, platform = process.platform) {
  let normalized = path.resolve(String(targetPath || ""));
  const root = path.parse(normalized).root;
  while (normalized.length > root.length && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
    normalized = normalized.slice(0, -1);
  }
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isValidGitHeadFile(headPath) {
  try {
    if (!existsSync(headPath)) return false;
    const headStat = statSync(headPath);
    if (!headStat.isFile()) return false;
    const headContent = readFileSync(headPath, "utf8").trim();
    return /^ref:\s*\S+$/.test(headContent) || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headContent);
  } catch {
    return false;
  }
}

function isValidGitWorktreeMarker(dir) {
  const gitPath = path.join(dir, ".git");
  let gitStat = null;
  try {
    gitStat = statSync(gitPath);
  } catch {
    return false;
  }
  if (gitStat.isFile()) {
    try {
      const content = readFileSync(gitPath, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(content);
      if (!match || !match[1]) return false;
      const targetGitDir = path.resolve(dir, match[1].trim());
      const targetStat = statSync(targetGitDir);
      if (!targetStat.isDirectory()) return false;
      return isValidGitHeadFile(path.join(targetGitDir, "HEAD"));
    } catch {
      return false;
    }
  }
  if (gitStat.isDirectory()) {
    return isValidGitHeadFile(path.join(gitPath, "HEAD"));
  }
  return false;
}

/**
 * Resolve the canonical Git working-tree root for `projectDir`.
 * Rejects nonexistent, non-directory, or non-Git paths without ancestor fallback.
 */
export function resolveCanonicalWorktreeRoot(projectDir, platform = process.platform) {
  if (typeof projectDir !== "string" || projectDir.trim() === "" || projectDir.includes("\0")) {
    return {
      ok: false,
      error: "INVALID_PROJECT_DIR",
      message: "projectDir must be a non-empty valid filesystem path.",
    };
  }
  const resolved = path.resolve(projectDir.trim());
  let stat = null;
  try {
    stat = statSync(resolved);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    return {
      ok: false,
      error: "PROJECT_DIR_NOT_FOUND",
      message: `Project directory does not exist or is not a directory: ${resolved}`,
    };
  }

  let realDir = resolved;
  try {
    realDir = typeof realpathSync.native === "function"
      ? realpathSync.native(resolved)
      : realpathSync(resolved);
  } catch (err) {
    return {
      ok: false,
      error: "WORKTREE_REALPATH_FAILED",
      message: `Failed to resolve canonical realpath for projectDir (${err?.code || err?.message || "REALPATH_ERROR"}): ${resolved}`,
    };
  }

  let current = realDir;
  const { root } = path.parse(current);
  while (true) {
    const markerPath = path.join(current, ".git");
    let markerPresent = false;
    try {
      lstatSync(markerPath);
      markerPresent = true;
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") {
        markerPresent = true;
      }
    }
    if (markerPresent) {
      if (!isValidGitWorktreeMarker(current)) {
        return {
          ok: false,
          error: "INVALID_GIT_WORKTREE",
          message: `Directory contains an invalid or unreadable .git marker: ${current}`,
        };
      }
      let realWorktreeRoot = current;
      try {
        realWorktreeRoot = typeof realpathSync.native === "function"
          ? realpathSync.native(current)
          : realpathSync(current);
      } catch (err) {
        return {
          ok: false,
          error: "WORKTREE_REALPATH_FAILED",
          message: `Failed to resolve canonical realpath for worktree root (${err?.code || err?.message || "REALPATH_ERROR"}): ${current}`,
        };
      }
      const canonicalKey = normalizeWorktreeString(realWorktreeRoot, platform);
      return {
        ok: true,
        worktreeRoot: realWorktreeRoot,
        canonicalKey,
      };
    }
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return {
    ok: false,
    error: "NOT_A_GIT_WORKTREE",
    message: `Directory is not inside a Git working tree: ${resolved}`,
  };
}

/**
 * Derive the OS-owned kernel mutex endpoint from canonical Git working-tree identity.
 * Fails closed on macOS (darwin) and any unsupported platform.
 */
export function worktreeMutexEndpoint(canonicalWorktreeKey, platform = process.platform) {
  if (!SUPPORTED_KERNEL_MUTEX_PLATFORMS.has(platform)) {
    return {
      supported: false,
      platform,
      error: "PLATFORM_UNSUPPORTED_KERNEL_MUTEX",
      message:
        `OS-owned kernel mutex is not natively verified on platform "${platform}" ` +
        `(macOS activation is BLOCKED to avoid TCP port collision false ownership).`,
    };
  }
  const normalizedKey = normalizeWorktreeString(canonicalWorktreeKey, platform);
  const digest = createHash("sha256").update(`worktree:${normalizedKey}`).digest();
  const hex32 = digest.toString("hex").slice(0, 32);
  if (platform === "win32") {
    return {
      supported: true,
      platform: "win32",
      canonicalKey: normalizedKey,
      path: `\\\\.\\pipe\\devwf-wt-${hex32}`,
      exclusive: true,
    };
  }
  return {
    supported: true,
    platform: "linux",
    canonicalKey: normalizedKey,
    path: `\0devwf-wt-${hex32}`,
    exclusive: true,
  };
}

/**
 * Derive endpoint from either a `projectDir` (preferred, canonical worktree)
 * or explicit worktree identity. Preserved name for compatibility with Option B tests.
 */
export function kernelMutexEndpoint(dirOrOptions, platform = process.platform) {
  if (dirOrOptions && typeof dirOrOptions === "object" && dirOrOptions.projectDir) {
    const wt = resolveCanonicalWorktreeRoot(dirOrOptions.projectDir, platform);
    if (!wt.ok) return { supported: false, error: wt.error, message: wt.message };
    return worktreeMutexEndpoint(wt.canonicalKey, platform);
  }
  const raw = typeof dirOrOptions === "string" ? dirOrOptions : dirOrOptions?.dir;
  if (!raw) {
    return { supported: false, error: "INVALID_MUTEX_TARGET", message: "Missing mutex target." };
  }
  const wt = resolveCanonicalWorktreeRoot(raw, platform);
  if (wt.ok) {
    return worktreeMutexEndpoint(wt.canonicalKey, platform);
  }
  return worktreeMutexEndpoint(raw, platform);
}

function finalizeCapabilityRelease(capability) {
  if (!capability) return;
  capability.active = false;
  if (heldWorktreeMutexes.get(capability.canonicalKey) === capability) {
    heldWorktreeMutexes.delete(capability.canonicalKey);
  }
  try {
    capability.server?.close();
  } catch {}
  const waiters = capability._drainWaiters.splice(0);
  for (const resolve of waiters) {
    try {
      resolve(true);
    } catch {}
  }
}

export function getHeldWorktreeCapability(projectDirOrKey, platform = process.platform) {
  if (!projectDirOrKey) return null;
  const wt = resolveCanonicalWorktreeRoot(projectDirOrKey, platform);
  const key = wt.ok ? wt.canonicalKey : normalizeWorktreeString(projectDirOrKey, platform);
  const cap = heldWorktreeMutexes.get(key) || null;
  if (!cap || !cap.active || !cap.server?.listening) return null;
  return cap;
}

export function listHeldWorktreeCapabilities() {
  return Array.from(heldWorktreeMutexes.values()).filter(
    (cap) => cap && cap.active && cap.server?.listening,
  );
}

export function assertWorktreeCapabilityLive(
  capability,
  { operation = "protected_write", allowDrainingInFlight = false } = {},
) {
  if (!capability || typeof capability !== "object") {
    throw new ProjectOwnershipLostError(
      `Project ownership lost before ${operation}: missing OS kernel mutex capability.`,
      { operation, reason: "missing_kernel_capability" },
    );
  }
  const current = heldWorktreeMutexes.get(capability.canonicalKey);
  if (
    current !== capability ||
    !capability.active ||
    !capability.server ||
    !capability.server.listening
  ) {
    throw new ProjectOwnershipLostError(
      `Project ownership lost before ${operation}: OS kernel mutex is no longer held.`,
      {
        operation,
        canonicalKey: capability.canonicalKey,
        endpoint: capability.endpoint,
        reason: "kernel_mutex_lost",
      },
    );
  }
  if (capability.releaseRequested && (!allowDrainingInFlight || capability.inFlightCount <= 0)) {
    throw new ProjectOwnershipLostError(
      `Project ownership lost before ${operation}: OS kernel mutex release already requested.`,
      {
        operation,
        canonicalKey: capability.canonicalKey,
        endpoint: capability.endpoint,
        reason: "kernel_mutex_releasing",
      },
    );
  }
  return true;
}

export function assertWorktreeCapabilityMatches({
  capability,
  operation = "protected_write",
  ownerKey = null,
  projectDir = null,
  allowDrainingInFlight = false,
} = {}) {
  assertWorktreeCapabilityLive(capability, { operation, allowDrainingInFlight });
  if (typeof capability.ownerKey !== "string" || capability.ownerKey.trim() === "") {
    throw new ProjectOwnershipLostError(
      `Project ownership lost before ${operation}: worktree capability is missing ownerKey.`,
      { operation, reason: "missing_capability_owner" },
    );
  }
  const expectedOwner = typeof ownerKey === "string" ? ownerKey.trim() : "";
  if (expectedOwner && capability.ownerKey !== expectedOwner) {
    throw new ProjectOwnershipLostError(
      `Worktree capability owner mismatch before ${operation}: capability belongs to "${capability.ownerKey}", not "${expectedOwner}".`,
      {
        operation,
        capabilityOwnerKey: capability.ownerKey,
        expectedOwnerKey: expectedOwner,
        reason: "capability_owner_mismatch",
      },
    );
  }
  if (projectDir) {
    const wt = resolveCanonicalWorktreeRoot(projectDir);
    if (!wt.ok || wt.canonicalKey !== capability.canonicalKey) {
      throw new ProjectOwnershipLostError(
        `Project ownership mismatch before ${operation}: capability is for "${capability.worktreeRoot}", not "${wt.ok ? wt.worktreeRoot : projectDir}".`,
        {
          operation,
          capabilityWorktree: capability.worktreeRoot,
          targetProjectDir: projectDir,
          reason: wt.ok ? "capability_worktree_mismatch" : "invalid_target_worktree",
        },
      );
    }
  }
  return true;
}

export async function useWorktreeCapability(
  capability,
  asyncFn,
  { operation = "protected_write" } = {},
) {
  assertWorktreeCapabilityLive(capability, { operation, allowDrainingInFlight: false });
  capability.inFlightCount += 1;
  try {
    return await asyncFn(capability);
  } finally {
    capability.inFlightCount = Math.max(0, capability.inFlightCount - 1);
    if (capability.releaseRequested && capability.inFlightCount === 0) {
      finalizeCapabilityRelease(capability);
    }
  }
}

let nextWorktreeAcquireSeq = 0;

async function allocateCrossProcessAcquireStamp() {
  const seqDir = (typeof process.env.DEVWF_ACQUIRE_SEQ_DIR === "string" && process.env.DEVWF_ACQUIRE_SEQ_DIR.trim())
    ? path.resolve(process.env.DEVWF_ACQUIRE_SEQ_DIR.trim())
    : os.tmpdir();
  mkdirSync(seqDir, { recursive: true });
  const dbPath = path.join(seqDir, "dev-workflow-acquire-seq.db");
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS acquire_clock (id INTEGER PRIMARY KEY CHECK (id = 1), last_ms INTEGER NOT NULL, seq INTEGER NOT NULL);",
    );
    const allocateTx = db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO acquire_clock (id, last_ms, seq) VALUES (1, 0, 0)").run();
      const row = db.prepare("SELECT last_ms, seq FROM acquire_clock WHERE id = 1").get();
      const lastMs = Number(row?.last_ms || 0);
      const lastSeq = Number(row?.seq || 0);
      const nowMs = Date.now();
      const stampedMs = nowMs > lastMs ? nowMs : lastMs;
      const nextSeq = stampedMs === lastMs ? lastSeq + 1 : 1;
      db.prepare("UPDATE acquire_clock SET last_ms = ?, seq = ? WHERE id = 1").run(stampedMs, nextSeq);
      nextWorktreeAcquireSeq = Math.max(nextWorktreeAcquireSeq + 1, nextSeq);
      return { acquiredAt: stampedMs, acquireSeq: nextSeq };
    });
    return allocateTx.immediate();
  } finally {
    try { db.close(); } catch {}
  }
}

export async function acquireWorktreeMutex({
  projectDir,
  timeoutMs = 50,
  pid = process.pid,
  platform = process.platform,
  ownerKey = null,
} = {}) {
  const normalizedOwnerKey =
    typeof ownerKey === "string" && ownerKey.trim() !== "" ? ownerKey.trim() : String(pid);
  const wt = resolveCanonicalWorktreeRoot(projectDir, platform);
  if (!wt.ok) {
    return {
      ok: false,
      reason: "invalid_project_dir",
      error: wt.error,
      message: wt.message,
    };
  }

  const endpoint = worktreeMutexEndpoint(wt.canonicalKey, platform);
  if (!endpoint.supported) {
    return {
      ok: false,
      supported: false,
      reason: "unsupported_platform",
      error: endpoint.error,
      message: endpoint.message,
      worktreeRoot: wt.worktreeRoot,
      canonicalKey: wt.canonicalKey,
    };
  }

  const existing = heldWorktreeMutexes.get(wt.canonicalKey);
  if (existing && existing.pid === pid && existing.active && existing.server?.listening) {
    if (existing.releaseRequested) {
      return {
        ok: false,
        reason: "capability_draining",
        error: "KERNEL_MUTEX_RELEASING",
        worktreeRoot: wt.worktreeRoot,
        canonicalKey: wt.canonicalKey,
        endpoint: endpoint.path,
      };
    }
    if (existing.ownerKey !== normalizedOwnerKey) {
      return {
        ok: false,
        supported: true,
        reason: "held_by_other_session",
        error: "WORKTREE_HELD_BY_OTHER_SESSION",
        ownerKey: existing.ownerKey,
        worktreeRoot: wt.worktreeRoot,
        canonicalKey: wt.canonicalKey,
        endpoint: endpoint.path,
      };
    }
    return {
      ok: true,
      alreadyHeld: true,
      capability: existing,
      worktreeRoot: wt.worktreeRoot,
      canonicalKey: wt.canonicalKey,
      endpoint: endpoint.path,
    };
  }

  const listenTarget = { path: endpoint.path, exclusive: true };
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);

  while (true) {
    const server = net.createServer((socket) => socket.destroy());
    server.unref?.();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenTarget, resolve);
      });
      const stamp = await allocateCrossProcessAcquireStamp();
      const capability = {
        token: randomUUID(),
        pid,
        ownerKey: normalizedOwnerKey,
        incarnationId: PROCESS_INCARNATION_ID,
        worktreeRoot: wt.worktreeRoot,
        canonicalKey: wt.canonicalKey,
        endpoint: endpoint.path,
        server,
        active: true,
        releaseRequested: false,
        inFlightCount: 0,
        _drainWaiters: [],
        acquiredAt: stamp.acquiredAt,
        acquireSeq: stamp.acquireSeq,
      };
      server.once("close", () => {
        capability.active = false;
        if (heldWorktreeMutexes.get(capability.canonicalKey) === capability) {
          heldWorktreeMutexes.delete(capability.canonicalKey);
        }
      });
      server.once("error", () => {
        capability.active = false;
        if (heldWorktreeMutexes.get(capability.canonicalKey) === capability) {
          heldWorktreeMutexes.delete(capability.canonicalKey);
        }
      });
      heldWorktreeMutexes.set(wt.canonicalKey, capability);
      return {
        ok: true,
        alreadyHeld: false,
        capability,
        worktreeRoot: wt.worktreeRoot,
        canonicalKey: wt.canonicalKey,
        endpoint: endpoint.path,
      };
    } catch (error) {
      try {
        server.close();
      } catch {}
      if (error && error.code === "EADDRINUSE") {
        if (Date.now() >= deadline) {
          return {
            ok: false,
            reason: "foreign_lock",
            kernelMutexBusy: true,
            code: "EADDRINUSE",
            error: "KERNEL_MUTEX_HELD",
            endpoint: endpoint.path,
            worktreeRoot: wt.worktreeRoot,
            canonicalKey: wt.canonicalKey,
          };
        }
        await new Promise((r) => setTimeout(r, 15));
        continue;
      }
      return {
        ok: false,
        reason: "mutex_error",
        error: (error && (error.code || error.message)) || "KERNEL_MUTEX_ERROR",
        code: error?.code || "KERNEL_MUTEX_ERROR",
        endpoint: endpoint.path,
        worktreeRoot: wt.worktreeRoot,
        canonicalKey: wt.canonicalKey,
      };
    }
  }
}

export function releaseWorktreeMutex(capabilityOrKey) {
  if (!capabilityOrKey) return Promise.resolve(false);
  const cap =
    typeof capabilityOrKey === "string"
      ? heldWorktreeMutexes.get(normalizeWorktreeString(capabilityOrKey))
      : capabilityOrKey;
  if (!cap) return Promise.resolve(false);

  cap.releaseRequested = true;
  if (cap.inFlightCount > 0) {
    return new Promise((resolve) => {
      cap._drainWaiters.push(resolve);
    });
  }
  finalizeCapabilityRelease(cap);
  return Promise.resolve(true);
}

export function releaseAllWorktreeMutexesSync() {
  for (const cap of Array.from(heldWorktreeMutexes.values())) {
    cap.releaseRequested = true;
    finalizeCapabilityRelease(cap);
  }
}

/**
 * Record informational lock metadata under an already-held OS kernel mutex.
 * Used only for diagnostics (e.g. displaying holder PID) and legacy overlap detection.
 */
export function writeKernelLockMetadata({
  dir,
  capability,
  projectDir = "",
  expectedOwnerKey = null,
} = {}) {
  if (!dir || !capability) return { ok: false, wrote: false, error: "missing_args" };
  assertWorktreeCapabilityMatches({
    capability,
    operation: "writeKernelLockMetadata",
    ownerKey: expectedOwnerKey,
    projectDir: projectDir || capability.worktreeRoot,
    allowDrainingInFlight: true,
  });
  const lockDir = path.resolve(dir);
  const lockFile = path.join(lockDir, LOCK_FILENAME);
  if (existsSync(lockFile)) {
    try {
      const existing = JSON.parse(readFileSync(lockFile, "utf8"));
      if (existing && typeof existing === "object") {
        if (
          existing.canonicalKey &&
          normalizeWorktreeString(existing.canonicalKey) !== capability.canonicalKey
        ) {
          return { ok: false, wrote: false, error: "worktree_mismatch" };
        }
        const existingTs = Number(existing.updatedAt || existing.startedAt || 0);
        const capTs = Number(capability.acquiredAt || 0);
        if (
          existing.protocolVersion === OPTION_B_LOCK_PROTOCOL_VERSION &&
          existing.leaseId &&
          existing.leaseId !== capability.token &&
          existingTs > capTs &&
          Number(existing.pid) > 0 &&
          Number(existing.pid) !== process.pid &&
          currentIsAlive()(Number(existing.pid))
        ) {
          return { ok: false, wrote: false, error: "superseded_by_newer_owner" };
        }
      }
    } catch {
      // Unreadable or corrupt existing advisory metadata will be replaced under the live mutex.
    }
  }
  const payload = {
    protocolVersion: OPTION_B_LOCK_PROTOCOL_VERSION,
    kernelMutex: true,
    pid: capability.pid,
    leaseId: capability.token,
    incarnationId: capability.incarnationId,
    worktreeRoot: capability.worktreeRoot,
    canonicalKey: capability.canonicalKey,
    projectDir: projectDir || capability.worktreeRoot,
    endpoint: capability.endpoint,
    host: os.hostname(),
    startedAt: capability.acquiredAt,
    updatedAt: Date.now(),
  };
  try {
    mkdirSync(lockDir, { recursive: true });
    const tmp = path.join(lockDir, `${LOCK_FILENAME}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, lockFile);
    return { ok: true, wrote: true, payload };
  } catch (error) {
    return { ok: false, wrote: false, error: error?.code || error?.message || "WRITE_FAILED" };
  }
}

/**
 * Detect whether a live legacy (pre-Option-B) writer without kernel mutex support
 * currently holds a lock in `dir`.
 */
export function findActiveLegacyWriter({ dir, isAlive = currentIsAlive(), ownPid = process.pid } = {}) {
  if (!dir) return null;
  const resolvedDir = path.resolve(dir);
  const detailed = readProcessLockDetailed({ dir: resolvedDir });
  if (detailed.status === "unreadable" || detailed.status === "corrupt") {
    return {
      inspectionError: true,
      status: detailed.status,
      reason: detailed.status === "unreadable" ? "lock_unreadable" : "lock_corrupt",
      error: detailed.error?.code || detailed.error?.message || detailed.status,
      dir: resolvedDir,
    };
  }
  const lock = detailed.lock;
  if (!lock || !Number.isFinite(Number(lock.pid))) return null;
  if (Number(lock.pid) === ownPid) return null;
  const isOptionB = Number(lock.protocolVersion) >= OPTION_B_LOCK_PROTOCOL_VERSION && lock.kernelMutex === true;
  if (isOptionB) return null;
  if (!isAlive(Number(lock.pid))) return null;
  return lock;
}

export async function acquireKernelMutex(dirOrOptions, options = {}) {
  if (dirOrOptions && typeof dirOrOptions === "object" && !Array.isArray(dirOrOptions)) {
    return acquireWorktreeMutex(dirOrOptions);
  }
  const projectDir = options.projectDir || dirOrOptions;
  return acquireWorktreeMutex({
    projectDir,
    timeoutMs: options.timeoutMs ?? 150,
    pid: options.pid ?? process.pid,
    platform: options.platform ?? process.platform,
  });
}

export function releaseKernelMutex(capabilityOrDir) {
  return releaseWorktreeMutex(capabilityOrDir);
}

/** Peta entri gerbang aktif untuk proses ini (satu per direktori kanonik). */
const activeGateDepth = new Map();

/** Penyimpanan konteks eksekusi asinkron untuk kepemilikan re-entrant gerbang (R2-2 & R2-3). */
const gateExecutionStorage = new AsyncLocalStorage();

/** Antrean asinkron dalam-proses per direktori agar permintaan paralel tidak melewati gerbang (R2-3). */
const inProcessGateQueues = new Map();

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
  releaseAllWorktreeMutexesSync();
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
export function publishCompleteJsonFile(targetFile, payloadObj, { replaceIfExists = false, pid = process.pid } = {}) {
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
          // R3-2: Jangan pernah jatuh ke `writeFileSync(..., { flag: "wx" })`
          // pada target karena membuka jendela inisialisasi parsial 0-byte.
          const unsupportedErr = new Error(
            `Atomic linkSync publication unsupported for ${targetFile} (${linkError.code})`,
          );
          unsupportedErr.code = "UNSUPPORTED_ATOMIC_LINK";
          unsupportedErr.cause = linkError;
          throw unsupportedErr;
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

function readGateDetailed(gateFile, { waitForPartialInit = true } = {}) {
  const deadline = waitForPartialInit ? Date.now() + PARTIAL_INIT_GRACE_MS : 0;
  while (true) {
    let raw;
    try {
      raw = readFileSync(gateFile, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { status: "missing", gate: null, error: null };
      }
      return { status: "unreadable", gate: null, error };
    }

    if (raw && raw.trim() !== "") {
      try {
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          Number.isFinite(Number(parsed.pid)) &&
          typeof parsed.token === "string" &&
          parsed.token.trim() !== ""
        ) {
          return { status: "ok", gate: parsed, error: null };
        }
      } catch {
        // Kemungkinan inisialisasi parsial dari penulis eksternal; tunggu singkat.
      }
    }

    if (!waitForPartialInit || Date.now() >= deadline) {
      return { status: "corrupt", gate: null, error: null };
    }
    sleepSync(10);
  }
}

function isGateStaleParsed(parsed, { isAlive, isHolderProcess, shouldConsultDefaultHolder, host }) {
  if (!parsed || typeof parsed !== "object") return false;

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

function releaseGateEntry(resolvedDir, entry) {
  entry.count -= 1;
  if (entry.count <= 0 && !entry.cleanedUp) {
    entry.active = false;
    entry.cleanedUp = true;
    if (activeGateDepth.get(resolvedDir) === entry) {
      activeGateDepth.delete(resolvedDir);
    }
    if (entry.contextMap && entry.contextMap.get(resolvedDir) === entry) {
      entry.contextMap.delete(resolvedDir);
    }
    try {
      const diskRaw = readFileSync(entry.gateFile, "utf8");
      const diskGate = JSON.parse(diskRaw);
      if (diskGate && diskGate.token === entry.token) {
        unlinkSync(entry.gateFile);
      }
    } catch {}
    if (typeof entry.onFullyReleased === "function") {
      const notify = entry.onFullyReleased;
      entry.onFullyReleased = null;
      notify();
    }
  }
}

/**
 * R3-1: Set kapabilitas pemulihan gerbang tepercaya yang tidak dapat dipalsukan
 * oleh pemanggil biasa atau handler permintaan MCP melalui flag boolean.
 */
const TRUSTED_GATE_RECOVERY_AUTHORITIES = new WeakSet();

/**
 * Mencetak kapabilitas otoritas pemulihan gerbang tepercaya hanya ketika proses
 * dijalankan dalam konteks pemeliharaan operator eksplisit (`DEVWF_OPERATOR_GATE_RECOVERY=1`).
 */
export function mintTrustedGateRecoveryAuthority({
  operatorId = "",
  reason = "",
  env = process.env,
} = {}) {
  if (String(env?.DEVWF_OPERATOR_GATE_RECOVERY || "").trim() !== "1") {
    const err = new Error(
      "Trusted gate recovery authority requires explicit operator maintenance context (DEVWF_OPERATOR_GATE_RECOVERY=1).",
    );
    err.code = "OPERATOR_RECOVERY_AUTH_REQUIRED";
    throw err;
  }
  if (!operatorId || typeof operatorId !== "string" || operatorId.trim() === "") {
    const err = new Error("operatorId is required to mint gate recovery authority.");
    err.code = "OPERATOR_ID_REQUIRED";
    throw err;
  }
  if (!reason || typeof reason !== "string" || reason.trim() === "") {
    const err = new Error("reason is required to mint gate recovery authority.");
    err.code = "RECOVERY_REASON_REQUIRED";
    throw err;
  }
  const authority = Object.freeze({
    operatorId: operatorId.trim(),
    reason: reason.trim(),
    issuedAt: Date.now(),
    pid: process.pid,
    incarnationId: PROCESS_INCARNATION_ID,
  });
  TRUSTED_GATE_RECOVERY_AUTHORITIES.add(authority);
  return authority;
}

export function isTrustedGateRecoveryAuthority(authority) {
  return Boolean(authority && TRUSTED_GATE_RECOVERY_AUTHORITIES.has(authority));
}

/**
 * Pemulihan gerbang lock yang ditinggalkan proses mati secara terkendali dan
 * memerlukan kapabilitas tepercaya (`recoveryAuthority`) serta pencocokan token
 * (`expectedToken`) di bawah kunci pemulihan eksklusif (R2-1 / R3-1).
 *
 * ATURAN KEAMANAN (R2-1 / R3-1):
 *   - Flag boolean `authorizeAbandonedGateRecovery: true` TIDAK lagi diterima;
 *     pemulihan wajib menyertakan `recoveryAuthority` dari `mintTrustedGateRecoveryAuthority`.
 *   - Bila `mcp-process.gate.recover.lock` sendiri ditinggalkan proses mati, fungsi
 *     ini gagal tertutup (`recovery_lock_abandoned`) tanpa menambah lapisan lock baru.
 */
export function recoverAbandonedLockGate({
  dir,
  expectedToken = null,
  recoveryAuthority = null,
  authorizeAbandonedGateRecovery: _ignoredBooleanFlag = false,
  pid = process.pid,
  isAlive = currentIsAlive(),
  isHolderProcess = currentIsHolderProcess(),
  hooks = null,
} = {}) {
  if (!isTrustedGateRecoveryAuthority(recoveryAuthority)) {
    return {
      ok: false,
      recovered: false,
      reason: "trusted_recovery_authority_required",
    };
  }
  if (!dir) {
    return {
      ok: false,
      recovered: false,
      reason: "invalid_dir",
    };
  }
  if (!expectedToken || typeof expectedToken !== "string" || expectedToken.trim() === "") {
    return {
      ok: false,
      recovered: false,
      reason: "expected_token_required",
    };
  }

  const resolvedDir = path.resolve(dir);
  const gateFile = processGatePath({ dir: resolvedDir });
  const recoverLockFile = path.join(resolvedDir, GATE_RECOVER_FILENAME);
  const recoverToken = `recover-${pid}-${PROCESS_INCARNATION_ID}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const host = safeHostname();
  const shouldConsultDefaultHolder =
    isHolderProcess !== defaultIsHolderProcess ||
    (isAlive === defaultIsAlive && !isAliveOverride);

  try {
    mkdirSync(resolvedDir, { recursive: true });
    publishCompleteJsonFile(
      recoverLockFile,
      {
        pid,
        incarnationId: PROCESS_INCARNATION_ID,
        token: recoverToken,
        expectedToken,
        operatorId: recoveryAuthority.operatorId,
        startedAt: Date.now(),
        host,
      },
      { replaceIfExists: false, pid },
    );
  } catch (error) {
    if (error && error.code === "EEXIST") {
      const existingRecover = readGateDetailed(recoverLockFile, { waitForPartialInit: false });
      if (
        existingRecover.status === "corrupt" ||
        (existingRecover.status === "ok" &&
          isGateStaleParsed(existingRecover.gate, {
            isAlive,
            isHolderProcess,
            shouldConsultDefaultHolder,
            host,
          }))
      ) {
        return {
          ok: false,
          recovered: false,
          reason: "recovery_lock_abandoned",
          recoverLockFile,
          holder: existingRecover.gate || null,
        };
      }
      return {
        ok: false,
        recovered: false,
        reason: "recovery_in_progress",
        holder: existingRecover.gate || null,
      };
    }
    return {
      ok: false,
      recovered: false,
      reason: "recovery_lock_error",
      error: (error && (error.code || error.message)) || "EACCES",
    };
  }

  try {
    const detailed = readGateDetailed(gateFile, { waitForPartialInit: true });
    if (detailed.status === "missing") {
      return {
        ok: false,
        recovered: false,
        reason: "gate_missing",
      };
    }
    if (detailed.status === "unreadable") {
      return {
        ok: false,
        recovered: false,
        reason: "gate_unreadable",
      };
    }

    if (detailed.status === "corrupt") {
      if (expectedToken !== "CORRUPT_GATE") {
        return {
          ok: false,
          recovered: false,
          reason: "gate_token_mismatch",
          actualToken: null,
        };
      }
    } else {
      const gate = detailed.gate;
      if (gate.token !== expectedToken) {
        return {
          ok: false,
          recovered: false,
          reason: "gate_token_mismatch",
          actualToken: gate.token,
          holder: gate,
        };
      }
      if (!isGateStaleParsed(gate, { isAlive, isHolderProcess, shouldConsultDefaultHolder, host })) {
        return {
          ok: false,
          recovered: false,
          reason: "gate_holder_alive",
          holder: gate,
        };
      }
    }

    if (typeof hooks?.onBeforeUnlinkAbandonedGate === "function") {
      hooks.onBeforeUnlinkAbandonedGate({
        dir: resolvedDir,
        gateFile,
        gate: detailed.gate,
        expectedToken,
      });
    }

    // Verifikasi ulang di bawah `recoverLockFile` tepat sebelum unlink.
    const verify = readGateDetailed(gateFile, { waitForPartialInit: false });
    if (verify.status === "missing") {
      return {
        ok: false,
        recovered: false,
        reason: "gate_missing",
      };
    }
    if (verify.status === "ok" && verify.gate.token !== expectedToken) {
      return {
        ok: false,
        recovered: false,
        reason: "gate_token_mismatch",
        actualToken: verify.gate.token,
        holder: verify.gate,
      };
    }

    unlinkSync(gateFile);
    return {
      ok: true,
      recovered: true,
      dir: resolvedDir,
      recoveredToken: expectedToken,
      previousHolder: detailed.gate || null,
    };
  } catch (error) {
    return {
      ok: false,
      recovered: false,
      reason: "unlink_failed",
      error: (error && (error.code || error.message)) || "unknown",
    };
  } finally {
    try {
      const raw = readFileSync(recoverLockFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.token === recoverToken) {
        unlinkSync(recoverLockFile);
      }
    } catch {}
  }
}

/**
 * Mengambil gerbang eksklusif (`mcp-process.gate.lock`) untuk satu direktori lock.
 *
 * ATURAN KEAMANAN (R2-1, R2-2, R2-3):
 *   1. Re-entrancy HANYA diizinkan di dalam konteks eksekusi asinkron yang sama
 *      (`gateExecutionStorage` / `AsyncLocalStorage`). Permintaan paralel di
 *      proses yang sama TIDAK PERNAH dianggap re-entrant.
 *   2. Penutupan gerbang (`releaseGateEntry`) dieksekusi saat pemegang valid
 *      terakhir (`entry.count === 0`) keluar, baik itu pemegang luar maupun
 *      pemegang bersarang (nested), sehingga gerbang tidak pernah tertinggal.
 *   3. Bila gerbang dipegang oleh proses yang sudah mati, akuisisi normal SELALU
 *      gagal tertutup (`LOCK_GATE_ABANDONED`) tanpa me-rename berkas gerbang,
 *      sehingga tidak pernah ada balapan pathname yang menghapus gerbang suksesor.
 */
export function acquireLockGate(
  dir,
  {
    pid = process.pid,
    timeoutMs = DEFAULT_GATE_TIMEOUT_MS,
    isAlive = currentIsAlive(),
    isHolderProcess = currentIsHolderProcess(),
    hooks = null,
    _scopedContextMap = null,
  } = {},
) {
  const resolvedDir = path.resolve(dir);
  const storeMap = _scopedContextMap || gateExecutionStorage.getStore();
  const contextEntry = storeMap ? storeMap.get(resolvedDir) : null;

  if (
    contextEntry &&
    contextEntry.active === true &&
    !contextEntry.cleanedUp &&
    contextEntry.pid === pid &&
    contextEntry.incarnationId === PROCESS_INCARNATION_ID
  ) {
    contextEntry.count += 1;
    let released = false;
    return {
      ok: true,
      reentrant: true,
      token: contextEntry.token,
      release() {
        if (released) return;
        released = true;
        releaseGateEntry(resolvedDir, contextEntry);
      },
    };
  }

  // R2-3: Bila konteks eksekusi LAIN di dalam proses yang sama sedang memegang
  // gerbang untuk `resolvedDir`, jangan pernah menganggap panggilan ini re-entrant
  // dan jangan memblokir event loop tunggal dengan spin sinkron.
  const otherInProcessHolder = activeGateDepth.get(resolvedDir);
  if (otherInProcessHolder && !otherInProcessHolder.cleanedUp) {
    return {
      ok: false,
      reentrant: false,
      error: "LOCK_GATE_BUSY_IN_PROCESS",
      holder: {
        pid: otherInProcessHolder.pid,
        incarnationId: otherInProcessHolder.incarnationId,
        token: otherInProcessHolder.token,
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
  const recoverLockFile = path.join(resolvedDir, GATE_RECOVER_FILENAME);
  const host = safeHostname();
  const shouldConsultDefaultHolder =
    isHolderProcess !== defaultIsHolderProcess ||
    (isAlive === defaultIsAlive && !isAliveOverride);
  const deadline = Date.now() + Math.max(50, Number(timeoutMs) || DEFAULT_GATE_TIMEOUT_MS);
  const gateToken = `${pid}-${PROCESS_INCARNATION_ID}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  let contentionNotified = false;

  while (true) {
    // Tunggu bila pemulihan gerbang berotorisasi sedang berlangsung pada direktori ini;
    // gagal tertutup bila berkas pemulihan ternyata ditinggalkan proses mati.
    if (existsSync(recoverLockFile)) {
      const recoverDetailed = readGateDetailed(recoverLockFile, { waitForPartialInit: false });
      if (
        recoverDetailed.status === "corrupt" ||
        (recoverDetailed.status === "ok" &&
          isGateStaleParsed(recoverDetailed.gate, {
            isAlive,
            isHolderProcess,
            shouldConsultDefaultHolder,
            host,
          }))
      ) {
        return {
          ok: false,
          error: "LOCK_GATE_RECOVERY_ABANDONED",
          abandoned: true,
          recoverLockFile,
          holder: recoverDetailed.gate || null,
        };
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          error: "LOCK_GATE_RECOVERY_BUSY",
        };
      }
      sleepSync(2);
      continue;
    }

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

      // Bila `recoverLockFile` muncul berbarengan tepat saat kita menerbitkan
      // gerbang, mundur secara bersih agar pemulihan dan akuisisi tidak beririsan.
      if (existsSync(recoverLockFile)) {
        try {
          const diskRaw = readFileSync(gateFile, "utf8");
          const diskGate = JSON.parse(diskRaw);
          if (diskGate && diskGate.token === gateToken) {
            unlinkSync(gateFile);
          }
        } catch {}
        if (Date.now() >= deadline) {
          return {
            ok: false,
            error: "LOCK_GATE_RECOVERY_BUSY",
          };
        }
        sleepSync(2);
        continue;
      }

      const activeContextMap = storeMap || new Map();
      let resolveFullyReleased;
      const allReleasedPromise = new Promise((resolve) => {
        resolveFullyReleased = resolve;
      });
      const entry = {
        pid,
        incarnationId: PROCESS_INCARNATION_ID,
        token: gateToken,
        gateFile,
        count: 1,
        active: true,
        cleanedUp: false,
        contextMap: activeContextMap,
        allReleasedPromise,
        onFullyReleased: resolveFullyReleased,
      };
      activeGateDepth.set(resolvedDir, entry);
      activeContextMap.set(resolvedDir, entry);
      if (!storeMap) {
        gateExecutionStorage.enterWith(activeContextMap);
      }

      let released = false;
      return {
        ok: true,
        reentrant: false,
        token: gateToken,
        _entry: entry,
        release() {
          if (released) return;
          released = true;
          releaseGateEntry(resolvedDir, entry);
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

    const detailed = readGateDetailed(gateFile, { waitForPartialInit: true });
    if (detailed.status === "missing") {
      continue;
    }

    if (!contentionNotified && typeof hooks?.onGateContention === "function") {
      contentionNotified = true;
      hooks.onGateContention({
        dir: resolvedDir,
        gateFile,
        status: detailed.status,
        gate: detailed.gate,
      });
    }

    if (detailed.status === "unreadable") {
      return {
        ok: false,
        error: (detailed.error && (detailed.error.code || detailed.error.message)) || "EACCES",
      };
    }

    if (detailed.status === "corrupt") {
      return {
        ok: false,
        error: "LOCK_GATE_CORRUPT",
        abandoned: true,
        gateFile,
      };
    }

    // R2-1: Bila pemegang gerbang sudah terbukti mati, JANGAN PERNAH me-rename
    // atau menghapus `gateFile` secara otomatis (fail-closed).
    if (
      isGateStaleParsed(detailed.gate, {
        isAlive,
        isHolderProcess,
        shouldConsultDefaultHolder,
        host,
      })
    ) {
      return {
        ok: false,
        error: "LOCK_GATE_ABANDONED",
        abandoned: true,
        gateFile,
        holder: detailed.gate,
      };
    }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: "LOCK_GATE_TIMEOUT",
        gateFile,
        holder: detailed.gate,
      };
    }

    sleepSync(2);
  }
}

function executeInGateScope(resolvedDir, fn, options = {}, existingContextMap = null) {
  const scopedMap = existingContextMap ? new Map(existingContextMap) : new Map();
  return gateExecutionStorage.run(scopedMap, () => {
    const gate = acquireLockGate(resolvedDir, { ...options, _scopedContextMap: scopedMap });
    if (!gate.ok) {
      const err = new Error(`Failed to acquire lock gate for ${resolvedDir}: ${gate.error}`);
      err.code = gate.error || "LOCK_GATE_FAILED";
      err.details = gate;
      throw err;
    }

    let isAsync = false;
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        isAsync = true;
        if (!gate.reentrant && gate._entry) {
          const prevQueue = inProcessGateQueues.get(resolvedDir) || Promise.resolve();
          const queuedPromise = prevQueue
            .catch(() => {})
            .then(() => gate._entry.allReleasedPromise);
          inProcessGateQueues.set(resolvedDir, queuedPromise);
          queuedPromise.finally(() => {
            if (inProcessGateQueues.get(resolvedDir) === queuedPromise) {
              inProcessGateQueues.delete(resolvedDir);
            }
          });
        }
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
  });
}

/**
 * Menjalankan `fn` (sinkron atau asinkron) di dalam gerbang eksklusif `dir`
 * dengan isolasi konteks eksekusi `AsyncLocalStorage` (R2-2 & R2-3).
 */
export function withLockGate(dir, fn, options = {}) {
  const resolvedDir = path.resolve(dir);
  const currentStore = gateExecutionStorage.getStore();
  const contextEntry = currentStore ? currentStore.get(resolvedDir) : null;

  // Panggilan bersarang (nested) di dalam konteks eksekusi yang sama:
  if (
    contextEntry &&
    contextEntry.active === true &&
    !contextEntry.cleanedUp &&
    contextEntry.pid === (options.pid || process.pid) &&
    contextEntry.incarnationId === PROCESS_INCARNATION_ID
  ) {
    return executeInGateScope(resolvedDir, fn, options, currentStore);
  }

  // R2-3: Bila ada operasi asinkron lain di proses yang sama yang sedang
  // memegang gerbang `resolvedDir`, antrekan panggilan independen ini secara
  // asinkron hingga pemegang sebelumnya (beserta seluruh panggilan bersarangnya)
  // selesai melepas gerbang.
  const activeOther = activeGateDepth.get(resolvedDir);
  const pendingQueue = inProcessGateQueues.get(resolvedDir);
  if ((activeOther && !activeOther.cleanedUp) || pendingQueue) {
    const waitTarget = pendingQueue || activeOther?.allReleasedPromise || Promise.resolve();
    let releaseTurn;
    const myTurnDone = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    const nextQueue = waitTarget.catch(() => {}).then(() => myTurnDone);
    inProcessGateQueues.set(resolvedDir, nextQueue);

    return waitTarget
      .catch(() => {})
      .then(() => executeInGateScope(resolvedDir, fn, options, currentStore))
      .finally(() => {
        releaseTurn();
        if (inProcessGateQueues.get(resolvedDir) === nextQueue) {
          inProcessGateQueues.delete(resolvedDir);
        }
      });
  }

  return executeInGateScope(resolvedDir, fn, options, currentStore);
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
  const gate = acquireLockGate(resolvedDir, { pid, isAlive, isHolderProcess, hooks });
  if (!gate.ok) {
    return {
      acquired: false,
      wrote: false,
      error: gate.error || "LOCK_GATE_FAILED",
      ...(gate.abandoned ? { abandonedGate: true, gateHolder: gate.holder || null } : {}),
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
    releaseKernelMutex(resolvedDir);
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
 * yang masih hidup pada direktori awal, direktori target, seluruh bucket proyek
 * di pohon state yang sama (bahkan bila penunjuk sesi hilang atau usang), atau
 * berkas state aktif milik proyek target (R2-5).
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
  readdirSyncImpl = readdirSync,
} = {}) {
  const dirsToCheck = new Set();
  if (toDir) dirsToCheck.add(path.resolve(toDir));
  if (fromDir) dirsToCheck.add(path.resolve(fromDir));

  // R2-5 + R3-6: Pindai SELURUH bucket di `<base>/projects/*`; bila pembacaan
  // direktori gagal (mis. EACCES/EPERM), gagal tertutup (`legacy_inspection_failed`).
  const candidateDirs = [toDir, fromDir].filter(Boolean).map((d) => path.resolve(d));
  for (const cand of candidateDirs) {
    if (path.basename(path.dirname(cand)) === "projects") {
      const projectsRoot = path.dirname(cand);
      if (existsSync(projectsRoot)) {
        try {
          for (const bEntry of readdirSyncImpl(projectsRoot, { withFileTypes: true })) {
            if (bEntry.isDirectory()) {
              dirsToCheck.add(path.join(projectsRoot, bEntry.name));
            }
          }
        } catch (error) {
          return {
            detected: true,
            failClosed: true,
            reason: "legacy_inspection_failed",
            dir: projectsRoot,
            error: (error && (error.code || error.message)) || "EACCES",
            holder: null,
          };
        }
      }
    }
  }

  for (const checkDir of dirsToCheck) {
    const detailedLock = readProcessLockDetailed({ dir: checkDir });
    if (detailedLock.status === "unreadable") {
      return {
        detected: true,
        failClosed: true,
        reason: "legacy_inspection_failed",
        dir: checkDir,
        error: detailedLock.error?.code || detailedLock.error?.message || "EACCES",
        holder: null,
      };
    }
    const lock = detailedLock.lock;
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

  // Periksa juga apakah ada berkas state aktif pada `toDir` yang ditulis oleh
  // proses hidup tanpa lease protokol v2 pada `toDir` (mis. penulis legacy yang
  // berkas lock startup-nya berada di luar pohon `<base>/projects`).
  const resolvedTo = toDir ? path.resolve(toDir) : null;
  if (resolvedTo && existsSync(resolvedTo)) {
    const targetLock = readProcessLock({ dir: resolvedTo });
    const stateCandidateFiles = [];
    try {
      for (const entry of readdirSyncImpl(resolvedTo, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.startsWith("workflow-state") && entry.name.endsWith(".json")) {
          stateCandidateFiles.push(path.join(resolvedTo, entry.name));
        }
      }
      const usersDir = path.join(resolvedTo, "users");
      if (existsSync(usersDir)) {
        for (const uEntry of readdirSyncImpl(usersDir, { withFileTypes: true })) {
          if (!uEntry.isDirectory()) continue;
          const uPath = path.join(usersDir, uEntry.name);
          for (const fEntry of readdirSyncImpl(uPath, { withFileTypes: true })) {
            if (fEntry.isFile() && fEntry.name.startsWith("workflow-state") && fEntry.name.endsWith(".json")) {
              stateCandidateFiles.push(path.join(uPath, fEntry.name));
            }
          }
        }
      }
    } catch (error) {
      return {
        detected: true,
        failClosed: true,
        reason: "legacy_inspection_failed",
        dir: resolvedTo,
        error: (error && (error.code || error.message)) || "EACCES",
        holder: null,
      };
    }

    const targetNorm = projectDir ? path.resolve(projectDir).replace(/\\/g, "/").toLowerCase() : "";
    for (const sFile of stateCandidateFiles) {
      try {
        const parsed = JSON.parse(readFileSync(sFile, "utf8"));
        const phase = typeof parsed?.currentPhase === "string" ? parsed.currentPhase : "idle";
        const desc = typeof parsed?.taskDescription === "string" ? parsed.taskDescription.trim() : "";
        if (phase === "idle" || !desc) continue;

        const ownerPid = Number(parsed?.owner?.pid);
        if (!Number.isFinite(ownerPid) || ownerPid <= 0 || ownerPid === pid) continue;

        const stateProjNorm =
          typeof parsed?.projectDir === "string" && parsed.projectDir.trim()
            ? path.resolve(parsed.projectDir).replace(/\\/g, "/").toLowerCase()
            : "";
        if (targetNorm && stateProjNorm && stateProjNorm !== targetNorm) continue;

        // Bila pemilik state aktif ini memiliki lock v2 yang sah pada `resolvedTo`,
        // maka ia bukan penulis legacy (ditangani oleh pemeriksaan `foreign_lock` biasa).
        if (targetLock && targetLock.pid === ownerPid && !isLegacyLock(targetLock)) {
          continue;
        }

        const ownerStartedAt = parsed?.owner?.updatedAt ? Date.parse(parsed.owner.updatedAt) : now;
        const liveness = evaluateLockHolderLiveness(
          { pid: ownerPid, startedAt: Number.isFinite(ownerStartedAt) ? ownerStartedAt : now, _lockDir: resolvedTo },
          { pid, now, staleMs, isAlive, isHolderProcess },
        );
        if (!liveness.isConfirmedDead) {
          return {
            detected: true,
            dir: resolvedTo,
            holder: {
              pid: ownerPid,
              startedAt: Number.isFinite(ownerStartedAt) ? ownerStartedAt : now,
              ageMs: liveness.age,
              staleHeartbeat: liveness.staleHeartbeat,
              legacy: true,
              source: "unleashed_active_state",
            },
          };
        }
      } catch {}
    }
  }

  return { detected: false, holder: null };
}

/**
 * Memverifikasi keheningan armada (fleet quiescence) sebelum atau sesudah aktivasi
 * Protokol v2 (R2-5): memastikan tidak ada proses legacy v1 yang masih hidup,
 * tidak ada gerbang yang ditinggalkan (`LOCK_GATE_ABANDONED`), dan tidak ada
 * jurnal transisi yang menggantung pada `<baseDir>`.
 */
const ADMISSION_BARRIER_FILENAME = "maintenance-admission.json";

export function admissionBarrierPath(baseDir) {
  return path.join(path.resolve(baseDir), ADMISSION_BARRIER_FILENAME);
}

/**
 * Menerbitkan penghalang admisi pemeliharaan (maintenance admission barrier)
 * pada `<baseDir>/maintenance-admission.json` untuk menahan peluncuran/aktivitas
 * baru selama transisi armada v1 -> v2 (R3-6).
 */
export function acquireMaintenanceAdmissionBarrier({
  baseDir,
  maintenanceToken,
  operatorId = "operator",
  reason = "protocol_v2_cutover",
  minProtocolVersion = LOCK_PROTOCOL_VERSION,
  pid = process.pid,
} = {}) {
  if (!baseDir || !maintenanceToken) {
    return { ok: false, reason: "invalid_arguments" };
  }
  const barrierFile = admissionBarrierPath(baseDir);
  mkdirSync(path.dirname(barrierFile), { recursive: true });
  const payload = {
    state: "DRAINING",
    maintenanceToken,
    operatorId,
    reason,
    minProtocolVersion,
    pid,
    incarnationId: PROCESS_INCARNATION_ID,
    startedAt: Date.now(),
    host: safeHostname(),
  };
  try {
    publishCompleteJsonFile(barrierFile, payload, { replaceIfExists: false, pid });
    return { ok: true, barrierFile, barrier: payload };
  } catch (error) {
    if (error && error.code === "EEXIST") {
      return { ok: false, reason: "barrier_already_active", barrierFile };
    }
    return { ok: false, reason: "barrier_write_error", error: error?.code || error?.message || "EACCES" };
  }
}

export function checkLegacyAdmissionBarrier({ baseDir, maintenanceToken = null } = {}) {
  if (!baseDir) return { blocked: false, barrier: null };
  const barrierFile = admissionBarrierPath(baseDir);
  if (!existsSync(barrierFile)) return { blocked: false, barrier: null };
  try {
    const parsed = JSON.parse(readFileSync(barrierFile, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return { blocked: true, reason: "corrupt_admission_barrier", barrierFile };
    }
    if (parsed.state === "OPEN") {
      return { blocked: false, barrier: parsed };
    }
    if (maintenanceToken && parsed.maintenanceToken === maintenanceToken) {
      return { blocked: false, barrier: parsed, authorizedByToken: true };
    }
    return { blocked: true, reason: "admission_barrier_active", barrierFile, barrier: parsed };
  } catch (error) {
    return {
      blocked: true,
      reason: "unreadable_admission_barrier",
      barrierFile,
      error: error?.code || error?.message || "EACCES",
    };
  }
}

export function releaseMaintenanceAdmissionBarrier({ baseDir, maintenanceToken } = {}) {
  if (!baseDir || !maintenanceToken) return { ok: false, reason: "invalid_arguments" };
  const barrierFile = admissionBarrierPath(baseDir);
  if (!existsSync(barrierFile)) return { ok: false, reason: "barrier_missing" };
  try {
    const parsed = JSON.parse(readFileSync(barrierFile, "utf8"));
    if (!parsed || parsed.maintenanceToken !== maintenanceToken) {
      return { ok: false, reason: "maintenance_token_mismatch" };
    }
    unlinkSync(barrierFile);
    return { ok: true, released: true, barrierFile };
  } catch (error) {
    return { ok: false, reason: "barrier_release_error", error: error?.code || error?.message || "EACCES" };
  }
}

/**
 * Memverifikasi keheningan armada (fleet quiescence) secara fail-closed sebelum atau
 * sesudah aktivasi Protokol v2 (R2-5 + R3-6): memastikan tidak ada proses legacy v1
 * yang masih hidup, tidak ada gerbang/lock pemulihan yang ditinggalkan, tidak ada
 * jurnal transisi yang menggantung, dan TIDAK ada direktori/berkas yang gagal dibaca.
 */
export function verifyLegacyFleetQuiescence({
  baseDir = null,
  dirs = [],
  pid = process.pid,
  now = Date.now(),
  staleMs = DEFAULT_LOCK_STALE_MS,
  isAlive = currentIsAlive(),
  isHolderProcess = currentIsHolderProcess(),
  readdirSyncImpl = readdirSync,
} = {}) {
  const bucketDirs = new Set((Array.isArray(dirs) ? dirs : []).filter(Boolean).map((d) => path.resolve(d)));
  const resolvedBase = baseDir ? path.resolve(baseDir) : null;
  const inspectionErrors = [];

  if (resolvedBase) {
    if (!existsSync(resolvedBase)) {
      inspectionErrors.push({ dir: resolvedBase, reason: "base_dir_missing" });
    } else {
      const projectsRoot = path.join(resolvedBase, "projects");
      if (existsSync(projectsRoot)) {
        try {
          for (const entry of readdirSyncImpl(projectsRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              bucketDirs.add(path.join(projectsRoot, entry.name));
            }
          }
        } catch (error) {
          inspectionErrors.push({
            dir: projectsRoot,
            reason: "projects_root_unreadable",
            error: error?.code || error?.message || "EACCES",
          });
        }
      }
    }
  }

  const legacyWriters = [];
  const abandonedGates = [];
  const pendingJournals = [];
  const host = safeHostname();
  const shouldConsultDefaultHolder =
    isHolderProcess !== defaultIsHolderProcess ||
    (isAlive === defaultIsAlive && !isAliveOverride);

  for (const dir of bucketDirs) {
    const detailedLock = readProcessLockDetailed({ dir });
    if (detailedLock.status === "unreadable") {
      inspectionErrors.push({
        dir,
        reason: "lock_unreadable",
        error: detailedLock.error?.code || detailedLock.error?.message || "EACCES",
      });
    } else if (detailedLock.status === "corrupt") {
      inspectionErrors.push({ dir, reason: "lock_corrupt" });
    } else if (detailedLock.lock && detailedLock.lock.pid !== pid && isLegacyLock(detailedLock.lock)) {
      const lock = detailedLock.lock;
      const liveness = evaluateLockHolderLiveness(
        { ...lock, _lockDir: dir },
        { pid, now, staleMs, isAlive, isHolderProcess, host },
      );
      if (!liveness.isConfirmedDead) {
        legacyWriters.push({
          dir,
          pid: lock.pid,
          startedAt: lock.startedAt || null,
          ageMs: liveness.age,
        });
      }
    }

    const gateFile = processGatePath({ dir });
    if (existsSync(gateFile)) {
      const gateDetailed = readGateDetailed(gateFile, { waitForPartialInit: false });
      if (gateDetailed.status === "unreadable") {
        inspectionErrors.push({
          dir,
          gateFile,
          reason: "gate_unreadable",
          error: gateDetailed.error?.code || gateDetailed.error?.message || "EACCES",
        });
      } else if (
        gateDetailed.status === "corrupt" ||
        (gateDetailed.status === "ok" &&
          isGateStaleParsed(gateDetailed.gate, {
            isAlive,
            isHolderProcess,
            shouldConsultDefaultHolder,
            host,
          }))
      ) {
        abandonedGates.push({
          dir,
          gateFile,
          status: gateDetailed.status,
          holder: gateDetailed.gate || null,
        });
      }
    }

    const recoverLockFile = path.join(dir, GATE_RECOVER_FILENAME);
    if (existsSync(recoverLockFile)) {
      const recDetailed = readGateDetailed(recoverLockFile, { waitForPartialInit: false });
      if (recDetailed.status !== "missing") {
        abandonedGates.push({
          dir,
          gateFile: recoverLockFile,
          status: `recover_${recDetailed.status}`,
          holder: recDetailed.gate || null,
        });
      }
    }
  }

  if (resolvedBase) {
    const sessionsDir = path.join(resolvedBase, "sessions");
    if (existsSync(sessionsDir)) {
      try {
        for (const sEntry of readdirSyncImpl(sessionsDir, { withFileTypes: true })) {
          if (sEntry.isFile() && sEntry.name.startsWith("transition-") && sEntry.name.endsWith(".journal.json")) {
            pendingJournals.push(path.join(sessionsDir, sEntry.name));
          }
        }
      } catch (error) {
        inspectionErrors.push({
          dir: sessionsDir,
          reason: "sessions_dir_unreadable",
          error: error?.code || error?.message || "EACCES",
        });
      }
    }
  }

  const admissionBarrier = resolvedBase ? checkLegacyAdmissionBarrier({ baseDir: resolvedBase }) : { blocked: false, barrier: null };
  const quiescent =
    legacyWriters.length === 0 &&
    abandonedGates.length === 0 &&
    pendingJournals.length === 0 &&
    inspectionErrors.length === 0;

  return {
    quiescent,
    legacyWriters,
    abandonedGates,
    pendingJournals,
    inspectionErrors,
    admissionBarrier,
  };
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

  // R3-6: Hormati penghalang admisi pemeliharaan pada state root bila sedang aktif.
  if (path.basename(path.dirname(targetDir)) === "projects") {
    const baseDir = path.dirname(path.dirname(targetDir));
    const barrierCheck = checkLegacyAdmissionBarrier({ baseDir });
    if (barrierCheck.blocked) {
      return {
        ok: false,
        reason: barrierCheck.reason || "admission_barrier_active",
        barrier: barrierCheck.barrier || null,
      };
    }
  }

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
