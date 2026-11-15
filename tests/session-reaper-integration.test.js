import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { createLocalAdapters } from "../session-controller-adapters.js";
import {
  SESSION_STATES,
  applyCleanup,
  classifySession,
  createMachineController,
  planCleanup,
  reconcileSessions,
} from "../session-reaper.js";

/**
 * End-to-end reconciliation against real, isolated fixture processes.
 *
 * Every fixture is a private `node -e` child of this test process. Nothing here
 * touches a live agent session, a shared IDE, or a terminal: the point of these
 * tests is to prove the reaper can tell its own fixture apart from an unrelated
 * process, and that a stop request can never reach the wrong one.
 */

const adapters = createLocalAdapters();
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

const fixtures = new Set();

function spawnFixture() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  fixtures.add(child);
  child.on("exit", () => fixtures.delete(child));
  return child;
}

async function waitForIdentity(pid, { attempts = 40, delayMs = 100 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const info = adapters.processInfo(pid);
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function waitForExit(pid, { attempts = 40, delayMs = 100 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (!adapters.isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function forceCleanup(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

test.after(() => {
  for (const child of fixtures) forceCleanup(child);
});

function sessionFor(pid, info, overrides = {}) {
  return {
    session_key: `ses_fixture_${pid}`,
    machine: "TESTHOST",
    project_name: "fixture",
    phase: "coding",
    updated_at: new Date().toISOString(),
    owner: { pid, startedAt: info.startedAt, executable: info.executable },
    ...overrides,
  };
}

test("a real running fixture is ACTIVE and never planned for a stop", async () => {
  const child = spawnFixture();
  const info = await waitForIdentity(child.pid);
  assert.ok(info, "the fixture process must be inspectable");

  const session = sessionFor(child.pid, info);
  const classification = classifySession(session, { ...adapters, now: Date.now() });
  assert.equal(classification.state, SESSION_STATES.ACTIVE);

  const plan = planCleanup(session, { ...adapters, now: Date.now() });
  assert.equal(plan.action, "none");
  assert.equal(plan.kill, false);
  assert.equal(plan.releaseLease, false);
});

test("a real exited fixture is ORPHANED and planned for lease recovery", async () => {
  const child = spawnFixture();
  const info = await waitForIdentity(child.pid);
  assert.ok(info);

  const session = sessionFor(child.pid, info);
  forceCleanup(child);
  assert.equal(await waitForExit(child.pid), true, "the fixture must actually exit");

  const classification = classifySession(session, { ...adapters, now: Date.now() });
  assert.equal(classification.state, SESSION_STATES.ORPHANED);

  const plan = planCleanup(session, { ...adapters, now: Date.now() });
  assert.equal(plan.action, "recover_orphan");
  assert.equal(plan.releaseLease, true);
  assert.equal(plan.archive, true);
  assert.equal(plan.kill, false, "an orphan is recovered, never killed");
});

test("a reused PID is RECOVERY_REQUIRED, not ORPHANED", async () => {
  const child = spawnFixture();
  const info = await waitForIdentity(child.pid);
  assert.ok(info);

  // Same PID, different creation time: the recorded owner is gone and the PID
  // now belongs to someone else.
  const session = sessionFor(child.pid, { ...info, startedAt: "1999-01-01T00:00:00Z" });
  const classification = classifySession(session, { ...adapters, now: Date.now() });
  assert.equal(classification.state, SESSION_STATES.RECOVERY_REQUIRED);

  const plan = planCleanup(session, { ...adapters, now: Date.now() });
  assert.equal(plan.action, "hold");
  assert.equal(plan.requiresAuthorization, true);
  assert.equal(plan.kill, false);
});

test("a legacy session without owner metadata is RECOVERY_REQUIRED", () => {
  const session = {
    session_key: "ses_legacy",
    machine: "TESTHOST",
    project_name: "fixture",
    phase: "coding",
    updated_at: new Date().toISOString(),
    owner: null,
  };
  const classification = classifySession(session, { ...adapters, now: Date.now() });
  assert.equal(classification.state, SESSION_STATES.RECOVERY_REQUIRED);
  assert.equal(planCleanup(session, { ...adapters, now: Date.now() }).action, "hold");
});

test("an offline machine is UNREACHABLE and held, never terminated", async () => {
  const child = spawnFixture();
  const info = await waitForIdentity(child.pid);
  assert.ok(info);

  const session = sessionFor(child.pid, info);
  const classification = classifySession(session, { ...adapters, now: Date.now(), machineOnline: false });
  assert.equal(classification.state, SESSION_STATES.UNREACHABLE);
  assert.equal(planCleanup(session, { ...adapters, now: Date.now(), machineOnline: false }).action, "hold");
});

test("the controller refuses a shared PID and leaves both fixtures alive", async () => {
  const shared = spawnFixture();
  const info = await waitForIdentity(shared.pid);
  assert.ok(info);

  const controller = createMachineController({ machine: "TESTHOST", adapters });
  const session = sessionFor(shared.pid, info);

  const result = await controller.requestStop(session, { sharedPids: [shared.pid] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SHARED_PROCESS_REFUSED");
  assert.equal(adapters.isAlive(shared.pid), true, "a shared client process must survive");
});

test("the controller refuses a stop when the recorded identity no longer matches", async () => {
  const child = spawnFixture();
  const info = await waitForIdentity(child.pid);
  assert.ok(info);

  const controller = createMachineController({ machine: "TESTHOST", adapters });
  const session = sessionFor(child.pid, { ...info, startedAt: "1999-01-01T00:00:00Z" });

  const result = await controller.requestStop(session);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PID_REUSED");
  assert.equal(adapters.isAlive(child.pid), true, "an unrelated process must survive");
});

test("the controller refuses a session from another machine", async () => {
  const child = spawnFixture();
  const info = await waitForIdentity(child.pid);
  assert.ok(info);

  const controller = createMachineController({ machine: "OTHERHOST", adapters });
  const result = await controller.requestStop(sessionFor(child.pid, info));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REMOTE_SESSION_REFUSED");
  assert.equal(adapters.isAlive(child.pid), true);
});

test("a verified stop reaches only its own fixture, then the orphan is recovered", async () => {
  const target = spawnFixture();
  const sibling = spawnFixture();
  const targetInfo = await waitForIdentity(target.pid);
  const siblingInfo = await waitForIdentity(sibling.pid);
  assert.ok(targetInfo && siblingInfo);

  const controller = createMachineController({ machine: "TESTHOST", adapters });
  const session = sessionFor(target.pid, targetInfo);

  const stop = await controller.requestStop(session);
  if (stop.ok) {
    const exited = await controller.waitForExit(session, { attempts: 40, delayMs: 100 });
    assert.equal(exited.ok, true, "a successful stop must be confirmed by exit");
  } else {
    // The OS refused the graceful request. The reaper must report that and
    // leave the process alone: it never escalates to a force kill.
    assert.equal(adapters.isAlive(target.pid), true);
  }

  assert.equal(adapters.isAlive(sibling.pid), true, "the sibling fixture must never be touched");

  // Whatever happened, the reconciliation that follows is driven by the real
  // process state, not by the stop result.
  const after = classifySession(session, { ...adapters, now: Date.now() });
  if (after.state === SESSION_STATES.ORPHANED) {
    const plan = planCleanup(session, { ...adapters, now: Date.now() });
    let archived = false;
    const applied = await applyCleanup(
      { ...plan, leaseOwner: "owner-1", leaseGeneration: 3, leaseFencingToken: "fence-3" },
      {
        releaseLease: async (key, expected) => {
          assert.equal(key, session.session_key);
          assert.equal(expected.expectedGeneration, 3);
          assert.equal(expected.expectedFencingToken, "fence-3");
          return { ok: true };
        },
        archiveSession: async () => {
          archived = true;
        },
      },
    );
    assert.equal(applied.ok, true);
    assert.equal(archived, true);
  } else {
    assert.equal(after.state, SESSION_STATES.ACTIVE);
  }
});

test("a graceful stop is delivered as SIGTERM on macOS", { skip: !isMac }, async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
  ], { stdio: "ignore" });
  fixtures.add(child);
  child.on("exit", () => fixtures.delete(child));

  const info = await waitForIdentity(child.pid);
  assert.ok(info);

  const controller = createMachineController({ machine: "TESTHOST", adapters });
  const session = sessionFor(child.pid, info);
  const stop = await controller.requestStop(session);
  assert.equal(stop.ok, true);
  const exited = await controller.waitForExit(session, { attempts: 40, delayMs: 100 });
  assert.equal(exited.ok, true);
});

test("duplicate reconciliation is idempotent", async () => {
  const child = spawnFixture();
  const info = await waitForIdentity(child.pid);
  assert.ok(info);

  const sessions = [
    sessionFor(child.pid, info),
    { session_key: "ses_legacy", machine: "TESTHOST", phase: "coding", updated_at: new Date().toISOString(), owner: null },
  ];
  const first = reconcileSessions(sessions, { ...adapters, now: Date.now() });
  const second = reconcileSessions(sessions, { ...adapters, now: Date.now() });
  assert.deepEqual(second, first);
  assert.equal(first.filter((plan) => plan.action === "recover_orphan").length, 0);
});

test("a changed lease owner aborts cleanup without archiving", async () => {
  const plan = {
    sessionKey: "ses_orphan",
    action: "recover_orphan",
    archive: true,
    releaseLease: true,
    leaseOwner: "owner-1",
    leaseGeneration: 3,
    leaseFencingToken: "fence-3",
  };
  let archived = false;
  const result = await applyCleanup(plan, {
    releaseLease: async () => ({ ok: false, reason: "generation moved to 4" }),
    archiveSession: async () => {
      archived = true;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "LEASE_OWNERSHIP_CHANGED");
  assert.equal(archived, false, "a card must not be archived when the lease moved");
});

test("an unauthorized cleanup mutates nothing", async () => {
  const plan = { sessionKey: "ses_legacy", action: "hold", requiresAuthorization: true };
  let touched = false;
  const result = await applyCleanup(plan, {
    releaseLease: async () => {
      touched = true;
      return { ok: true };
    },
    archiveSession: async () => {
      touched = true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mutated, false);
  assert.equal(touched, false);
});

test("cleanup keeps a checkpoint: it archives, it never deletes", async () => {
  const plan = {
    sessionKey: "ses_orphan",
    action: "recover_orphan",
    archive: true,
    releaseLease: true,
    leaseOwner: "owner-1",
    leaseGeneration: 1,
    leaseFencingToken: "fence-1",
  };
  const calls = [];
  const result = await applyCleanup(plan, {
    releaseLease: async () => {
      calls.push("release");
      return { ok: true };
    },
    archiveSession: async () => {
      calls.push("archive");
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["release", "archive"]);
  assert.equal(result.audit.some((entry) => /delete/i.test(entry.action)), false);
});
