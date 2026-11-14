import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  acquireProcessLock,
  activeForeignLock,
  processLockPath,
  refreshProcessLock,
  relocateProcessLock,
  releaseProcessLock,
  releaseActiveProcessLock,
  readProcessLockDetailed,
  getRememberedLockLease,
  setIsAliveForTests,
  setIsHolderForTests,
  clearHeldLeasesForTests,
  defaultIsHolderProcess,
  DEFAULT_LOCK_STALE_MS,
  LOCK_PROTOCOL_VERSION,
} from "../process-lock.js";
import {
  WorkflowState,
  canonicalProjectPath,
  projectKey,
  resolveCanonicalProjectIdentity,
  resolveTargetProjectState,
  findActiveForeignTaskInProject,
  parseOwnerTimestamp,
  readSessionPointer,
  readFocusBinding,
  ProjectOwnershipLostError,
} from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
import { handleStartTask } from "../tools/handler-modules/workflow-handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { closeLocalAdapters } from "../db/index.js";
import { testUtils } from "./test-helpers.js";

async function withWorkspace(callback) {
  const base = await mkdtemp(path.join(tmpdir(), "dwf-xlock-"));
  const prevCwd = process.cwd();
  const prevStateFile = process.env.DEV_WORKFLOW_STATE_FILE;
  try {
    await callback(base);
  } finally {
    process.chdir(prevCwd);
    if (prevStateFile === undefined) {
      delete process.env.DEV_WORKFLOW_STATE_FILE;
    } else {
      process.env.DEV_WORKFLOW_STATE_FILE = prevStateFile;
    }
    setIsAliveForTests(null);
    setIsHolderForTests(null);
    clearHeldLeasesForTests();
    try {
      await closeLocalAdapters();
    } catch {}
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function createRepo(dir, name) {
  const repoDir = path.join(dir, name);
  await mkdir(path.join(repoDir, ".git"), { recursive: true });
  await writeFile(path.join(repoDir, "README.md"), `# ${name}\n`, "utf8");
  return repoDir;
}

test("Scenario A: Two clients launching from shared CWD target different projects without collision", async () => {
  await withWorkspace(async (base) => {
    const sharedHome = path.join(base, "shared-home");
    const repoA = await createRepo(base, "repo-a");
    const repoB = await createRepo(base, "repo-b");
    await mkdir(sharedHome, { recursive: true });

    // Client A (Antigravity PID 16732) starts in sharedHome
    process.chdir(sharedHome);
    const stateFileA = path.join(base, "state", "projects", "shared-home-hash", "users", "u1", "workflow-state.ses_A.json");
    const stateA = new WorkflowState(stateFileA);
    await stateA.load();

    // Lock acquired on startup for sharedHome
    const lockDirA = path.dirname(stateFileA);
    acquireProcessLock({ dir: lockDirA, pid: 16732 });

    // Client A calls start_task targeting repoA
    const resA = await handleToolCall({
      request: {
        params: {
          name: "start_task",
          arguments: {
            description: "Work on repo A",
            type: "feature",
            projectDir: repoA,
            definitionOfDone: ["feature A verified"],
            plan: ["step 1"],
          },
        },
      },
      normalizeRequestArgs,
      workflowState: stateA,
      exec: async () => ({ stdout: "" }),
      git: {},
      utils: testUtils,
    });
    assert.match(resA?.content?.[0]?.text || "", /Task Started/);

    // Client B (Codex PID 18200) starts in sharedHome and targets repoB
    const stateFileB = path.join(base, "state", "projects", "shared-home-hash", "users", "u2", "workflow-state.ses_B.json");
    const stateB = new WorkflowState(stateFileB);
    await stateB.load();

    setIsAliveForTests((pid) => pid === 16732 || pid === 18200);

    const resB = await handleToolCall({
      request: {
        params: {
          name: "start_task",
          arguments: {
            description: "Work on repo B",
            type: "feature",
            projectDir: repoB,
            definitionOfDone: ["feature B verified"],
            plan: ["step 1"],
          },
        },
      },
      normalizeRequestArgs,
      workflowState: stateB,
      exec: async () => ({ stdout: "" }),
      git: {},
      utils: testUtils,
    });

    // Client B MUST succeed and NOT be blocked by client A's startup lock or task
    const textB = resB?.content?.[0]?.text || "";
    assert.doesNotMatch(textB, /sesi lain sedang mengerjakan proyek ini/);
    assert.match(textB, /Task Started/);
    assert.equal(stateB.state.taskDescription, "Work on repo B");
  });
});

test("Scenario B: Two independent processes targeting the same project are safely mutually excluded", async () => {
  await withWorkspace(async (base) => {
    const repo = await createRepo(base, "shared-project");
    const targetBucket = projectKey(canonicalProjectPath(repo));
    const targetLockDir = path.join(base, "state", "projects", targetBucket);
    await mkdir(targetLockDir, { recursive: true });

    // First process acquires lock on target project
    const lock1 = acquireProcessLock({ dir: targetLockDir, pid: 20001, now: Date.now() });
    assert.equal(lock1.acquired, true);

    // Second process attempts to acquire same target project lock
    setIsAliveForTests((pid) => pid === 20001);
    const lock2 = acquireProcessLock({ dir: targetLockDir, pid: 20002, now: Date.now() });
    assert.equal(lock2.acquired, false);
    assert.equal(lock2.holder.pid, 20001);

    // Second process calling start_task on the same project is cleanly refused
    const stateFile2 = path.join(base, "state", "projects", targetBucket, "users", "u2", "workflow-state.ses_2.json");
    const state2 = new WorkflowState(stateFile2);
    await state2.load();

    const res = await handleToolCall({
      request: {
        params: {
          name: "start_task",
          arguments: {
            description: "Concurrent attempt",
            type: "feature",
            projectDir: repo,
            definitionOfDone: ["done"],
            plan: ["step 1"],
          },
        },
      },
      normalizeRequestArgs,
      workflowState: state2,
      exec: async () => ({ stdout: "" }),
      git: {},
      utils: testUtils,
    });

    assert.match(res?.content?.[0]?.text || "", /sesi lain sedang mengerjakan proyek ini/);
    assert.match(res?.content?.[0]?.text || "", /PID 20001/);
    assert.equal(state2.state.taskDescription, "");
  });
});

test("Scenario C: Project relocation transfers lease, updates heartbeat target, and releases startup lock", async () => {
  await withWorkspace(async (base) => {
    const startupDir = path.join(base, "state", "projects", "startup-cwd");
    const targetDir = path.join(base, "state", "projects", "target-project");
    await mkdir(startupDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });

    // Acquire startup lock
    const startRes = acquireProcessLock({ dir: startupDir, pid: process.pid, now: 1000 });
    assert.equal(startRes.acquired, true);
    const initialLease = getRememberedLockLease();
    assert.ok(initialLease, "Initial lease must be registered");

    // Relocate to target directory
    const relRes = relocateProcessLock({
      fromDir: startupDir,
      toDir: targetDir,
      pid: process.pid,
      now: 2000,
    });
    assert.equal(relRes.ok, true);
    const newLease = getRememberedLockLease();
    assert.ok(newLease && newLease.leaseId !== initialLease?.leaseId, "New lease token must be generated upon relocation");

    // Startup lock file must have been cleanly released
    assert.equal(existsSync(processLockPath({ dir: startupDir })), false);

    // Target lock file must exist and contain new leaseId
    const targetDetailed = readProcessLockDetailed({ dir: targetDir });
    assert.equal(targetDetailed.status, "ok");
    assert.equal(targetDetailed.lock.leaseId, newLease.leaseId);
    assert.equal(targetDetailed.lock.pid, process.pid);

    // Subsequent heartbeat refreshes target lock without arguments
    const refreshed = refreshProcessLock({ now: 3000 });
    assert.equal(refreshed, true);
    const afterHeartbeat = readProcessLockDetailed({ dir: targetDir });
    assert.equal(afterHeartbeat.lock.heartbeatAt, 3000);
  });
});

test("Scenario D: Failed relocation when target is held preserves existing ownership byte-identically", async () => {
  await withWorkspace(async (base) => {
    const startupDir = path.join(base, "state", "projects", "startup-cwd");
    const targetDir = path.join(base, "state", "projects", "target-project");
    await mkdir(startupDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });

    // Target lock held by active foreign PID 33333
    const foreignAcquire = acquireProcessLock({ dir: targetDir, pid: 33333, now: 1000 });
    assert.equal(foreignAcquire.acquired, true);
    const targetContentBefore = readFileSync(processLockPath({ dir: targetDir }), "utf8");

    // Process acquires startup lock
    acquireProcessLock({ dir: startupDir, pid: process.pid, now: 1500 });
    const startupContentBefore = readFileSync(processLockPath({ dir: startupDir }), "utf8");

    // Relocation attempt must fail because target is held
    setIsAliveForTests((pid) => pid === 33333);
    const relRes = relocateProcessLock({
      fromDir: startupDir,
      toDir: targetDir,
      pid: process.pid,
      now: 2000,
      isAlive: (pid) => pid === 33333,
    });
    assert.equal(relRes.ok, false);
    assert.equal(relRes.holder.pid, 33333);

    // Target lock content must remain 100% byte-identical
    assert.equal(readFileSync(processLockPath({ dir: targetDir }), "utf8"), targetContentBefore);
    // Startup lock must still be intact
    assert.equal(readFileSync(processLockPath({ dir: startupDir }), "utf8"), startupContentBefore);
  });
});

test("Scenario E: Crash recovery, dead PID, reused PID, and corrupt lock recovery", async () => {
  await withWorkspace(async (base) => {
    const lockDir = path.join(base, "lock-recovery");
    await mkdir(lockDir, { recursive: true });

    // 1. Corrupt lock recovery: invalid JSON
    await writeFile(processLockPath({ dir: lockDir }), "{ not json", "utf8");
    const claim1 = acquireProcessLock({ dir: lockDir, pid: process.pid, now: 1000 });
    assert.equal(claim1.acquired, true);
    assert.equal(claim1.recovered, true);
    releaseProcessLock({ dir: lockDir });

    // 2. Dead PID recovery: PID 99999 is dead
    await writeFile(
      processLockPath({ dir: lockDir }),
      JSON.stringify({ pid: 99999, startedAt: Date.now(), heartbeatAt: Date.now() }),
      "utf8",
    );
    setIsAliveForTests((pid) => pid === process.pid);
    const claim2 = acquireProcessLock({
      dir: lockDir,
      pid: process.pid,
      now: 2000,
      isAlive: (pid) => pid === process.pid,
    });
    assert.equal(claim2.acquired, true);
    assert.equal(claim2.recovered, true);
    releaseProcessLock({ dir: lockDir });

    // 3. Reused PID recovery: PID alive but holder check proves it is not dev-workflow
    await writeFile(
      processLockPath({ dir: lockDir }),
      JSON.stringify({ pid: 77777, startedAt: Date.now(), heartbeatAt: Date.now() }),
      "utf8",
    );
    const claim3 = acquireProcessLock({
      dir: lockDir,
      pid: process.pid,
      now: 3000,
      isAlive: () => true,
      isHolderProcess: () => false, // Non-matching process
    });
    assert.equal(claim3.acquired, true);
    assert.equal(claim3.recovered, true);
    releaseProcessLock({ dir: lockDir });
  });
});

test("Scenario F: Multi-client multi-project concurrency matrix from shared CWD", async () => {
  await withWorkspace(async (base) => {
    const repos = [];
    for (let i = 1; i <= 3; i++) {
      repos.push(await createRepo(base, `matrix-repo-${i}`));
    }

    // Three distinct clients start from the same shared CWD
    const states = [];
    for (let i = 1; i <= 3; i++) {
      const stateFile = path.join(base, "state", "projects", "shared-home", "users", `u${i}`, `workflow-state.ses_${i}.json`);
      const state = new WorkflowState(stateFile);
      await state.load();
      states.push(state);
    }

    // All three start tasks on their respective repos
    for (let i = 0; i < 3; i++) {
      const res = await handleToolCall({
        request: {
          params: {
            name: "start_task",
            arguments: {
              description: `Task for matrix repo ${i + 1}`,
              type: "feature",
              projectDir: repos[i],
              definitionOfDone: [`dod ${i + 1}`],
              plan: ["plan 1"],
            },
          },
        },
        normalizeRequestArgs,
        workflowState: states[i],
        exec: async () => ({ stdout: "" }),
        git: {},
        utils: testUtils,
      });
      assert.match(res?.content?.[0]?.text || "", /Task Started/);
      assert.equal(states[i].state.taskDescription, `Task for matrix repo ${i + 1}`);
    }
  });
});

test("Scenario G: Backward compatibility with projectKey, canonicalization, and symlink/slash resolution", () => {
  const norm1 = canonicalProjectPath("D:/code/Dev-Workflow-MCP-Server/");
  const norm2 = canonicalProjectPath("d:\\code\\dev-workflow-mcp-server");
  assert.equal(norm1.toLowerCase(), norm2.toLowerCase());

  const key1 = projectKey("D:/code/dev-workflow-mcp-server");
  const key2 = projectKey("D:\\code\\dev-workflow-mcp-server\\");
  assert.equal(key1, key2);

  const resolution = resolveTargetProjectState({
    stateFile: "D:/state/projects/shared-hash/users/u1/workflow-state.ses_1.json",
    projectDir: "D:/code/dev-workflow-mcp-server",
  });
  assert.equal(resolution.isPinnedLayout, true);
  assert.equal(resolution.bucketKey, key1);
});

test("Scenario H: Stale timer or mismatched lease token cannot overwrite relocated or foreign lock", async () => {
  await withWorkspace(async (base) => {
    const lockDir = path.join(base, "lease-fencing");
    await mkdir(lockDir, { recursive: true });

    // Acquire lock and get valid leaseId
    const acq = acquireProcessLock({ dir: lockDir, pid: process.pid, now: 1000 });
    assert.equal(acq.acquired, true);
    const validLease = acq.leaseId;

    // Direct attempt to refresh with wrong lease token must fail
    const wrongLeaseRefresh = refreshProcessLock({
      dir: lockDir,
      pid: process.pid,
      leaseId: "wrong-lease-token-12345",
      now: 2000,
    });
    assert.equal(wrongLeaseRefresh, false);

    // Lock file must retain original heartbeat timestamp
    const detailed = readProcessLockDetailed({ dir: lockDir });
    assert.equal(detailed.lock.heartbeatAt, 1000);

    // Refresh with valid lease token succeeds
    const validRefresh = refreshProcessLock({
      dir: lockDir,
      pid: process.pid,
      leaseId: validLease,
      now: 2500,
    });
    assert.equal(validRefresh, true);
    const updated = readProcessLockDetailed({ dir: lockDir });
    assert.equal(updated.lock.heartbeatAt, 2500);
  });
});

test("Scenario I: Separate OS child processes execute CLI start_task from shared CWD targeting different repos concurrently", async () => {
  await withWorkspace(async (base) => {
    const sharedCwd = path.join(base, "shared-cwd");
    await mkdir(sharedCwd, { recursive: true });
    const repo1 = await createRepo(base, "cli-repo-1");
    const repo2 = await createRepo(base, "cli-repo-2");

    const indexScript = path.resolve("index.js");

    const child1 = spawnSync(
      process.execPath,
      [
        indexScript,
        "call",
        "start_task",
        "--args",
        JSON.stringify({
          description: "CLI task for repo 1",
          type: "feature",
          projectDir: repo1,
          definitionOfDone: ["verified 1"],
          plan: ["step 1"],
        }),
      ],
      {
        cwd: sharedCwd,
        env: {
          ...process.env,
          DEV_WORKFLOW_STATE_FILE: path.join(base, "state", "projects", "shared-cwd", "users", "u1", "workflow-state.json"),
        },
        encoding: "utf8",
      },
    );

    const child2 = spawnSync(
      process.execPath,
      [
        indexScript,
        "call",
        "start_task",
        "--args",
        JSON.stringify({
          description: "CLI task for repo 2",
          type: "feature",
          projectDir: repo2,
          definitionOfDone: ["verified 2"],
          plan: ["step 1"],
        }),
      ],
      {
        cwd: sharedCwd,
        env: {
          ...process.env,
          DEV_WORKFLOW_STATE_FILE: path.join(base, "state", "projects", "shared-cwd", "users", "u2", "workflow-state.json"),
        },
        encoding: "utf8",
      },
    );

    assert.equal(child1.status, 0, `Child 1 error: ${child1.stderr}`);
    assert.match(child1.stdout, /Task Started/);
    assert.match(child1.stdout, /CLI task for repo 1/);

    assert.equal(child2.status, 0, `Child 2 error: ${child2.stderr}`);
    assert.match(child2.stdout, /Task Started/);
    assert.match(child2.stdout, /CLI task for repo 2/);
    assert.doesNotMatch(child2.stdout, /sesi lain sedang mengerjakan proyek ini/);
  });
});

// ===========================================================================
// PHASE 7 — DETERMINISTIC CONCURRENCY & SECURITY REGRESSION SUITE (F1–F8)
// ===========================================================================

test("F1 Concurrency: Stale heartbeat paused after initial read cannot overwrite successor ownership", async () => {
  await withWorkspace(async (base) => {
    const lockDir = path.join(base, "f1-heartbeat-vs-successor");
    await mkdir(lockDir, { recursive: true });

    // Owner A acquires lock
    const ownerA = acquireProcessLock({ dir: lockDir, pid: 1001, now: 1000 });
    assert.equal(ownerA.acquired, true);

    let successorLock = null;
    // Owner A starts refreshProcessLock, passes initial read, then pauses in `onBeforeCommit`
    // while Owner B acquires successor ownership (after Owner A is replaced/forced).
    const refreshed = refreshProcessLock({
      dir: lockDir,
      pid: 1001,
      leaseId: ownerA.leaseId,
      now: 5000,
      hooks: {
        onBeforeCommit: () => {
          successorLock = acquireProcessLock({
            dir: lockDir,
            pid: 2002,
            now: 3000,
            force: true,
            isAlive: () => true,
          });
          assert.equal(successorLock.acquired, true);
        },
      },
    });

    assert.equal(refreshed, false, "Stale owner heartbeat MUST abort under gate when successor owns lock");
    const finalDisk = readProcessLockDetailed({ dir: lockDir });
    assert.equal(finalDisk.status, "ok");
    assert.equal(finalDisk.lock.pid, 2002, "Successor PID must remain intact");
    assert.equal(finalDisk.lock.leaseId, successorLock.leaseId, "Successor leaseId must remain intact");
    assert.equal(finalDisk.lock.heartbeatAt, 3000, "Successor heartbeatAt must not be overwritten by 5000");
  });
});

test("F2 Concurrency: Stale/corrupt recovery interleaved with competing acquire and multi-process barrier", async () => {
  await withWorkspace(async (base) => {
    const lockDir = path.join(base, "f2-stale-recovery-race");
    await mkdir(lockDir, { recursive: true });

    // Seed a dead-holder lock
    writeFileSync(
      processLockPath({ dir: lockDir }),
      JSON.stringify({
        protocolVersion: LOCK_PROTOCOL_VERSION,
        pid: 88888,
        leaseId: "lease-dead-88888",
        incarnationId: "inc-dead-88888",
        startedAt: 500,
        heartbeatAt: 500,
      }),
      "utf8",
    );

    // 1. Deterministic hook interleaving: Process B pauses in `onBeforeClaim` right after
    // observing dead PID 88888; Process C recovers and acquires the lock first.
    let winnerC = null;
    const loserB = acquireProcessLock({
      dir: lockDir,
      pid: 2002,
      now: 2000,
      isAlive: (pid) => pid === 2002 || pid === 3003,
      hooks: {
        onBeforeClaim: () => {
          winnerC = acquireProcessLock({
            dir: lockDir,
            pid: 3003,
            now: 1900,
            isAlive: (pid) => pid === 2002 || pid === 3003,
          });
          assert.equal(winnerC.acquired, true);
        },
      },
    });

    assert.equal(loserB.acquired, false, "Process B must see Process C's newly recovered lock inside the gate");
    assert.equal(loserB.holder.pid, 3003);
    const diskAfterHookRace = readProcessLockDetailed({ dir: lockDir });
    assert.equal(diskAfterHookRace.lock.pid, 3003);
    assert.equal(diskAfterHookRace.lock.leaseId, winnerC.leaseId);

    // 2. Real multi-process OS barrier race: 4 concurrent child processes racing on a dead lock
    const multiRaceDir = path.join(base, "f2-multiprocess-race");
    await mkdir(multiRaceDir, { recursive: true });
    writeFileSync(
      processLockPath({ dir: multiRaceDir }),
      JSON.stringify({
        protocolVersion: LOCK_PROTOCOL_VERSION,
        pid: 999991,
        leaseId: "lease-dead-999991",
        incarnationId: "inc-dead-999991",
        startedAt: 100,
        heartbeatAt: 100,
      }),
      "utf8",
    );

    const processLockModuleHref = pathToFileURL(path.resolve("process-lock.js")).href;
    const workerScriptPath = path.join(multiRaceDir, "dev-workflow-race-worker.mjs");
    writeFileSync(
      workerScriptPath,
      `
      import { acquireProcessLock } from ${JSON.stringify(processLockModuleHref)};
      process.send({ ready: true, pid: process.pid });
      process.once("message", (msg) => {
        if (msg && msg.go) {
          const res = acquireProcessLock({ dir: ${JSON.stringify(multiRaceDir)} });
          process.send({ done: true, pid: process.pid, acquired: res.acquired, leaseId: res.leaseId || null, holderPid: res.holder?.pid || null });
        }
        // Keep worker process alive until parent inspects winners and sends "exit"
        setInterval(() => {}, 1000);
      });
      process.on("message", (msg) => {
        if (msg && msg.exit) process.exit(0);
      });
    `,
      "utf8",
    );

    const children = [];
    const readyPromises = [];
    const donePromises = [];
    for (let i = 0; i < 4; i++) {
      const child = spawn(process.execPath, [workerScriptPath], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.push(child);
      readyPromises.push(
        new Promise((resolve, reject) => {
          child.once("error", reject);
          const onMsg = (m) => {
            if (m && m.ready) {
              child.off("message", onMsg);
              resolve(m);
            }
          };
          child.on("message", onMsg);
        }),
      );
      donePromises.push(
        new Promise((resolve, reject) => {
          child.once("error", reject);
          const onMsg = (m) => {
            if (m && m.done) {
              child.off("message", onMsg);
              resolve(m);
            }
          };
          child.on("message", onMsg);
        }),
      );
    }

    await Promise.all(readyPromises);
    // Release all 4 processes at the exact same instant
    for (const child of children) {
      child.send({ go: true });
    }
    const results = await Promise.all(donePromises);
    for (const child of children) {
      try {
        child.send({ exit: true });
        child.kill();
      } catch {}
    }

    const winners = results.filter((r) => r.acquired === true);
    const losers = results.filter((r) => r.acquired === false);
    assert.equal(winners.length, 1, `Expected exactly 1 atomic winner across 4 racing processes, got ${winners.length}: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 3);

    const finalMultiDisk = readProcessLockDetailed({ dir: multiRaceDir });
    assert.equal(finalMultiDisk.status, "ok");
    assert.equal(finalMultiDisk.lock.pid, winners[0].pid);
    assert.equal(finalMultiDisk.lock.leaseId, winners[0].leaseId);
  });
});

test("F3 Concurrency: Former owner release paused after check cannot delete successor lock", async () => {
  await withWorkspace(async (base) => {
    const lockDir = path.join(base, "f3-release-vs-successor");
    await mkdir(lockDir, { recursive: true });

    const ownerA = acquireProcessLock({ dir: lockDir, pid: 1001, now: 1000 });
    assert.equal(ownerA.acquired, true);

    let ownerB = null;
    // Owner A calls releaseProcessLock, pauses in `onBeforeRelease`, while Owner B takes over
    const releasedByA = releaseProcessLock({
      dir: lockDir,
      pid: 1001,
      leaseId: ownerA.leaseId,
      hooks: {
        onBeforeRelease: () => {
          ownerB = acquireProcessLock({
            dir: lockDir,
            pid: 2002,
            now: 2000,
            force: true,
            isAlive: () => true,
          });
          assert.equal(ownerB.acquired, true);
        },
      },
    });

    assert.equal(releasedByA, false, "Former owner release must return false when successor acquired lock");
    const disk = readProcessLockDetailed({ dir: lockDir });
    assert.equal(disk.status, "ok", "Successor lock file must NOT be unlinked");
    assert.equal(disk.lock.pid, 2002);
    assert.equal(disk.lock.leaseId, ownerB.leaseId);

    // Also verify release without leaseId on a v2 lock fails closed
    const unauthenticatedRelease = releaseProcessLock({
      dir: lockDir,
      pid: 2002,
      leaseId: null,
    });
    assert.equal(unauthenticatedRelease, false, "PID-only release without leaseId must be rejected");
    assert.equal(readProcessLockDetailed({ dir: lockDir }).status, "ok");
  });
});

test("F4 Compatibility: Heartbeat expiry while alive never authorizes takeover, and legacy v1 locks fail closed in both orders", async () => {
  await withWorkspace(async (base) => {
    const repo = await createRepo(base, "f4-repo");
    const targetBucket = projectKey(canonicalProjectPath(repo));
    const targetLockDir = path.join(base, "state", "projects", targetBucket);
    const startupLockDir = path.join(base, "state", "projects", "shared-home");
    await mkdir(targetLockDir, { recursive: true });
    await mkdir(startupLockDir, { recursive: true });

    // Part 1: Heartbeat expired (2 hours old) while owner process is STILL ALIVE
    const oldTime = Date.now() - 2 * 60 * 60 * 1000;
    const owner1 = acquireProcessLock({ dir: targetLockDir, pid: 44441, now: oldTime });
    assert.equal(owner1.acquired, true);

    const takeoverAttempt = acquireProcessLock({
      dir: targetLockDir,
      pid: 44442,
      now: Date.now(),
      isAlive: (pid) => pid === 44441 || pid === 44442,
    });
    assert.equal(takeoverAttempt.acquired, false, "Timed-out heartbeat must NEVER allow takeover while holder is alive");
    assert.equal(takeoverAttempt.holder.pid, 44441);
    assert.equal(takeoverAttempt.holder.staleHeartbeat, true);
    releaseProcessLock({ dir: targetLockDir, pid: 44441, leaseId: owner1.leaseId });

    // Part 2: Legacy v1 writer active directly in targetLockDir (no leaseId / protocolVersion)
    writeFileSync(
      processLockPath({ dir: targetLockDir }),
      JSON.stringify({ pid: 55551, startedAt: Date.now(), heartbeatAt: Date.now(), host: "MMCH" }),
      "utf8",
    );
    setIsAliveForTests((pid) => pid === 55551 || pid === process.pid);

    const stateFileV2 = path.join(startupLockDir, "users", "u2", "workflow-state.ses_v2.json");
    const stateV2 = new WorkflowState(stateFileV2);
    await stateV2.load();

    // Even with force: true, v2 must refuse to overwrite an active legacy v1 writer
    const resDirectLegacy = await handleToolCall({
      request: {
        params: {
          name: "start_task",
          arguments: {
            description: "Attempt against direct legacy writer",
            type: "feature",
            projectDir: repo,
            definitionOfDone: ["dod 1"],
            plan: ["step 1"],
            force: true,
          },
        },
      },
      normalizeRequestArgs,
      workflowState: stateV2,
      exec: async () => ({ stdout: "" }),
      git: {},
      utils: testUtils,
    });
    assert.match(resDirectLegacy?.content?.[0]?.text || "", /legacy v1|sesi lain/i);
    assert.equal(stateV2.state.taskDescription, "");
    await rm(processLockPath({ dir: targetLockDir }), { force: true });

    // Part 3: Legacy v1 writer started in sharedCwd (lock stays in startupLockDir, pointer in sessions/*.json points to repo)
    writeFileSync(
      processLockPath({ dir: startupLockDir }),
      JSON.stringify({ pid: 55552, startedAt: Date.now(), heartbeatAt: Date.now(), host: "MMCH" }),
      "utf8",
    );
    const sessionsDir = path.join(base, "state", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    writeFileSync(
      path.join(sessionsDir, "ses_legacy.json"),
      JSON.stringify({
        projectDir: canonicalProjectPath(repo),
        projectDirPath: targetLockDir,
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    setIsAliveForTests((pid) => pid === 55552 || pid === process.pid);

    const resRelocatedLegacy = await handleToolCall({
      request: {
        params: {
          name: "start_task",
          arguments: {
            description: "Attempt against shared-CWD legacy writer",
            type: "feature",
            projectDir: repo,
            definitionOfDone: ["dod 1"],
            plan: ["step 1"],
            force: true,
          },
        },
      },
      normalizeRequestArgs,
      workflowState: stateV2,
      exec: async () => ({ stdout: "" }),
      git: {},
      utils: testUtils,
    });
    assert.match(resRelocatedLegacy?.content?.[0]?.text || "", /legacy v1/i);
    assert.match(resRelocatedLegacy?.content?.[0]?.text || "", /55552/);
    assert.equal(stateV2.state.taskDescription, "");
    await stateV2.close();
  });
});

test("F5 Fencing: Former owner blocked from save/_exportJson/writeHistoryFile/updateProjectSummary after ownership loss, and ISO owner.updatedAt parsed accurately", async () => {
  await withWorkspace(async (base) => {
    const repo = await createRepo(base, "f5-fenced-repo");
    const bucket = projectKey(canonicalProjectPath(repo));
    const lockDir = path.join(base, "state", "projects", bucket);
    const stateFileA = path.join(lockDir, "users", "u1", "workflow-state.ses_A.json");
    await mkdir(path.dirname(stateFileA), { recursive: true });

    // Owner A acquires lock and binds lease to WorkflowState
    const leaseA = acquireProcessLock({ dir: lockDir, pid: process.pid, now: 1000 });
    assert.equal(leaseA.acquired, true);

    const stateA = new WorkflowState(stateFileA);
    stateA.bindLockLease({ dir: lockDir, leaseId: leaseA.leaseId });
    await stateA.load();
    stateA.state.currentPhase = "coding";
    stateA.state.taskDescription = "Owner A legitimate task";
    stateA.state.projectDir = repo;
    await stateA.save({ allowReplaceRunningTask: true });

    // Verify ISO timestamp parsing (F5 bug fix: save() writes ISO string to owner.updatedAt)
    const diskStateAfterA = JSON.parse(readFileSync(stateFileA, "utf8"));
    assert.equal(typeof diskStateAfterA.owner.updatedAt, "string");
    const parsedTs = parseOwnerTimestamp(diskStateAfterA.owner.updatedAt);
    assert.ok(Number.isFinite(parsedTs) && parsedTs > 0, "ISO owner.updatedAt must parse to finite epoch ms");

    // Verify findActiveForeignTaskInProject detects ISO-timestamped foreign task
    const detectedForeign = findActiveForeignTaskInProject({
      projectDirPath: lockDir,
      targetStateFile: stateFileA,
      ownPid: 99999,
      isAlive: () => true,
      isHolderProcess: () => true,
    });
    assert.ok(detectedForeign, "findActiveForeignTaskInProject must detect active task with ISO owner.updatedAt");
    assert.equal(detectedForeign.description, "Owner A legitimate task");

    // Now Owner B (PID 77777) forcibly takes over the project lock!
    const leaseB = acquireProcessLock({
      dir: lockDir,
      pid: 77777,
      now: 2000,
      force: true,
      isAlive: () => true,
    });
    assert.equal(leaseB.acquired, true);

    // Owner A attempts protected writes after losing lock ownership: ALL must throw ProjectOwnershipLostError!
    stateA.state.taskDescription = "Stale Owner A illicit overwrite";
    await assert.rejects(
      () => stateA.save(),
      (err) => err instanceof ProjectOwnershipLostError && err.code === "PROJECT_OWNERSHIP_LOST",
      "save() by former owner must reject with ProjectOwnershipLostError",
    );
    await assert.rejects(
      () => stateA._exportJson(),
      (err) => err instanceof ProjectOwnershipLostError && err.code === "PROJECT_OWNERSHIP_LOST",
      "_exportJson() by former owner must reject with ProjectOwnershipLostError",
    );
    await assert.rejects(
      () => stateA.writeHistoryFile(),
      (err) => err instanceof ProjectOwnershipLostError && err.code === "PROJECT_OWNERSHIP_LOST",
      "writeHistoryFile() by former owner must reject with ProjectOwnershipLostError",
    );
    await assert.rejects(
      () => stateA.updateProjectSummary(),
      (err) => err instanceof ProjectOwnershipLostError && err.code === "PROJECT_OWNERSHIP_LOST",
      "updateProjectSummary() by former owner must reject with ProjectOwnershipLostError",
    );

    // Verify disk JSON still holds "Owner A legitimate task", NOT "Stale Owner A illicit overwrite"
    const diskAfterRejected = JSON.parse(readFileSync(stateFileA, "utf8"));
    assert.equal(diskAfterRejected.taskDescription, "Owner A legitimate task");

    await stateA.close();
  });
});

test("F5 Serialization: In-process concurrent save() calls on the same WorkflowState instance are serialized", async () => {
  await withWorkspace(async (base) => {
    const lockDir = path.join(base, "state", "projects", "serial-test");
    const stateFile = path.join(lockDir, "users", "u1", "workflow-state.ses_serial.json");
    await mkdir(path.dirname(stateFile), { recursive: true });

    const lease = acquireProcessLock({ dir: lockDir, pid: process.pid });
    const ws = new WorkflowState(stateFile);
    ws.bindLockLease({ dir: lockDir, leaseId: lease.leaseId });
    await ws.load();

    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "Concurrent in-process task";

    const [r1, r2, r3] = await Promise.all([
      ws.save({ allowReplaceRunningTask: true }),
      ws.save({ allowReplaceRunningTask: true }),
      ws.save({ allowReplaceRunningTask: true }),
    ]);

    assert.equal(r1.verified, true);
    assert.equal(r2.verified, true);
    assert.equal(r3.verified, true);
    assert.ok(r1.version < r2.version && r2.version < r3.version, "Versions must strictly increment without STATE_CONFLICT race");
    await ws.close();
  });
});

test("F6 Fail-Closed Write Errors: EACCES/ENOSPC during acquire or relocate returns acquired:false and aborts start_task", async () => {
  await withWorkspace(async (base) => {
    const fromDir = path.join(base, "f6-from");
    const toDir = path.join(base, "f6-to");
    await mkdir(fromDir, { recursive: true });
    await mkdir(toDir, { recursive: true });

    const startLock = acquireProcessLock({ dir: fromDir, pid: process.pid, now: 1000 });
    assert.equal(startLock.acquired, true);

    for (const code of ["EACCES", "EPERM", "ENOSPC", "EROFS"]) {
      const acq = acquireProcessLock({
        dir: toDir,
        pid: process.pid,
        now: 2000,
        writeFileImpl: () => {
          throw Object.assign(new Error(`${code}: simulated write failure`), { code });
        },
      });
      assert.equal(acq.acquired, false, `acquireProcessLock must return acquired: false on ${code}`);
      assert.equal(acq.wrote, false);
    }

    // Source lock in fromDir must still be held and untouched
    const fromDisk = readProcessLockDetailed({ dir: fromDir });
    assert.equal(fromDisk.status, "ok");
    assert.equal(fromDisk.lock.leaseId, startLock.leaseId);
  });
});

test("F7 Transactional Transition: Injected failure mid-transition rolls back state, session pointer, focus binding, and locks", async () => {
  await withWorkspace(async (base) => {
    const repoA = await createRepo(base, "tx-repo-a");
    const repoB = await createRepo(base, "tx-repo-b");

    const bucketA = projectKey(canonicalProjectPath(repoA));
    const bucketB = projectKey(canonicalProjectPath(repoB));
    const lockDirA = path.join(base, "state", "projects", bucketA);
    const lockDirB = path.join(base, "state", "projects", bucketB);
    const stateFileA = path.join(lockDirA, "users", "u1", "workflow-state.ses_tx.json");

    const ws = new WorkflowState(stateFileA);
    await ws.load();

    // Start initial task on repoA with Focus #81
    const resInit = await handleStartTask(
      {
        description: "Initial task on Repo A",
        type: "feature",
        projectDir: repoA,
        focusId: 81,
        definitionOfDone: ["repo A dod 1", "repo A dod 2"],
        plan: ["repo A step 1"],
      },
      ws,
      {},
    );
    assert.match(resInit?.content?.[0]?.text || "", /Task Started/);
    assert.equal(ws.state.taskDescription, "Initial task on Repo A");
    assert.equal(ws.state.projectDir, repoA);

    // Mark DoD 1 done on Repo A so we can prove DoD evidence is preserved on rollback
    ws.state.definitionOfDone[0].status = "done";
    ws.state.definitionOfDone[0].evidence = "Proven on Repo A";
    await ws.save();

    const lockABefore = readProcessLockDetailed({ dir: lockDirA });
    assert.equal(lockABefore.status, "ok");
    const stateFileABeforeSwitch = ws.stateFile;
    const pointerBefore = readSessionPointer(path.join(base, "state"), "ses_tx");
    assert.equal(pointerBefore.projectDir, canonicalProjectPath(repoA));
    const focus81Before = readFocusBinding({ stateFile: ws.stateFile, focusId: 81 });
    assert.ok(focus81Before);

    // Now attempt to switch to repoB (with Focus #88) and inject a failure in `beforeSave`
    // (after target lock B was staged, focus #88 was claimed, session pointer was updated to repoB, and state was reset!)
    const resFailedSwitch = await handleStartTask(
      {
        description: "Switch to Repo B that fails mid-flight",
        type: "feature",
        projectDir: repoB,
        focusId: 88,
        allowProjectSwitch: true,
        projectSwitchReason: "Testing transactional rollback on failure",
        definitionOfDone: ["repo B dod"],
        plan: ["repo B step"],
      },
      ws,
      {},
      {
        transitionHooks: {
          beforeSave: async () => {
            throw new Error("SIMULATED_MID_TRANSITION_CRASH");
          },
        },
      },
    );

    const failText = resFailedSwitch?.content?.[0]?.text || "";
    assert.match(failText, /SIMULATED_MID_TRANSITION_CRASH/);
    assert.match(failText, /dikembalikan ke kondisi sebelum/);

    // 1. In-memory workflowState must be restored to Repo A's task & DoD evidence
    assert.equal(ws.state.taskDescription, "Initial task on Repo A");
    assert.equal(ws.state.projectDir, repoA);
    assert.equal(ws.state.definitionOfDone[0].status, "done");
    assert.equal(ws.state.definitionOfDone[0].evidence, "Proven on Repo A");
    assert.equal(ws.stateFile, stateFileABeforeSwitch);

    // 2. Session pointer must be restored to Repo A
    const pointerAfter = readSessionPointer(path.join(base, "state"), "ses_tx");
    assert.equal(pointerAfter.projectDir, canonicalProjectPath(repoA));

    // 3. Focus #88 binding created during the failed attempt must be rolled back (removed)
    const focus88After = readFocusBinding({ stateFile: ws.stateFile, focusId: 88 });
    assert.equal(focus88After, null, "Focus #88 binding must be rolled back on transition failure");

    // 4. Source lock (lockDirA) must STILL be held by our process, and target lock (lockDirB) must be released
    const lockAAfter = readProcessLockDetailed({ dir: lockDirA });
    assert.equal(lockAAfter.status, "ok", "Source lock on Repo A must remain held after rollback");
    assert.equal(lockAAfter.lock.pid, process.pid);
    const lockBAfter = readProcessLockDetailed({ dir: lockDirB });
    assert.equal(lockBAfter.status, "missing", "Staged target lock on Repo B must be released on rollback");

    await ws.close();
  });
});

test("F8 Identity: Same-PID re-entry without leaseId is rejected, and real OS PID reuse by another Node process is detected", async () => {
  await withWorkspace(async (base) => {
    const lockDir = path.join(base, "f8-identity");
    await mkdir(lockDir, { recursive: true });

    // 1. Write a lock with our own `process.pid` but a foreign `leaseId` and `incarnationId`
    writeFileSync(
      processLockPath({ dir: lockDir }),
      JSON.stringify({
        protocolVersion: LOCK_PROTOCOL_VERSION,
        pid: process.pid,
        leaseId: "lease-foreign-incarnation-999",
        incarnationId: "inc-foreign-incarnation-999",
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
      "utf8",
    );

    // Since `incarnationId` does not match `PROCESS_INCARNATION_ID`, `defaultIsHolderProcess`
    // recognizes that our current process incarnation is NOT the one that wrote that lock.
    // And if `isHolderProcess` is overridden to return `true` (simulating another client in the
    // same PID without the lease token), `acquireProcessLock` must reject same-PID re-entry!
    const reentryAttempt = acquireProcessLock({
      dir: lockDir,
      pid: process.pid,
      isAlive: () => true,
      isHolderProcess: () => true,
    });
    assert.equal(reentryAttempt.acquired, false, "Same-PID re-entry without held leaseId must be rejected");
    assert.equal(reentryAttempt.holder.leaseMismatch, true);

    // 2. Real OS process PID reuse test: spawn a real background `node -e` process
    const dummyNode = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      assert.ok(dummyNode.pid && dummyNode.pid > 0, "Background node process must have a valid OS PID");

      // Case 2a: `dummyNode` is running `node -e "setInterval..."` (NOT dev-workflow)
      const isHolderGenericEval = defaultIsHolderProcess(dummyNode.pid, {
        pid: dummyNode.pid,
        startedAt: Date.now() + 60_000,
      });
      assert.equal(
        isHolderGenericEval,
        false,
        "defaultIsHolderProcess must return false for an unrelated `node -e` process reusing a PID",
      );

      // Case 2b: Lock claims `startedAt` 60 seconds BEFORE `dummyNode` was spawned
      const isHolderOlderLock = defaultIsHolderProcess(dummyNode.pid, {
        pid: dummyNode.pid,
        startedAt: Date.now() - 60_000,
        processStartedAt: Date.now() - 60_000,
      });
      assert.equal(
        isHolderOlderLock,
        false,
        "defaultIsHolderProcess must return false when OS process creation time is newer than lock startedAt",
      );
    } finally {
      try {
        dummyNode.kill();
      } catch {}
    }
  });
});

test("Real Git Worktree & Windows Junction Isolation: Independent worktrees operate concurrently while junction to same worktree is mutually excluded", async () => {
  await withWorkspace(async (base) => {
    const mainRepo = path.join(base, "real-git-main");
    const worktree2 = path.join(base, "real-git-wt2");
    const junctionToMain = path.join(base, "junction-to-main");
    await mkdir(mainRepo, { recursive: true });

    // Initialize a real Git repository and commit a file
    const runGit = (cwd, gitArgs) => {
      const r = spawnSync("git", gitArgs, { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, `git ${gitArgs.join(" ")} failed: ${r.stderr}`);
    };
    runGit(mainRepo, ["init"]);
    runGit(mainRepo, ["config", "user.email", "test@example.com"]);
    runGit(mainRepo, ["config", "user.name", "Test User"]);
    await writeFile(path.join(mainRepo, "index.js"), "console.log('hello');\n", "utf8");
    runGit(mainRepo, ["add", "."]);
    runGit(mainRepo, ["commit", "-m", "initial commit"]);

    // Create a second real Git worktree on a new branch
    runGit(mainRepo, ["worktree", "add", "-b", "feature/wt2", worktree2]);

    // Create a filesystem junction/symlink pointing to `mainRepo`
    symlinkSync(mainRepo, junctionToMain, process.platform === "win32" ? "junction" : "dir");

    // 1. Canonical path of `junctionToMain` MUST equal canonical path of `mainRepo`
    assert.equal(
      canonicalProjectPath(junctionToMain),
      canonicalProjectPath(mainRepo),
      "Junction/symlink path must resolve to the exact same canonical working tree identity",
    );
    assert.equal(projectKey(junctionToMain), projectKey(mainRepo));

    // 2. Canonical path of `worktree2` MUST be distinct from `mainRepo`
    assert.notEqual(
      canonicalProjectPath(worktree2),
      canonicalProjectPath(mainRepo),
      "Linked Git worktree must have its own distinct canonical working tree identity",
    );
    assert.notEqual(projectKey(worktree2), projectKey(mainRepo));

    // 3. Client 1 starts a task on `mainRepo`
    const stateFile1 = path.join(base, "state", "projects", "shared", "users", "u1", "workflow-state.ses_wt1.json");
    const ws1 = new WorkflowState(stateFile1);
    await ws1.load();
    const res1 = await handleStartTask(
      {
        description: "Work in main worktree",
        type: "feature",
        projectDir: mainRepo,
        definitionOfDone: ["main wt done"],
        plan: ["step 1"],
      },
      ws1,
      {},
    );
    assert.match(res1?.content?.[0]?.text || "", /Task Started/);

    // 4. Client 2 starts a task on `worktree2` concurrently -> MUST SUCCEED
    const stateFile2 = path.join(base, "state", "projects", "shared", "users", "u2", "workflow-state.ses_wt2.json");
    const ws2 = new WorkflowState(stateFile2);
    await ws2.load();
    const res2 = await handleStartTask(
      {
        description: "Work in secondary worktree",
        type: "feature",
        projectDir: worktree2,
        definitionOfDone: ["wt2 done"],
        plan: ["step 1"],
      },
      ws2,
      {},
    );
    assert.match(res2?.content?.[0]?.text || "", /Task Started/);

    // 5. Client 3 attempts to start a task via `junctionToMain` with a foreign PID -> MUST BE REFUSED
    const mainBucket = projectKey(canonicalProjectPath(mainRepo));
    const mainLockDir = path.join(base, "state", "projects", mainBucket);
    // Simulate that ws1's lock on mainRepo is held by foreign PID 61111
    writeFileSync(
      processLockPath({ dir: mainLockDir }),
      JSON.stringify({
        protocolVersion: LOCK_PROTOCOL_VERSION,
        pid: 61111,
        leaseId: "lease-61111-main",
        incarnationId: "inc-61111-main",
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
      "utf8",
    );
    clearHeldLeasesForTests();
    setIsAliveForTests((pid) => pid === 61111 || pid === process.pid);
    setIsHolderForTests(() => true);

    const stateFile3 = path.join(base, "state", "projects", "shared", "users", "u3", "workflow-state.ses_wt3.json");
    const ws3 = new WorkflowState(stateFile3);
    await ws3.load();
    const res3 = await handleStartTask(
      {
        description: "Attempt via junction alias to mainRepo",
        type: "feature",
        projectDir: junctionToMain,
        definitionOfDone: ["junction done"],
        plan: ["step 1"],
      },
      ws3,
      {},
    );
    assert.match(
      res3?.content?.[0]?.text || "",
      /sesi lain sedang mengerjakan proyek ini|task lain sedang berjalan/i,
      "Accessing locked worktree through a junction alias must be mutually excluded",
    );

    await ws1.close();
    await ws2.close();
    await ws3.close();
  });
});


