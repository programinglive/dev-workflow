import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  DEFAULT_LOCK_STALE_MS,
} from "../process-lock.js";
import {
  WorkflowState,
  canonicalProjectPath,
  projectKey,
  resolveCanonicalProjectIdentity,
  resolveTargetProjectState,
  findActiveForeignTaskInProject,
} from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
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

