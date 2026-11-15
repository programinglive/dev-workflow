/**
 * Safe lifecycle manager for DevWorkflow sessions.
 *
 * WHY THIS EXISTS
 * ---------------
 * The monitor used a single "possibly_stuck" label for every session whose
 * heartbeat was old. That label cannot distinguish a long model call from a
 * dead process, a disconnected machine from a terminated one, or a duplicate
 * `proc-` card from the real `ses-` session. This module replaces the label
 * with a verified state machine and a cleanup plan that never kills a process
 * on the strength of a timestamp alone.
 *
 * SAFETY RULES
 * ------------
 * - A PID is not proof of ownership. The caller must supply process creation
 *   time and executable identity; a mismatch is RECOVERY_REQUIRED.
 * - A disconnected machine is UNREACHABLE, never TERMINATED.
 * - A release lock, an active child, or uncommitted work keeps a session
 *   ACTIVE even when its heartbeat is old.
 * - Lease release is compare-and-swap on owner + generation + fencing token.
 * - Every action is a plan first; applying it is a separate, auditable step.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_STATES = Object.freeze({
  ACTIVE: "ACTIVE",
  IDLE: "IDLE",
  SUSPECTED_STALE: "SUSPECTED_STALE",
  UNREACHABLE: "UNREACHABLE",
  TERMINATED: "TERMINATED",
  ORPHANED: "ORPHANED",
  RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
  ARCHIVED: "ARCHIVED",
});

export const DEFAULT_STALE_MS = 10 * 60 * 1000;
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

function ageMs(timestamp, now) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, now - value);
}

/**
 * Verify that the recorded owner still refers to the same process.
 *
 * @returns {{ok: boolean, code?: string, reason?: string}}
 */
export function verifyProcessIdentity(session, { isAlive, processInfo } = {}) {
  const owner = session?.owner;
  if (!owner || !Number.isFinite(Number(owner.pid))) {
    return { ok: false, code: "OWNER_MISSING", reason: "session has no recorded owner PID" };
  }

  const pid = Number(owner.pid);
  if (typeof isAlive === "function" && !isAlive(pid)) {
    return { ok: false, code: "PROCESS_ABSENT", reason: `PID ${pid} is not running` };
  }

  if (typeof processInfo === "function") {
    const info = processInfo(pid);
    if (!info) {
      return { ok: false, code: "PROCESS_UNVERIFIABLE", reason: `PID ${pid} could not be inspected` };
    }
    if (owner.startedAt && info.startedAt && String(owner.startedAt) !== String(info.startedAt)) {
      return { ok: false, code: "PID_REUSED", reason: `PID ${pid} was reused by another process` };
    }
    if (owner.executable && info.executable && String(owner.executable) !== String(info.executable)) {
      return { ok: false, code: "EXECUTABLE_MISMATCH", reason: `PID ${pid} executable changed` };
    }
  }

  return { ok: true };
}

/**
 * Classify a session into the verified state machine.
 *
 * @param {object} session monitor session record
 * @param {object} context
 * @param {number} [context.now]
 * @param {boolean} [context.machineOnline]
 * @param {(pid:number)=>boolean} [context.isAlive]
 * @param {(pid:number)=>object|null} [context.processInfo]
 * @param {boolean} [context.hasActiveChild]
 * @param {boolean} [context.hasUncommittedWork]
 * @param {boolean} [context.hasReleaseLock]
 * @param {boolean} [context.autoDisposable]
 * @param {number} [context.staleMs]
 * @param {number} [context.idleMs]
 */
export function classifySession(session, context = {}) {
  const now = Number(context.now) || Date.now();
  const staleMs = Number(context.staleMs) || DEFAULT_STALE_MS;
  const idleMs = Number(context.idleMs) || DEFAULT_IDLE_MS;

  if (session?.phase === "closed" || session?.state === "archived") {
    return { state: SESSION_STATES.ARCHIVED, reason: "session is already closed" };
  }

  if (context.machineOnline === false) {
    return { state: SESSION_STATES.UNREACHABLE, reason: "machine is offline; process state is unknown" };
  }

  const identity = verifyProcessIdentity(session, context);
  if (!identity.ok) {
    if (identity.code === "PROCESS_ABSENT") {
      return { state: SESSION_STATES.ORPHANED, reason: identity.reason };
    }
    return { state: SESSION_STATES.RECOVERY_REQUIRED, reason: identity.reason };
  }

  if (context.hasReleaseLock) {
    return { state: SESSION_STATES.ACTIVE, reason: "session holds a production release lock" };
  }
  if (context.hasActiveChild) {
    return { state: SESSION_STATES.ACTIVE, reason: "session has an active child process" };
  }
  if (context.hasUncommittedWork) {
    return { state: SESSION_STATES.ACTIVE, reason: "session has uncommitted work" };
  }

  const heartbeatAge = ageMs(session?.updated_at, now);
  if (heartbeatAge !== null && heartbeatAge > idleMs) {
    return { state: SESSION_STATES.IDLE, reason: "process is alive and idle" };
  }

  if (heartbeatAge !== null && heartbeatAge > staleMs) {
    return { state: SESSION_STATES.SUSPECTED_STALE, reason: `heartbeat is ${Math.round(heartbeatAge / 1000)}s old` };
  }

  return { state: SESSION_STATES.ACTIVE, reason: "process is alive and reporting" };
}

/**
 * Build a cleanup plan. This never mutates anything.
 */
export function planCleanup(session, context = {}) {
  const classification = classifySession(session, context);
  const base = {
    sessionKey: session?.session_key || "",
    machine: session?.machine || "",
    project: session?.project_name || "",
    state: classification.state,
    reason: classification.reason,
    kill: false,
    releaseLease: false,
    archive: false,
    requiresAuthorization: false,
  };

  switch (classification.state) {
    case SESSION_STATES.ORPHANED:
      return { ...base, action: "recover_orphan", releaseLease: true, archive: true };
    case SESSION_STATES.IDLE:
      if (context.autoDisposable === true) {
        return { ...base, action: "graceful_stop", releaseLease: true, archive: true };
      }
      return { ...base, action: "none", reason: "idle but not designated auto-disposable" };
    case SESSION_STATES.SUSPECTED_STALE:
      return { ...base, action: "verify", reason: "heartbeat overdue; verify process before any action" };
    case SESSION_STATES.UNREACHABLE:
      return { ...base, action: "hold", reason: "machine offline; reconcile when it returns" };
    case SESSION_STATES.RECOVERY_REQUIRED:
      return { ...base, action: "hold", requiresAuthorization: true, reason: classification.reason };
    case SESSION_STATES.ACTIVE:
      return { ...base, action: "none", reason: "session is active" };
    case SESSION_STATES.ARCHIVED:
      return { ...base, action: "none", reason: "already archived" };
    default:
      return { ...base, action: "hold", requiresAuthorization: true };
  }
}

/**
 * Apply a cleanup plan through injected adapters.
 *
 * The lease release is compare-and-swap: the adapter must reject when the
 * current owner, generation or fencing token no longer match. If ownership
 * changes during cleanup, the plan aborts without archiving.
 */
export async function applyCleanup(plan, adapters = {}) {
  const audit = [];
  const record = (event) => audit.push({ at: new Date().toISOString(), ...event });

  if (!plan || plan.action === "none" || plan.action === "verify" || plan.action === "hold") {
    record({ action: plan?.action || "none", result: "no_mutation" });
    return { ok: true, mutated: false, audit };
  }

  if (plan.action === "recover_orphan") {
    if (typeof adapters.releaseLease !== "function") {
      record({ action: "recover_orphan", result: "blocked", reason: "no lease adapter" });
      return { ok: false, mutated: false, audit, reason: "LEASE_ADAPTER_MISSING" };
    }
    const released = await adapters.releaseLease(plan.sessionKey, {
      expectedOwner: plan.leaseOwner,
      expectedGeneration: plan.leaseGeneration,
      expectedFencingToken: plan.leaseFencingToken,
    });
    if (!released?.ok) {
      record({ action: "recover_orphan", result: "aborted", reason: released?.reason || "lease changed" });
      return { ok: false, mutated: false, audit, reason: "LEASE_OWNERSHIP_CHANGED" };
    }
    record({ action: "release_lease", result: "ok" });
    if (plan.archive && typeof adapters.archiveSession === "function") {
      await adapters.archiveSession(plan.sessionKey);
      record({ action: "archive", result: "ok" });
    }
    return { ok: true, mutated: true, audit };
  }

  if (plan.action === "graceful_stop") {
    if (typeof adapters.requestStop !== "function" || typeof adapters.waitForExit !== "function") {
      record({ action: "graceful_stop", result: "blocked", reason: "no process adapter" });
      return { ok: false, mutated: false, audit, reason: "PROCESS_ADAPTER_MISSING" };
    }
    await adapters.requestStop(plan.sessionKey);
    const exited = await adapters.waitForExit(plan.sessionKey);
    if (!exited) {
      record({ action: "graceful_stop", result: "timeout" });
      return { ok: false, mutated: false, audit, reason: "PROCESS_DID_NOT_EXIT" };
    }
    record({ action: "graceful_stop", result: "exited" });
    if (typeof adapters.releaseLease === "function") {
      const released = await adapters.releaseLease(plan.sessionKey, {
        expectedOwner: plan.leaseOwner,
        expectedGeneration: plan.leaseGeneration,
        expectedFencingToken: plan.leaseFencingToken,
      });
      if (!released?.ok) {
        record({ action: "release_lease", result: "aborted", reason: released?.reason || "lease changed" });
        return { ok: false, mutated: true, audit, reason: "LEASE_OWNERSHIP_CHANGED" };
      }
      record({ action: "release_lease", result: "ok" });
    }
    if (plan.archive && typeof adapters.archiveSession === "function") {
      await adapters.archiveSession(plan.sessionKey);
      record({ action: "archive", result: "ok" });
    }
    return { ok: true, mutated: true, audit };
  }

  record({ action: plan.action, result: "unsupported" });
  return { ok: false, mutated: false, audit, reason: "UNSUPPORTED_ACTION" };
}

/**
 * Classify every session and return a plan for each. Read-only.
 */
export function reconcileSessions(sessions, context = {}) {
  return (sessions || []).map((session) => planCleanup(session, context));
}

/**
 * Restricted machine-local controller.
 *
 * The controller only ever acts on sessions whose `machine` matches its own.
 * It never receives a bare PID from a remote caller: the caller passes a
 * session record, and the controller re-verifies identity locally before any
 * stop or lease release.
 */
export function createMachineController({ machine, adapters = {} } = {}) {
  if (!machine) throw new Error("machine is required");
  const audit = [];
  const record = (event) => audit.push({ at: new Date().toISOString(), machine, ...event });

  function assertLocal(session) {
    if (String(session?.machine || "") !== String(machine)) {
      return { ok: false, reason: "REMOTE_SESSION_REFUSED" };
    }
    return { ok: true };
  }

  return {
    machine,
    audit,
    async verify(session) {
      const local = assertLocal(session);
      if (!local.ok) return local;
      const identity = verifyProcessIdentity(session, adapters);
      record({ action: "verify", sessionKey: session?.session_key, ok: identity.ok, code: identity.code });
      return identity;
    },
    /**
     * Stop a session's owner process.
     *
     * Three guards run before the OS is touched, because a bare PID is not
     * proof of ownership and a shared client process hosts several projects:
     *  1. the session must belong to this machine;
     *  2. the recorded owner must still be the same process (PID + creation
     *     time + executable), so a reused PID is never signalled;
     *  3. the PID must not be shared with another live session, so stopping one
     *     project cannot kill an unrelated one.
     */
    async requestStop(session, { sharedPids = [] } = {}) {
      const local = assertLocal(session);
      if (!local.ok) return local;
      if (typeof adapters.requestStop !== "function") return { ok: false, reason: "NO_STOP_ADAPTER" };

      const identity = verifyProcessIdentity(session, adapters);
      if (!identity.ok) {
        record({ action: "request_stop", sessionKey: session?.session_key, ok: false, code: identity.code });
        return { ok: false, reason: identity.code, detail: identity.reason };
      }

      const pid = Number(session.owner.pid);
      const shared = (sharedPids || []).map(Number).filter((value) => Number.isFinite(value));
      if (shared.includes(pid)) {
        record({ action: "request_stop", sessionKey: session?.session_key, ok: false, code: "SHARED_PROCESS_REFUSED" });
        return { ok: false, reason: "SHARED_PROCESS_REFUSED", detail: `PID ${pid} hosts more than one session` };
      }

      const result = await adapters.requestStop(pid);
      record({ action: "request_stop", sessionKey: session?.session_key, pid, ok: result?.ok !== false });
      return result;
    },
    async waitForExit(session, { attempts = 10, delayMs = 500 } = {}) {
      const local = assertLocal(session);
      if (!local.ok) return local;
      if (typeof adapters.waitForExit !== "function") return { ok: false, reason: "NO_WAIT_ADAPTER" };
      const pid = Number(session?.owner?.pid);
      if (!Number.isFinite(pid)) return { ok: false, reason: "OWNER_MISSING" };
      const result = await adapters.waitForExit(pid, { attempts, delayMs });
      record({ action: "wait_for_exit", sessionKey: session?.session_key, pid, ok: result?.ok === true });
      return result;
    },
    async reconcileOrphanLease(session, lease) {
      const local = assertLocal(session);
      if (!local.ok) return local;
      if (typeof adapters.releaseLease !== "function") return { ok: false, reason: "NO_LEASE_ADAPTER" };
      const result = await adapters.releaseLease(session.session_key, {
        expectedOwner: lease?.owner,
        expectedGeneration: lease?.generation,
        expectedFencingToken: lease?.fencingToken,
      });
      record({ action: "reconcile_orphan_lease", sessionKey: session?.session_key, ok: result?.ok === true });
      return result;
    },
  };
}

/** HMAC signature for a controller request payload. */
export function signControllerRequest(payload, secret) {
  return createHmac("sha256", String(secret)).update(JSON.stringify(payload)).digest("hex");
}

/** Constant-time verification of a controller request signature. */
export function verifyControllerRequest(request, secret) {
  const expected = signControllerRequest(request?.payload, secret);
  const provided = String(request?.signature || "");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}
