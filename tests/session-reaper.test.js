import test from "node:test";
import assert from "node:assert/strict";

import {
  SESSION_STATES,
  applyCleanup,
  classifySession,
  createMachineController,
  planCleanup,
  reconcileSessions,
  signControllerRequest,
  verifyControllerRequest,
  verifyProcessIdentity,
} from "../session-reaper.js";

const NOW = 1_800_000_000_000;

function session(overrides = {}) {
  return {
    session_key: "ses_test",
    machine: "HELLOWORLD",
    project_name: "demo",
    phase: "coding",
    state: "live",
    updated_at: NOW - 60_000,
    owner: { pid: 100, startedAt: "2026-11-15T08:00:00Z", executable: "node" },
    ...overrides,
  };
}

const alive = () => true;
const dead = () => false;
const info = (pid) => ({ pid, startedAt: "2026-11-15T08:00:00Z", executable: "node" });

test("dead process with orphaned lease is ORPHANED and planned for recovery", () => {
  const s = session();
  const c = classifySession(s, { now: NOW, isAlive: dead, processInfo: info });
  assert.equal(c.state, SESSION_STATES.ORPHANED);
  const plan = planCleanup(s, { now: NOW, isAlive: dead, processInfo: info });
  assert.equal(plan.action, "recover_orphan");
  assert.equal(plan.releaseLease, true);
  assert.equal(plan.archive, true);
  assert.equal(plan.kill, false);
});

test("live process with stale heartbeat is SUSPECTED_STALE, not killed", () => {
  const s = session({ updated_at: NOW - 20 * 60_000 });
  const c = classifySession(s, { now: NOW, isAlive: alive, processInfo: info });
  assert.equal(c.state, SESSION_STATES.SUSPECTED_STALE);
  const plan = planCleanup(s, { now: NOW, isAlive: alive, processInfo: info });
  assert.equal(plan.action, "verify");
  assert.equal(plan.kill, false);
});

test("long-running model invocation with a recent heartbeat stays ACTIVE", () => {
  const s = session({ updated_at: NOW - 30_000 });
  const c = classifySession(s, { now: NOW, isAlive: alive, processInfo: info });
  assert.equal(c.state, SESSION_STATES.ACTIVE);
});

test("idle process with uncommitted work stays ACTIVE", () => {
  const s = session({ updated_at: NOW - 60 * 60_000 });
  const c = classifySession(s, { now: NOW, isAlive: alive, processInfo: info, hasUncommittedWork: true });
  assert.equal(c.state, SESSION_STATES.ACTIVE);
});

test("active child process keeps the session ACTIVE", () => {
  const s = session({ updated_at: NOW - 60 * 60_000 });
  const c = classifySession(s, { now: NOW, isAlive: alive, processInfo: info, hasActiveChild: true });
  assert.equal(c.state, SESSION_STATES.ACTIVE);
});

test("PID reuse is RECOVERY_REQUIRED", () => {
  const s = session();
  const reused = (pid) => ({ pid, startedAt: "2026-11-15T09:00:00Z", executable: "node" });
  const c = classifySession(s, { now: NOW, isAlive: alive, processInfo: reused });
  assert.equal(c.state, SESSION_STATES.RECOVERY_REQUIRED);
  const plan = planCleanup(s, { now: NOW, isAlive: alive, processInfo: reused });
  assert.equal(plan.action, "hold");
  assert.equal(plan.requiresAuthorization, true);
});

test("two sessions sharing a project are classified independently", () => {
  const a = session({ session_key: "ses_a", owner: { pid: 1, startedAt: "x", executable: "node" } });
  const b = session({ session_key: "ses_b", owner: { pid: 2, startedAt: "x", executable: "node" } });
  const sameInfo = (pid) => ({ pid, startedAt: "x", executable: "node" });
  const ca = classifySession(a, { now: NOW, isAlive: (pid) => pid === 1, processInfo: sameInfo });
  const cb = classifySession(b, { now: NOW, isAlive: (pid) => pid === 1, processInfo: sameInfo });
  assert.equal(ca.state, SESSION_STATES.ACTIVE);
  assert.equal(cb.state, SESSION_STATES.ORPHANED);
});

test("machine offline is UNREACHABLE, never TERMINATED", () => {
  const s = session();
  const c = classifySession(s, { now: NOW, machineOnline: false, isAlive: dead, processInfo: info });
  assert.equal(c.state, SESSION_STATES.UNREACHABLE);
  const plan = planCleanup(s, { now: NOW, machineOnline: false, isAlive: dead, processInfo: info });
  assert.equal(plan.action, "hold");
  assert.equal(plan.kill, false);
});

test("machine reconnect resumes normal classification", () => {
  const s = session();
  const offline = classifySession(s, { now: NOW, machineOnline: false, isAlive: alive, processInfo: info });
  const online = classifySession(s, { now: NOW, machineOnline: true, isAlive: alive, processInfo: info });
  assert.equal(offline.state, SESSION_STATES.UNREACHABLE);
  assert.equal(online.state, SESSION_STATES.ACTIVE);
});

test("lease owner change during cleanup aborts without archiving", async () => {
  const plan = {
    sessionKey: "ses_test",
    action: "recover_orphan",
    releaseLease: true,
    archive: true,
    leaseOwner: "old",
    leaseGeneration: 1,
    leaseFencingToken: "f1",
  };
  let archived = false;
  const result = await applyCleanup(plan, {
    releaseLease: async () => ({ ok: false, reason: "owner changed" }),
    archiveSession: async () => { archived = true; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "LEASE_OWNERSHIP_CHANGED");
  assert.equal(archived, false);
});

test("concurrent reaper executions are idempotent", async () => {
  const plan = {
    sessionKey: "ses_test",
    action: "recover_orphan",
    releaseLease: true,
    archive: true,
    leaseOwner: "owner",
    leaseGeneration: 1,
    leaseFencingToken: "f1",
  };
  let releases = 0;
  const adapters = {
    releaseLease: async () => { releases += 1; return { ok: true }; },
    archiveSession: async () => {},
  };
  const [a, b] = await Promise.all([applyCleanup(plan, adapters), applyCleanup(plan, adapters)]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(releases, 2, "each call performs its own compare-and-swap; the adapter decides idempotency");
});

test("release lock held by a production deployment keeps the session ACTIVE", () => {
  const s = session({ updated_at: NOW - 60 * 60_000 });
  const c = classifySession(s, { now: NOW, isAlive: alive, processInfo: info, hasReleaseLock: true });
  assert.equal(c.state, SESSION_STATES.ACTIVE);
});

test("crash during graceful stop does not archive", async () => {
  const plan = {
    sessionKey: "ses_test",
    action: "graceful_stop",
    releaseLease: true,
    archive: true,
    leaseOwner: "owner",
    leaseGeneration: 1,
    leaseFencingToken: "f1",
  };
  let archived = false;
  const result = await applyCleanup(plan, {
    requestStop: async () => {},
    waitForExit: async () => false,
    releaseLease: async () => ({ ok: true }),
    archiveSession: async () => { archived = true; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PROCESS_DID_NOT_EXIT");
  assert.equal(archived, false);
});

test("unauthorized cleanup request is held for authorization", () => {
  const s = session();
  const plan = planCleanup(s, {
    now: NOW,
    isAlive: alive,
    processInfo: (pid) => ({ pid, startedAt: "different", executable: "node" }),
  });
  assert.equal(plan.action, "hold");
  assert.equal(plan.requiresAuthorization, true);
});

test("proc- versus ses- identity mismatch is RECOVERY_REQUIRED", () => {
  const s = session({ session_key: "proc-123", owner: { pid: 100, startedAt: "x", executable: "node" } });
  const c = classifySession(s, {
    now: NOW,
    isAlive: alive,
    processInfo: (pid) => ({ pid, startedAt: "x", executable: "python" }),
  });
  assert.equal(c.state, SESSION_STATES.RECOVERY_REQUIRED);
});

test("an archived session stays ARCHIVED", () => {
  const s = session({ phase: "closed" });
  const c = classifySession(s, { now: NOW, isAlive: alive, processInfo: info });
  assert.equal(c.state, SESSION_STATES.ARCHIVED);
});

test("restart recovery re-plans the same orphan without mutating", () => {
  const s = session();
  const first = planCleanup(s, { now: NOW, isAlive: dead, processInfo: info });
  const second = planCleanup(s, { now: NOW + 1000, isAlive: dead, processInfo: info });
  assert.equal(first.action, second.action);
  assert.equal(first.sessionKey, second.sessionKey);
});

test("Windows and macOS graceful stop use the same verified plan", async () => {
  for (const machine of ["MMCH", "Mac"]) {
    const s = session({ machine, updated_at: NOW - 60 * 60_000 });
    const plan = planCleanup(s, { now: NOW, isAlive: alive, processInfo: info, autoDisposable: true });
    assert.equal(plan.action, "graceful_stop");
    let stopped = false;
    const result = await applyCleanup(plan, {
      requestStop: async () => { stopped = true; },
      waitForExit: async () => true,
      releaseLease: async () => ({ ok: true }),
      archiveSession: async () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(stopped, true);
  }
});

test("cleanup never deletes the canonical checkpoint", async () => {
  const plan = {
    sessionKey: "ses_test",
    action: "recover_orphan",
    releaseLease: true,
    archive: true,
    leaseOwner: "owner",
    leaseGeneration: 1,
    leaseFencingToken: "f1",
  };
  const calls = [];
  await applyCleanup(plan, {
    releaseLease: async () => { calls.push("release"); return { ok: true }; },
    archiveSession: async () => { calls.push("archive"); },
  });
  assert.deepEqual(calls, ["release", "archive"]);
  assert.equal(calls.includes("deleteState"), false);
});

test("reconcileSessions returns one plan per session", () => {
  const sessions = [
    session({ session_key: "ses_a" }),
    session({ session_key: "ses_b", updated_at: NOW - 20 * 60_000 }),
  ];
  const plans = reconcileSessions(sessions, { now: NOW, isAlive: alive, processInfo: info });
  assert.equal(plans.length, 2);
  assert.equal(plans[0].sessionKey, "ses_a");
  assert.equal(plans[1].sessionKey, "ses_b");
});

test("machine controller refuses a session from another machine", async () => {
  const controller = createMachineController({ machine: "MMCH", adapters: { isAlive: alive, processInfo: info } });
  const result = await controller.verify(session({ machine: "HELLOWORLD" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REMOTE_SESSION_REFUSED");
});

test("machine controller verifies a local session", async () => {
  const controller = createMachineController({ machine: "HELLOWORLD", adapters: { isAlive: alive, processInfo: info } });
  const result = await controller.verify(session({ machine: "HELLOWORLD" }));
  assert.equal(result.ok, true);
  assert.equal(controller.audit.length, 1);
});

test("machine controller requests stop and confirms exit", async () => {
  let stopped = false;
  const controller = createMachineController({
    machine: "Mac",
    adapters: {
      isAlive: alive,
      processInfo: info,
      requestStop: async () => { stopped = true; return { ok: true }; },
      waitForExit: async () => ({ ok: true }),
    },
  });
  const s = session({ machine: "Mac" });
  assert.equal((await controller.requestStop(s)).ok, true);
  assert.equal((await controller.waitForExit(s)).ok, true);
  assert.equal(stopped, true);
});

test("machine controller reconciles an orphan lease with the expected fencing token", async () => {
  let received = null;
  const controller = createMachineController({
    machine: "MMCH",
    adapters: {
      isAlive: dead,
      processInfo: info,
      releaseLease: async (key, expected) => { received = { key, expected }; return { ok: true }; },
    },
  });
  const s = session({ machine: "MMCH" });
  const result = await controller.reconcileOrphanLease(s, { owner: "o1", generation: 3, fencingToken: "f3" });
  assert.equal(result.ok, true);
  assert.deepEqual(received, { key: "ses_test", expected: { expectedOwner: "o1", expectedGeneration: 3, expectedFencingToken: "f3" } });
});

test("controller request signatures are verified and tampering is rejected", () => {
  const payload = { machine: "MMCH", sessionKey: "ses_test", action: "verify" };
  const signature = signControllerRequest(payload, "secret");
  assert.equal(verifyControllerRequest({ payload, signature }, "secret"), true);
  assert.equal(verifyControllerRequest({ payload: { ...payload, action: "stop" }, signature }, "secret"), false);
  assert.equal(verifyControllerRequest({ payload, signature }, "other-secret"), false);
});
