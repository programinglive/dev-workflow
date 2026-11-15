import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  acquireProcessLock,
  activeForeignLock,
  processLockPath,
  refreshProcessLock,
  setIsAliveForTests,
  setIsHolderProcessForTests,
  clearHeldLeasesForTests,
  DEFAULT_LOCK_STALE_MS,
  LOCK_PROTOCOL_VERSION,
} from "../process-lock.js";
import { WorkflowState } from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { testUtils } from "./test-helpers.js";

/**
 * "One writer per repo" must have teeth.
 *
 * On 31 October 2026 two OpenCode sessions wrote to one working tree. One session
 * lost every edit in `tools/handler-modules/index.js` without
 * any message — the file reverted to its HEAD version mid-work. A process
 * marker already existed, but it was only recorded as a warning, so nothing
 * stopped the collision.
 *
 * What is tested here:
 *   1. Another LIVE marker refuses `start_task` (even when its heartbeat is old;
 *      takeover without force is only allowed once the holder is confirmed dead).
 *   2. A marker whose holder is already DEAD is recovered atomically.
 *   3. `force: true` stays available to the machine owner against v2 sessions.
 */

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "lock-guard-"));
  try {
    await callback(dir);
  } finally {
    setIsAliveForTests(null);
    setIsHolderProcessForTests(null);
    clearHeldLeasesForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeLock(dir, payload) {
  const fullPayload = {
    protocolVersion: LOCK_PROTOCOL_VERSION,
    leaseId: payload.leaseId || `lease-test-${payload.pid || 0}`,
    incarnationId: payload.incarnationId || `inc-test-${payload.pid || 0}`,
    ...payload,
  };
  await writeFile(processLockPath({ dir }), JSON.stringify(fullPayload), "utf8");
}

test("activeForeignLock mengabaikan penanda milik proses ini sendiri saat lease dipegang", async () => {
  await withTempDir(async (dir) => {
    acquireProcessLock({ dir, pid: process.pid, now: Date.now() });

    const holder = activeForeignLock({ dir, pid: process.pid, isAlive: () => true });

    assert.equal(holder, null);
  });
});

test("activeForeignLock ignores a process that is already dead", async () => {
  await withTempDir(async (dir) => {
    await writeLock(dir, { pid: 999999, startedAt: Date.now(), heartbeatAt: Date.now() });

    const holder = activeForeignLock({ dir, pid: process.pid, isAlive: () => false });

    assert.equal(holder, null);
  });
});

test("activeForeignLock finds another process that is alive and was working recently", async () => {
  await withTempDir(async (dir) => {
    const now = Date.now();
    await writeLock(dir, { pid: 4242, startedAt: now - 60_000, heartbeatAt: now - 30_000, host: "MMCH" });

    const holder = activeForeignLock({ dir, pid: process.pid, now, isAlive: () => true });

    assert.ok(holder, "a fresh marker owned by another process must be detected");
    assert.equal(holder.pid, 4242);
    assert.equal(holder.host, "MMCH");
    assert.ok(holder.ageMs >= 30_000);
  });
});

test("activeForeignLock keeps protecting a live process even when its heartbeat is old (F4 no heartbeat-only takeover)", async () => {
  await withTempDir(async (dir) => {
    const now = Date.now();
    await writeLock(dir, {
      pid: 4242,
      startedAt: now - 3 * 60 * 60 * 1000,
      heartbeatAt: now - DEFAULT_LOCK_STALE_MS - 60_000,
    });

    const holderAlive = activeForeignLock({ dir, pid: process.pid, now, isAlive: () => true });
    assert.ok(holderAlive, "a live process must not be taken over just because its heartbeat is old");
    assert.equal(holderAlive.staleHeartbeat, true);

    const holderDead = activeForeignLock({ dir, pid: process.pid, now, isAlive: () => false });
    assert.equal(holderDead, null, "a stale marker whose process is dead may be taken over");
  });
});

test("refreshProcessLock only refreshes its own marker", async () => {
  await withTempDir(async (dir) => {
    const acq = acquireProcessLock({ dir, pid: process.pid, now: 1 });
    assert.equal(acq.acquired, true);

    const touched = refreshProcessLock({ dir, pid: process.pid, leaseId: acq.leaseId, now: 55555 });
    assert.equal(touched, true);

    const stored = JSON.parse(await readFile(processLockPath({ dir }), "utf8"));
    assert.equal(stored.heartbeatAt, 55555);
    assert.equal(stored.startedAt, 1, "startedAt must not change as well");

    const foreign = refreshProcessLock({ dir, pid: process.pid + 1, now: 66666 });
    assert.equal(foreign, false, "another process's marker must not be touched");
  });
});

test("acquireProcessLock records the first heartbeat when it takes over", async () => {
  await withTempDir(async (dir) => {
    const result = acquireProcessLock({ dir, pid: process.pid, now: 123456 });

    assert.equal(result.acquired, true);
    const stored = JSON.parse(await readFile(processLockPath({ dir }), "utf8"));
    assert.equal(stored.heartbeatAt, 123456);
  });
});

test("start_task refuses while another MCP process is still active on the same project", async () => {
  await withTempDir(async (dir) => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
    const stateFile = path.join(dir, "state.json");
    const state = new WorkflowState(stateFile);
    await state.load();

    try {
      await writeLock(dir, { pid: 4242, startedAt: Date.now(), heartbeatAt: Date.now(), host: "MMCH" });
      setIsAliveForTests(() => true);

      const response = await handleToolCall({
        request: {
          params: {
            name: "start_task",
            arguments: { description: "Kerjakan sesuatu", type: "feature", definitionOfDone: ["build lulus"], projectDir: dir },
          },
        },
        normalizeRequestArgs,
        workflowState: state,
        exec: async () => ({ stdout: "" }),
        git: {},
        utils: testUtils,
      });
      const out = response?.content?.[0]?.text || "";

      assert.match(out, /PID 4242/);
      assert.match(out, /legacy|Option B|another session/i);
      assert.equal(state.state.taskDescription, "", "the task must not start");
      assert.equal(state.state.currentPhase, "idle");
    } finally {
      await state.close();
    }
  });
});

test("start_task may still run once the other marker holder is dead", async () => {
  await withTempDir(async (dir) => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
    const stateFile = path.join(dir, "state.json");
    const state = new WorkflowState(stateFile);
    await state.load();

    try {
      await writeLock(dir, {
        pid: 4242,
        startedAt: Date.now() - 3 * 60 * 60 * 1000,
        heartbeatAt: Date.now() - DEFAULT_LOCK_STALE_MS - 60_000,
      });
      setIsAliveForTests((pid) => pid === process.pid);

      const response = await handleToolCall({
        request: {
          params: {
            name: "start_task",
            arguments: { description: "Kerjakan sesuatu", type: "feature", definitionOfDone: ["build lulus"], projectDir: dir },
          },
        },
        normalizeRequestArgs,
        workflowState: state,
        exec: async () => ({ stdout: "" }),
        git: {},
        utils: testUtils,
      });

      assert.match(response?.content?.[0]?.text || "", /Task Started/);
      assert.equal(state.state.currentPhase, "coding");
    } finally {
      await state.close();
    }
  });
});

test("Option B refuses force true while the active holder is still alive", async () => {
  await withTempDir(async (dir) => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
    const stateFile = path.join(dir, "state.json");
    const state = new WorkflowState(stateFile);
    await state.load();

    try {
      await writeLock(dir, { pid: 4242, startedAt: Date.now(), heartbeatAt: Date.now() });
      setIsAliveForTests(() => true);

      const response = await handleToolCall({
        request: {
          params: {
            name: "start_task",
            arguments: {
              description: "Kerjakan sesuatu",
              type: "feature",
              definitionOfDone: ["build lulus"],
              projectDir: dir,
              force: true,
            },
          },
        },
        normalizeRequestArgs,
        workflowState: state,
        exec: async () => ({ stdout: "" }),
        git: {},
        utils: testUtils,
      });

      assert.match(response?.content?.[0]?.text || "", /Dibatalkan|Refused/i);
      assert.equal(state.state.currentPhase, "idle");
    } finally {
      await state.close();
    }
  });
});

test("the heartbeat runs without arguments after the lock is acquired", async () => {
  // Regression on 31 October 2026: `rememberLockDir` was only called on the failure
  // branch, so on the normal path `refreshProcessLock()` did not know which directory
  // had to be refreshed. The marker was never updated, it was considered stale after 10
  // minutes, and the guard silently stopped protecting anything.
  await withTempDir(async (dir) => {
    acquireProcessLock({ dir, pid: process.pid, now: 1000 });

    const touched = refreshProcessLock({ now: 2000 });
    assert.equal(touched, true, "the heartbeat must run without arguments after acquire");

    const stored = JSON.parse(await readFile(processLockPath({ dir }), "utf8"));
    assert.equal(stored.heartbeatAt, 2000);
  });
});

test("a marker that just sent a heartbeat is no longer considered stale", async () => {
  await withTempDir(async (dir) => {
    acquireProcessLock({ dir, pid: process.pid, now: 1000 });
    refreshProcessLock({ now: Date.now() });

    // Proses lain melihat penanda kita sebagai aktif, bukan basi.
    const holder = activeForeignLock({ dir, pid: 4242, now: Date.now(), isAlive: () => true });
    assert.ok(holder, "a marker that just sent a heartbeat must be considered active");
  });
});
