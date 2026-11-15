/**
 * One marker for "which MCP process is currently alive" per state directory.
 *
 * Ownership Protocol v2 (Gate-Serialized & Capability-Fenced):
 *   1. Every critical mutation and verification of `mcp-process.lock` is serialized
 *      through a cross-process exclusive gate (`mcp-process.gate.lock`) that is
 *      published atomically using `writeFileSync(tmp) + linkSync(tmp, gate)`.
 *   2. The main lock file (`mcp-process.lock`) is always written in full to a
 *      temporary file and then installed atomically, so a reader never
 *      sees a 0-byte or half-written file (partial initialization).
 *   3. Ownership is bound to the `(pid, leaseId, incarnationId)` capability —
 *      a matching PID alone NEVER grants the right to adopt, to refresh the
 *      heartbeat, to re-enter, or to release the lock.
 *   4. A late or expired heartbeat NEVER permits takeover while the original
 *      holder process is still alive.
 *   5. I/O or permission failures (`EACCES`, `ENOSPC`, etc.) always fail closed
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

/** Start time of this OS process (ms epoch) and the unique incarnation token of this process. */
export const SELF_PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1000);
export const PROCESS_INCARNATION_ID = `inc-${process.pid}-${SELF_PROCESS_STARTED_AT_MS.toString(36)}-${randomUUID().slice(0, 8)}`;

/**
 * Raised when the process loses project lock ownership in the middle of a
 * persistence operation (persistence fencing).
 */
export class ProjectOwnershipLostError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProjectOwnershipLostError";
    this.code = "PROJECT_OWNERSHIP_LOST";
    this.details = details;
  }
}

/** Map of active leases held by this process per canonical lock directory. */
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

function isValidGitHeadContent(headContent) {
  const trimmed = String(headContent || "").trim();
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(trimmed)) return true;
  const refMatch = /^ref:[ \t]*([^\s\r\n]+)$/.exec(trimmed);
  if (!refMatch) return false;
  const ref = refMatch[1];
  if (!ref.startsWith("refs/")) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{") || ref.endsWith("/") || ref.endsWith(".")) {
    return false;
  }
  if (/[ ~^:?*[\\]/.test(ref)) return false;
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  const parts = ref.split("/");
  return parts.length >= 2 && parts.every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function isValidGitHeadFile(headPath) {
  try {
    if (!existsSync(headPath)) return false;
    const headStat = statSync(headPath);
    if (!headStat.isFile()) return false;
    return isValidGitHeadContent(readFileSync(headPath, "utf8"));
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

/** Map of active gate entries for this process (one per canonical directory). */
const activeGateDepth = new Map();

/** Async execution-context storage for re-entrant gate ownership (R2-2 & R2-3). */
const gateExecutionStorage = new AsyncLocalStorage();

/** In-process async queue per directory so parallel requests cannot bypass the gate (R2-3). */
const inProcessGateQueues = new Map();

/** Primary active lock directory and lease remembered by this process. */
let rememberedLockDir = null;
let rememberedLeaseId = null;
let rememberedPid = null;
let rememberedIncarnationId = null;

/** For tests only: override the "is process alive" and "is holder process" checks. */
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
      // Fallback spin when Atomics.wait is unavailable in special environments.
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

/** Lock file location for one state directory. */
export function processLockPath({ dir }) {
  return path.join(dir, LOCK_FILENAME);
}

/** Exclusive gate file location for one state directory. */
export function processGatePath({ dir }) {
  return path.join(dir, GATE_FILENAME);
}

/**
 * The PROJECT's `.state` directory for a state file.
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
 * Reads lock file status explicitly:
 *   - missing: the file does not exist
 *   - ok: a valid file with a numeric pid
 *   - corrupt: the file exists but is not valid JSON / the pid is invalid
 *   - unreadable: the file exists but could not be read due to permissions/IO
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
 * Reads the lock contents, or null when it is absent / unreadable.
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
  // Reject generic `node -e` / `--eval` executions that other processes often use,
  // unless they explicitly run the dev-workflow / process-lock module.
  if (/\bnode(?:\.exe)?\b[^]*\s(?:-e|--eval)\b/i.test(text) || /\s(?:-e|--eval)\b/i.test(text)) {
    return /dev-workflow|ManagedMCP|process-lock|workflow-state|workflow-handlers/i.test(text);
  }
  return /ManagedMCP|dev-workflow|index\.m?js|cli\.m?js|process-lock|node:test|--test/i.test(text);
}

/**
 * Is the process with that PID really the dev-workflow lock holder that
 * wrote the lock file?
 *
 * It distinguishes:
 *   1. A non-Node process that reused the PID (e.g. Calendar.app, notepad.exe).
 *   2. ANOTHER Node.js process that reused the PID (e.g. `node -e ...` or another
 *      server, or a new process born AFTER `existingLock.startedAt`).
 *   3. An older incarnation of our own `process.pid`.
 *
 * Returns true/false when it can be decided, null when it cannot - and null
 * is always treated as "still alive" (fail-closed).
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
        // PID not found in the OS process table (e.g. a synthetic PID in a unit test).
        return null;
      }
      const firstLine = text.split(/\r?\n/)[0] || "";
      const match = /^"([^"]+)"/.exec(firstLine);
      if (!match) return null;
      const imageName = match[1].toLowerCase();
      if (imageName !== "node.exe") {
        return false;
      }

      // Verify the command line and the process creation time to detect PID
      // reuse by another Node.js process on Windows.
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
            // If the OS process was born > 2.5 seconds AFTER the lock was written, the PID was reused.
            if (info.start > lockStartedAt + 2500) {
              return false;
            }
          }
          if (info.cmd) {
            return isKnownDevWorkflowCommandLine(info.cmd);
          }
        }
      } catch {
        // Failed to inspect CIM: fail-closed (return null so the lock is not stolen).
        return null;
      }
      return true;
    } catch {
      return null;
    }
  }

  // Linux / POSIX: read /proc/<pid>/cmdline when available, then fall back to ps.
  try {
    if (existsSync(`/proc/${pid}/cmdline`)) {
      const rawCmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+/g, " ").trim();
      if (!rawCmd) return false;
      if (!isKnownDevWorkflowCommandLine(rawCmd)) {
        return false;
      }
    }
  } catch {
    // Continue with ps when /proc cannot be read.
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
 * Publishes a JSON file atomically without a 0-byte file window:
 * write the full contents to a temporary file, then install it with `linkSync` (exclusive)
 * or replace it under the protection of the gate (`replaceIfExists`).
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
        // Under the exclusive gate (`mcp-process.gate.lock`) we are entitled
        // to replace the target file atomically.
        renameSync(tmpFile, targetFile);
        return;
      }
      if (
        linkError &&
        (linkError.code === "ENOSYS" || linkError.code === "EXDEV" || linkError.code === "EPERM")
      ) {
        if (!replaceIfExists) {
          // R3-2: Never fall back to `writeFileSync(..., { flag: "wx" })`
          // on the target, because that opens a partial 0-byte initialization window.
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
        // Possibly a partial initialization by an external writer; wait briefly.
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
 * R3-1: Set of trusted gate recovery capabilities that cannot be forged
 * by an ordinary caller or by an MCP request handler through a boolean flag.
 */
const TRUSTED_GATE_RECOVERY_AUTHORITIES = new WeakSet();

/**
 * Mints the trusted gate recovery authority capability only when the process
 * runs inside an explicit operator maintenance context (`DEVWF_OPERATOR_GATE_RECOVERY=1`).
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
 * Recovers a lock gate abandoned by a dead process in a controlled way and
 * requires a trusted capability (`recoveryAuthority`) plus a token match
 * (`expectedToken`) under the exclusive recovery lock (R2-1 / R3-1).
 *
 * SECURITY RULES (R2-1 / R3-1):
 *   - The boolean flag `authorizeAbandonedGateRecovery: true` is NO longer accepted;
 *     recovery MUST supply `recoveryAuthority` from `mintTrustedGateRecoveryAuthority`.
 *   - When `mcp-process.gate.recover.lock` itself is abandoned by a dead process, this
 *     function fails closed (`recovery_lock_abandoned`) without adding a lock layer.
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

    // Re-verify under `recoverLockFile` right before the unlink.
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
 * Acquires the exclusive gate (`mcp-process.gate.lock`) for one lock directory.
 *
 * SECURITY RULES (R2-1, R2-2, R2-3):
 *   1. Re-entrancy is ONLY allowed inside the same asynchronous execution context
 *      (`gateExecutionStorage` / `AsyncLocalStorage`). Parallel requests in the
 *      same process are NEVER treated as re-entrant.
 *   2. Gate closure (`releaseGateEntry`) runs when the last valid holder
 *      (`entry.count === 0`) leaves, whether that is the outer or a nested
 *      holder, so the gate is never left behind.
 *   3. When the gate is held by a dead process, normal acquisition ALWAYS
 *      fails closed (`LOCK_GATE_ABANDONED`) without renaming the gate file,
 *      so there is never a pathname race that deletes the successor's gate.
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

  // R2-3: When ANOTHER execution context inside the same process is holding
  // the gate for `resolvedDir`, never treat this call as re-entrant
  // and never block the single event loop with a synchronous spin.
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
    // Wait while an authorized gate recovery is in progress on this directory;
    // fail closed when the recovery file turns out to be abandoned by a dead process.
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

      // If `recoverLockFile` appears at the same moment we publish the
      // gate, back off cleanly so recovery and acquisition do not overlap.
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

    // R2-1: When the gate holder is confirmed dead, NEVER rename
    // or delete `gateFile` automatically (fail-closed).
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
 * Runs `fn` (synchronous or asynchronous) inside the exclusive gate of `dir`
 * with `AsyncLocalStorage` execution-context isolation (R2-2 & R2-3).
 */
export function withLockGate(dir, fn, options = {}) {
  const resolvedDir = path.resolve(dir);
  const currentStore = gateExecutionStorage.getStore();
  const contextEntry = currentStore ? currentStore.get(resolvedDir) : null;

  // Nested calls inside the same execution context:
  if (
    contextEntry &&
    contextEntry.active === true &&
    !contextEntry.cleanedUp &&
    contextEntry.pid === (options.pid || process.pid) &&
    contextEntry.incarnationId === PROCESS_INCARNATION_ID
  ) {
    return executeInGateScope(resolvedDir, fn, options, currentStore);
  }

  // R2-3: When another asynchronous operation in the same process is currently
  // holding the gate for `resolvedDir`, queue this independent call
  // asynchronously until the previous holder (and all of its nested calls)
  // has finished releasing the gate.
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
 * Evaluates whether a lock file currently on disk is still owned
 * by a live process.
 *
 * SECURITY RULES (F4 & F8):
 *   - An elapsed heartbeat time (`age > staleMs`) NEVER makes a
 *     still-live process be considered dead.
 *   - A holder is considered dead ONLY when `!alive` or `holderIsOurs === false`.
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
      // The lock points at our own OS PID. When it was written by a PREVIOUS
      // process incarnation (`existing.incarnationId !== PROCESS_INCARNATION_ID`) and
      // is not recorded in this process's `heldLeases` memory, then that old
      // incarnation died before the OS handed this PID to us — UNLESS
      // an explicit holder check (`isHolderProcess !== defaultIsHolderProcess`)
      // states that the holder is still alive.
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
 * Tries to become the lock holder atomically under the exclusive gate
 * with an ownership token (`leaseId`) and an incarnation identity (`incarnationId`).
 *
 * Returns:
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

  // Writer injection path used only by unit tests for write failures (e.g. EACCES).
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

  // Step 1: Initial observation (tolerating partial initialization) to
  // support deterministic hooks before entering the commit gate.
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

  // Step 2: Enter the exclusive gate (`mcp-process.gate.lock`).
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

      // Re-entry is ONLY allowed when the caller holds a matching `leaseId`
      // capability (or the file is a v1 lock without a leaseId owned by this PID & incarnation).
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

        // When the holder process is still alive (`!liveness.isConfirmedDead`):
        //   1. A live legacy v1 lock MUST NOT be taken over, even with `force: true`.
        //   2. Without `force: true`, a lock owned by a live process is NEVER taken over
        //      (even when its heartbeat is old / `staleHeartbeat === true`).
        //   3. A matching PID without a matching `leaseId` (`existing.pid === pid`)
        //      is still rejected (`lease_mismatch`) when its incarnation is not proven dead.
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
 * Releases the lock only when it really belongs to our process AND to our lease capability (F3 & F8).
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

  // When the on-disk lock carries a leaseId, the caller MUST present a matching leaseId.
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
 * Releases the active lock held by this process on exit (exit handler).
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
 * Detects the presence of live legacy writers (v1 without `leaseId` / `protocolVersion: 2`)
 * in the source directory, the target directory, every project bucket
 * in the same state tree (even when the session pointer is missing or stale), or
 * the active state file owned by the target project (R2-5).
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

  // R2-5 + R3-6: Scan EVERY bucket in `<base>/projects/*`; when reading a
  // directory fails (e.g. EACCES/EPERM), fail closed (`legacy_inspection_failed`).
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

  // Also check whether an active state file in `toDir` was written by a
  // live process without a v2 protocol lease in `toDir` (e.g. a legacy writer whose
  // startup lock file lives outside the `<base>/projects` tree).
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

        // When this active state owner holds a valid v2 lock in `resolvedTo`,
        // then it is not a legacy writer (handled by the usual `foreign_lock` check).
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
 * Verifies fleet quiescence before or after activation of
 * Protocol v2 (R2-5): it ensures no live legacy v1 process exists, there is no
 * abandoned gate (`LOCK_GATE_ABANDONED`), and no transition journal is
 * pending on `<baseDir>`.
 */
const ADMISSION_BARRIER_FILENAME = "maintenance-admission.json";

export function admissionBarrierPath(baseDir) {
  return path.join(path.resolve(baseDir), ADMISSION_BARRIER_FILENAME);
}

/**
 * Publishes the maintenance admission barrier
 * at `<baseDir>/maintenance-admission.json` to hold back new launches/activity
 * during the v1 -> v2 fleet transition (R3-6).
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
 * Verifies fleet quiescence fail-closed before or after activation of
 * Protocol v2 (R2-5 + R3-6): it ensures no live legacy v1 process exists, no
 * abandoned gate/recovery lock exists, no transition journal is pending, and
 * NO directory or file failed to be read.
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
 * Stage 1 of the Two-Phase Lock Transition (F7):
 *   1. Refuse when a live legacy writer (v1) exists on the transition path.
 *   2. Acquire the lock in `toDir` atomically WITHOUT releasing `fromDir` first.
 *   3. Return a `staged` object that can be passed to `commitProcessLockTransition`
 *      after the state is saved, or to `rollbackProcessLockTransition` on failure.
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

  // R3-6: Respect the maintenance admission barrier on the state root when it is active.
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

  // Check for incompatible legacy writers (F4).
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
      // F8: Never adopt another process/incarnation's lease just because the PID matches.
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
    // Do not make it primary before the commit succeeds, so a failure in the middle
    // of the transition keeps the original binding.
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
 * Stage 2 (Commit) of the Two-Phase Lock Transition (F7):
 * Binds the primary heartbeat to `staged.dir` and releases `staged.fromDir`
 * ONLY after all state and project metadata changes were saved successfully.
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
 * Alternative Stage 2 (Rollback) of the Two-Phase Lock Transition (F7):
 * Releases the newly acquired `staged.dir` lock and restores the heartbeat
 * binding to `staged.previousLease`.
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
 * One-step wrapper for an immediate lock relocation (API compatibility).
 */
export function relocateProcessLock(options = {}) {
  const staged = stageProcessLockTransition(options);
  if (!staged.ok) {
    return staged;
  }
  return commitProcessLockTransition(staged);
}

/**
 * Verifies under the exclusive gate that this process still holds legitimate
 * ownership of the project (`dir` or `projectLockDir(stateFile)`).
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

  // This process holds no `effectiveExpectedLease` for `lockDir`.
  // When a lock exists on disk:
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

  // `diskLock.pid === pid`, but this process/instance does NOT hold `diskLock.leaseId`!
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
 * Message recorded when another process already holds the lock, or null when
 * there is nothing to report.
 */
export function lockWarning(result) {
  if (!result) return null;

  if (result.wrote === false) {
    return (
      `Cannot write the process marker to ${LOCK_FILENAME} (${result.error}). ` +
      "Duplicate MCP process detection will not work until this is fixed."
    );
  }

  if (result.acquired !== false || !result.holder) return null;

  const started = Number.isFinite(result.holder.startedAt)
    ? new Date(result.holder.startedAt).toISOString()
    : "time unknown";

  return (
    `Another dev-workflow MCP process (PID ${result.holder.pid}, alive since ${started}) ` +
    "is still running and uses the same state directory. " +
    "The older process holds the environment it was started with, so Factory credentials " +
    "and workflow state can differ between processes. Close OpenCode and open it again to " +
    "make sure only one process is alive."
  );
}

/**
 * Refreshes our own marker under the exclusive gate with
 * `leaseId` capability verification (F1 & F8).
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
 * Another lock holder that is still alive, or null.
 *
 * SECURITY RULES (F4 & F8):
 *   - When the holder process is still alive (`!liveness.isConfirmedDead`), this function
 *     ALWAYS returns that holder (with `staleHeartbeat: true/false`
 *     and `legacy: true/false`) — an elapsed heartbeat NEVER makes a
 *     live process be ignored.
 *   - When `lock.pid === pid` but `lock.leaseId` differs from the lease held by
 *     this process (and its incarnation is not proven dead), that lock is
 *     also reported as a foreign lock (`leaseMismatch: true`).
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

/** Remembers the lock directory so the heartbeat needs no argument. */
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
