import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  acquireWorktreeMutex,
  releaseWorktreeMutex,
  useWorktreeCapability,
  worktreeMutexEndpoint,
  kernelMutexEndpoint,
  resolveCanonicalWorktreeRoot,
  ProjectOwnershipLostError,
  projectLockDir,
  LOCK_FILENAME,
  setIsAliveForTests,
  clearHeldLeasesForTests,
} from "../process-lock.js";
import {
  WorkflowState,
  canonicalProjectPath,
  projectKey,
  pinSessionProject,
  restoreSessionPointerSnapshot,
  claimFocusBinding,
} from "../workflow-state.js";
import { resolveProjectDir } from "../exec.js";
import { handleStartTask } from "../tools/handler-modules/workflow-handlers.js";
import { closeLocalAdapters } from "../db/index.js";

function gitInit(dir) {
  const res = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git init failed in ${dir}: ${res.stderr}`);
  }
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

async function createRepo(base, name) {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  gitInit(dir);
  await writeFile(path.join(dir, "README.md"), `# ${name}\n`, "utf8");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

async function withTempWorkspace(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "optb-adv-"));
  try {
    return await fn(base);
  } finally {
    clearHeldLeasesForTests();
    setIsAliveForTests(null);
    await closeLocalAdapters();
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}

function makeStartArgs(projectDir, description = "Option B adversarial task") {
  return {
    description,
    type: "feature",
    projectDir,
    plan: ["step 1", "step 2"],
    definitionOfDone: ["verified behavior", "tests pass"],
  };
}

function sendJsonRpc(child, payload) {
  return new Promise((resolve, reject) => {
    const id = payload.id;
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            cleanup();
            resolve(msg);
          }
        } catch {}
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("error", onError);
    };
    child.stdout.on("data", onData);
    child.on("error", onError);
    child.stdin.write(JSON.stringify(payload) + "\n");
  });
}

test("Adversarial 1: Same Git working tree across two different state roots shares exact OS mutex endpoint and excludes second process", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "shared-repo");
    const stateRootA = path.join(base, "state-root-a");
    const stateRootB = path.join(base, "state-root-b");
    await mkdir(stateRootA, { recursive: true });
    await mkdir(stateRootB, { recursive: true });

    const epA = kernelMutexEndpoint({ projectDir: repo });
    const epB = kernelMutexEndpoint({ projectDir: repo });
    assert.equal(epA.supported, true);
    assert.equal(epA.path, epB.path);

    const processLockUrl = pathToFileURL(path.resolve("process-lock.js")).href;
    const childScript = `
      import { acquireWorktreeMutex } from ${JSON.stringify(processLockUrl)};
      const res = await acquireWorktreeMutex({ projectDir: process.env.TEST_PROJECT_DIR });
      process.send({ ok: res.ok, endpoint: res.endpoint, reason: res.reason || null });
      setInterval(() => {}, 1000);
    `;

    const childA = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      env: { ...process.env, DEV_WORKFLOW_STATE_ROOT: stateRootA, TEST_PROJECT_DIR: repo },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const msgA = await new Promise((resolve, reject) => {
      childA.once("message", resolve);
      childA.once("error", reject);
    });
    assert.equal(msgA.ok, true);
    assert.equal(msgA.endpoint, epA.path);

    const childB = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      env: { ...process.env, DEV_WORKFLOW_STATE_ROOT: stateRootB, TEST_PROJECT_DIR: repo },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const msgB = await new Promise((resolve, reject) => {
      childB.once("message", resolve);
      childB.once("error", reject);
    });
    assert.equal(msgB.ok, false, "Different state root must still be excluded on same Git working tree");
    assert.equal(msgB.reason, "foreign_lock");
    assert.equal(msgB.endpoint, epA.path);

    const exitA = new Promise((r) => childA.once("exit", r));
    const exitB = new Promise((r) => childB.once("exit", r));
    childA.kill("SIGKILL");
    childB.kill("SIGKILL");
    await Promise.all([exitA, exitB]);
  });
});

test("Adversarial 2: Different Git worktrees have distinct OS mutex endpoints and independent concurrent ownership", async () => {
  await withTempWorkspace(async (base) => {
    const mainRepo = await createRepo(base, "wt-main");
    const wtRepo = path.join(base, "wt-feature");
    const wtRes = spawnSync("git", ["worktree", "add", "-b", "feature/wt", wtRepo], {
      cwd: mainRepo,
      encoding: "utf8",
    });
    assert.equal(wtRes.status, 0, wtRes.stderr);

    const acqMain = await acquireWorktreeMutex({ projectDir: mainRepo });
    const acqWt = await acquireWorktreeMutex({ projectDir: wtRepo });
    try {
      assert.equal(acqMain.ok, true);
      assert.equal(acqWt.ok, true);
      assert.notEqual(acqMain.endpoint, acqWt.endpoint);
      assert.notEqual(acqMain.canonicalKey, acqWt.canonicalKey);
    } finally {
      await releaseWorktreeMutex(acqMain.capability);
      await releaseWorktreeMutex(acqWt.capability);
    }
  });
});

test("Adversarial 3: Invalid explicit projectDir below a valid Git ancestor is rejected without ancestor fallback or mutex acquisition", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "valid-ancestor");
    const nonexistentSubdir = path.join(repo, "does-not-exist", "nested");
    assert.equal(existsSync(nonexistentSubdir), false);

    assert.throws(
      () => resolveProjectDir({ explicit: nonexistentSubdir }),
      /tidak ada|not exist|bukan direktori/i,
    );

    const wtCheck = resolveCanonicalWorktreeRoot(nonexistentSubdir);
    assert.equal(wtCheck.ok, false);
    assert.equal(wtCheck.error, "PROJECT_DIR_NOT_FOUND");

    const stateFile = path.join(base, "state", "projects", "test", "users", "u1", "state.json");
    const ws = new WorkflowState(stateFile);
    ws.requireKernelMutex = true;
    await ws.load();
    try {
      const res = await handleStartTask(makeStartArgs(nonexistentSubdir), ws, null);
      const out = res?.content?.[0]?.text || "";
      assert.match(out, /Dibatalkan|Refused/i);
      assert.equal(ws.state.currentPhase, "idle");
      assert.equal(ws.boundKernelCapability, null);
    } finally {
      await ws.close();
    }
  });
});

test("Adversarial 4: Former owner attempts save, SQLite sync, session pin, and focus claim after OS mutex loss and fails closed", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "fenced-repo");
    const stateFile = path.join(
      base,
      "state",
      "projects",
      projectKey(canonicalProjectPath(repo)),
      "users",
      "owner-a",
      "workflow-state.json",
    );
    const acq = await acquireWorktreeMutex({ projectDir: repo, ownerKey: stateFile });
    assert.equal(acq.ok, true);

    const ws = new WorkflowState(stateFile);
    ws.bindKernelCapability(acq.capability);
    await ws.load();
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "Initial fenced task";
    ws.state.projectDir = repo;
    const saved = await ws.save({ allowReplaceRunningTask: true });
    assert.equal(saved.verified, true);

    // Lose OS mutex capability
    await releaseWorktreeMutex(acq.capability);

    ws.state.taskDescription = "Stale write after mutex loss";
    await assert.rejects(
      () => ws.save({ allowReplaceRunningTask: true }),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );
    await assert.rejects(
      () => ws.syncToDatabase(),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );
    assert.throws(
      () =>
        pinSessionProject({
          stateFile,
          projectDir: repo,
          kernelCapability: acq.capability,
          requireKernelMutex: true,
        }),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );
    await assert.rejects(
      () =>
        claimFocusBinding({
          stateFile,
          focusId: 99,
          projectDir: repo,
          kernelCapability: acq.capability,
          requireKernelMutex: true,
        }),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );

    await ws.close();
  });
});

test("Adversarial 5: Release requested during a suspended protected async operation waits for drain while blocking new callers", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "drain-repo");
    const acq = await acquireWorktreeMutex({ projectDir: repo });
    assert.equal(acq.ok, true);
    const cap = acq.capability;

    let resumeSuspended;
    const suspendedGate = new Promise((r) => {
      resumeSuspended = r;
    });
    let enteredInFlight;
    const enteredPromise = new Promise((r) => {
      enteredInFlight = r;
    });

    const inFlightOp = useWorktreeCapability(cap, async () => {
      enteredInFlight();
      await suspendedGate;
      assert.equal(cap.server.listening, true, "Listener must stay open while in-flight op is suspended");
      return "completed-in-flight";
    });

    await enteredPromise;
    const releasePromise = releaseWorktreeMutex(cap);
    assert.equal(cap.releaseRequested, true);
    assert.equal(cap.server.listening, true, "OS mutex must NOT close before in-flight op finishes");

    // Any new operation / detached child attempting to use the capability while releasing must fail closed
    await assert.rejects(
      () => useWorktreeCapability(cap, async () => "should-not-run"),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );

    resumeSuspended();
    const [opResult, relResult] = await Promise.all([inFlightOp, releasePromise]);
    assert.equal(opResult, "completed-in-flight");
    assert.equal(relResult, true);
    assert.equal(cap.active, false);
    assert.equal(cap.server.listening, false);
  });
});

test("Adversarial 6: Stale writer pauses, newer owner commits to SQLite, stale writer resumes and cannot overwrite newer commit", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "newer-commit-wins");
    const stateFile = path.join(
      base,
      "state",
      "projects",
      projectKey(canonicalProjectPath(repo)),
      "users",
      "shared-user",
      "workflow-state.json",
    );

    const acq1 = await acquireWorktreeMutex({ projectDir: repo, ownerKey: stateFile });
    const ws1 = new WorkflowState(stateFile);
    ws1.bindKernelCapability(acq1.capability);
    await ws1.load();
    ws1.state.currentPhase = "coding";
    ws1.state.taskDescription = "Owner 1 initial";
    ws1.state.projectDir = repo;
    await ws1.save({ allowReplaceRunningTask: true });

    // Stale snapshot taken before release
    const staleWs = new WorkflowState(stateFile);
    await staleWs.load();
    staleWs.state.taskDescription = "Stale paused task";

    await releaseWorktreeMutex(acq1.capability);

    // Newer owner acquires OS mutex and commits newer task
    const acq2 = await acquireWorktreeMutex({ projectDir: repo, ownerKey: stateFile });
    const ws2 = new WorkflowState(stateFile);
    ws2.bindKernelCapability(acq2.capability);
    await ws2.load();
    ws2.state.taskDescription = "Newer owner committed task";
    ws2.state.currentPhase = "coding";
    ws2.state.projectDir = repo;
    const saved2 = await ws2.save({ allowReplaceRunningTask: true });
    assert.equal(saved2.verified, true);
    await releaseWorktreeMutex(acq2.capability);

    // Stale writer acquires mutex later and tries to overwrite with stale stateVersion
    const acq3 = await acquireWorktreeMutex({ projectDir: repo, ownerKey: stateFile });
    staleWs.bindKernelCapability(acq3.capability);
    const staleResult = await staleWs.save();
    assert.equal(staleResult.verified, false, "Stale write must not overwrite newer committed state");
    assert.ok(staleResult.conflict);

    const verifyWs = new WorkflowState(stateFile);
    await verifyWs.load();
    assert.equal(verifyWs.state.taskDescription, "Newer owner committed task");

    await releaseWorktreeMutex(acq3.capability);
    await ws1.close();
    await ws2.close();
    await staleWs.close();
    await verifyWs.close();
  });
});

test("Adversarial 7: Process dies (SIGKILL) while holding OS mutex; successor acquires safely", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "sigkill-repo");
    const processLockUrl = pathToFileURL(path.resolve("process-lock.js")).href;
    const holderScript = `
      import { acquireWorktreeMutex } from ${JSON.stringify(processLockUrl)};
      const res = await acquireWorktreeMutex({ projectDir: process.env.TEST_PROJECT_DIR });
      process.send({ ok: res.ok, token: res.capability?.token || null });
      setInterval(() => {}, 1000);
    `;

    const holder = spawn(process.execPath, ["--input-type=module", "-e", holderScript], {
      env: { ...process.env, TEST_PROJECT_DIR: repo },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const acquired = await new Promise((resolve, reject) => {
      holder.once("message", resolve);
      holder.once("error", reject);
    });
    assert.equal(acquired.ok, true);

    const busy = await acquireWorktreeMutex({ projectDir: repo, timeoutMs: 20 });
    assert.equal(busy.ok, false);
    assert.equal(busy.reason, "foreign_lock");

    const exited = new Promise((r) => holder.once("exit", r));
    holder.kill("SIGKILL");
    await exited;

    const successor = await acquireWorktreeMutex({ projectDir: repo, timeoutMs: 100 });
    assert.equal(successor.ok, true);
    assert.notEqual(successor.capability.token, acquired.token);
    await releaseWorktreeMutex(successor.capability);
  });
});

test("Adversarial 8: Failed start_task transition preserves previous task and DoD evidence intact", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "repo-prev");
    const repoB = await createRepo(base, "repo-next");
    const stateFile = path.join(
      base,
      "state",
      "projects",
      projectKey(canonicalProjectPath(repoA)),
      "users",
      "u1",
      "workflow-state.json",
    );

    const ws = new WorkflowState(stateFile);
    ws.requireKernelMutex = true;
    await ws.load();

    const ok1 = await handleStartTask(makeStartArgs(repoA, "Original Task A"), ws, null);
    assert.match(ok1?.content?.[0]?.text || "", /Task Started/);
    ws.state.definitionOfDone[0].status = "done";
    ws.state.definitionOfDone[0].evidence = "verified-evidence-123";
    await ws.save();

    // Inject failure at beforeSave hook during transition to repoB
    const failRes = await handleStartTask(
      {
        ...makeStartArgs(repoB, "Failing Task B"),
        focusId: 88,
        allowProjectSwitch: true,
        projectSwitchReason: "Testing simulated transition failure rollback",
      },
      ws,
      null,
      {
        transitionHooks: {
          beforeSave: async () => {
            throw new Error("Simulated transition failure before SQLite commit");
          },
        },
      },
    );
    assert.match(failRes?.content?.[0]?.text || "", /gagal|failed|Simulated transition failure/i);
    assert.equal(ws.state.taskDescription, "Original Task A");
    assert.equal(ws.state.definitionOfDone[0].evidence, "verified-evidence-123");
    assert.equal(ws.state.definitionOfDone[0].status, "done");

    await ws.close();
  });
});

test("Adversarial 9: Actual CLI/stdio start_task across independent repositories from shared CWD", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "cli-repo-a");
    const repoB = await createRepo(base, "cli-repo-b");
    const sharedCwd = path.join(base, "shared-cwd");
    const stateRootA = path.join(base, "cli-state-a");
    const stateRootB = path.join(base, "cli-state-b");
    await mkdir(sharedCwd, { recursive: true });
    await mkdir(stateRootA, { recursive: true });
    await mkdir(stateRootB, { recursive: true });

    const serverEntry = path.resolve("index.js");
    const spawnServer = (stateRoot) =>
      spawn(process.execPath, [serverEntry], {
        cwd: sharedCwd,
        env: {
          ...process.env,
          DEV_WORKFLOW_STATE_ROOT: stateRoot,
          DEVWF_MONITOR_HEARTBEAT_MS: "60000",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

    const srvA = spawnServer(stateRootA);
    const srvB = spawnServer(stateRootB);
    try {
      const initReq = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      };
      await Promise.all([sendJsonRpc(srvA, initReq), sendJsonRpc(srvB, initReq)]);

      const resA = await sendJsonRpc(srvA, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "start_task", arguments: makeStartArgs(repoA, "CLI Task A") },
      });
      const resB = await sendJsonRpc(srvB, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "start_task", arguments: makeStartArgs(repoB, "CLI Task B") },
      });

      assert.match(resA?.result?.content?.[0]?.text || "", /Task Started/);
      assert.match(resB?.result?.content?.[0]?.text || "", /Task Started/);

      // Second stdio server targeting repoA (held by srvA) MUST be rejected by OS kernel mutex
      const resCollision = await sendJsonRpc(srvB, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "start_task",
          arguments: {
            ...makeStartArgs(repoA, "Colliding CLI Task A"),
            allowProjectSwitch: true,
            projectSwitchReason: "test collision",
          },
        },
      });
      assert.match(resCollision?.result?.content?.[0]?.text || "", /mutex kernel OS|Dibatalkan/i);
    } finally {
      const waitExit = (p) =>
        p.exitCode !== null || p.signalCode !== null
          ? Promise.resolve()
          : new Promise((resolve) => p.once("exit", resolve));
      const exits = Promise.all([waitExit(srvA), waitExit(srvB)]);
      srvA.kill("SIGKILL");
      srvB.kill("SIGKILL");
      await exits;
    }
  });
});

test("Adversarial 10: Legacy/new version overlap is rejected fail-closed", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "legacy-overlap-repo");
    const stateFile = path.join(
      base,
      "state",
      "projects",
      projectKey(canonicalProjectPath(repo)),
      "users",
      "u1",
      "workflow-state.json",
    );
    const lockDir = projectLockDir(stateFile);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, LOCK_FILENAME),
      JSON.stringify({
        protocolVersion: 2,
        kernelMutex: false,
        pid: 777777,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      "utf8",
    );
    setIsAliveForTests((pid) => pid === 777777 || pid === process.pid);

    const ws = new WorkflowState(stateFile);
    ws.requireKernelMutex = true;
    await ws.load();
    try {
      const res = await handleStartTask(makeStartArgs(repo, "Overlap task"), ws, null);
      const out = res?.content?.[0]?.text || "";
      assert.match(out, /legacy|protokol lama/i);
      assert.equal(ws.state.currentPhase, "idle");
    } finally {
      await ws.close();
    }
  });
});

test("Platform requirement: macOS (darwin) and unsupported platforms fail closed without TCP port fallback", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "darwin-fail-closed");
    const epDarwin = worktreeMutexEndpoint(repo, "darwin");
    assert.equal(epDarwin.supported, false);
    assert.equal(epDarwin.error, "PLATFORM_UNSUPPORTED_KERNEL_MUTEX");

    const acqDarwin = await acquireWorktreeMutex({ projectDir: repo, platform: "darwin" });
    assert.equal(acqDarwin.ok, false);
    assert.equal(acqDarwin.supported, false);
    assert.equal(acqDarwin.reason, "unsupported_platform");
    assert.equal(acqDarwin.error, "PLATFORM_UNSUPPORTED_KERNEL_MUTEX");

    const acqFreebsd = await acquireWorktreeMutex({ projectDir: repo, platform: "freebsd" });
    assert.equal(acqFreebsd.ok, false);
    assert.equal(acqFreebsd.reason, "unsupported_platform");
  });
});

test("Adversarial 11 (F1 / A5): Two distinct sessions in the same MCP process cannot share one worktree capability", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "same-pid-two-sessions");
    const bucket = projectKey(canonicalProjectPath(repo));
    const stateFile1 = path.join(base, "state", "projects", bucket, "users", "u1", "workflow-state.ses_alpha.json");
    const stateFile2 = path.join(base, "state", "projects", bucket, "users", "u1", "workflow-state.ses_beta.json");

    const ws1 = new WorkflowState(stateFile1, { sessionId: "ses_alpha" });
    const ws2 = new WorkflowState(stateFile2, { sessionId: "ses_beta" });
    ws1.requireKernelMutex = true;
    ws2.requireKernelMutex = true;
    await ws1.load();
    await ws2.load();

    try {
      const res1 = await handleStartTask(makeStartArgs(repo, "Alpha session task", 81), ws1, null);
      const out1 = res1?.content?.[0]?.text || "";
      assert.doesNotMatch(out1, /Refused|Dibatalkan/i, `Expected Alpha start_task to succeed, got: ${out1}`);
      assert.equal(ws1.state.currentPhase, "coding");

      // Session Beta in the SAME process attempts to start a task on the same worktree
      const res2 = await handleStartTask(makeStartArgs(repo, "Beta session task", 81), ws2, null);
      const out2 = res2?.content?.[0]?.text || "";
      assert.match(out2, /Dibatalkan|Refused|sesi lain/i, `Expected Beta start_task to be refused, got: ${out2}`);
      assert.equal(ws2.state.currentPhase, "idle");

      // Session Beta also CANNOT borrow Session Alpha's worktree capability via the ordinary write fence
      ws2.state.projectDir = repo;
      ws2.state.currentPhase = "coding";
      ws2.state.taskDescription = "Illicit Beta write borrowing Alpha capability";
      await assert.rejects(
        () => ws2.save({ allowReplaceRunningTask: true }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
        "Session Beta must be blocked at the write fence from borrowing Session Alpha's capability",
      );
    } finally {
      if (ws1.boundKernelCapability) {
        await releaseWorktreeMutex(ws1.boundKernelCapability);
      }
      if (ws2.boundKernelCapability) {
        await releaseWorktreeMutex(ws2.boundKernelCapability);
      }
      await ws1.close();
      await ws2.close();
    }
  });
});

test("Adversarial 12 (F2 / A7 / B7): Corrupt lock metadata and quiescence inspection errors fail closed", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "corrupt-lock-repo");
    const bucket = projectKey(canonicalProjectPath(repo));
    const stateFile = path.join(base, "state", "projects", bucket, "users", "u1", "workflow-state.json");
    const lockDir = projectLockDir(stateFile);
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, LOCK_FILENAME), "{corrupt-json-metadata", "utf8");

    const ws = new WorkflowState(stateFile);
    ws.requireKernelMutex = true;
    await ws.load();
    try {
      const res = await handleStartTask(makeStartArgs(repo, "Task with corrupt target lock", 81), ws, null);
      const out = res?.content?.[0]?.text || "";
      assert.match(out, /Dibatalkan|fail-closed|korup|tidak dapat diverifikasi/i, `Expected fail-closed refusal, got: ${out}`);
      assert.equal(ws.state.currentPhase, "idle");

      // Now remove target corrupt lock and put corrupt lock in a sibling bucket under state/projects
      await rm(path.join(lockDir, LOCK_FILENAME), { force: true });
      const siblingLockDir = path.join(base, "state", "projects", "sibling-bucket");
      await mkdir(siblingLockDir, { recursive: true });
      await writeFile(path.join(siblingLockDir, LOCK_FILENAME), "{corrupt-sibling-lock", "utf8");

      const resSibling = await handleStartTask(makeStartArgs(repo, "Task with corrupt sibling lock", 81), ws, null);
      const outSibling = resSibling?.content?.[0]?.text || "";
      assert.match(outSibling, /Dibatalkan|quiescence|fail-closed/i, `Expected quiescence fail-closed refusal, got: ${outSibling}`);
      assert.equal(ws.state.currentPhase, "idle");
    } finally {
      if (ws.boundKernelCapability) {
        await releaseWorktreeMutex(ws.boundKernelCapability);
      }
      await ws.close();
    }
  });
});

test("Adversarial 13 (A2 / A7): Invalid .git file, empty .git directory, and non-Git identity with populated paths are rejected fail-closed", async () => {
  await withTempWorkspace(async (base) => {
    const fakeRepo = path.join(base, "fake-git-file-repo");
    await mkdir(fakeRepo, { recursive: true });
    await writeFile(path.join(fakeRepo, ".git"), "not-a-valid-gitdir-pointer\n", "utf8");

    const resolved = resolveCanonicalWorktreeRoot(fakeRepo);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.error, "INVALID_GIT_WORKTREE");

    const acq = await acquireWorktreeMutex({ projectDir: fakeRepo });
    assert.equal(acq.ok, false);
    assert.equal(acq.error, "INVALID_GIT_WORKTREE");

    // Empty .git directory without HEAD must also be rejected fail-closed
    const emptyGitRepo = path.join(base, "empty-git-dir-repo");
    await mkdir(path.join(emptyGitRepo, ".git"), { recursive: true });
    const resolvedEmpty = resolveCanonicalWorktreeRoot(emptyGitRepo);
    assert.equal(resolvedEmpty.ok, false);
    assert.equal(resolvedEmpty.error, "INVALID_GIT_WORKTREE");

    const { captureRepositoryIdentity, evaluateProjectSwitch } = await import("../repository-identity.js");
    const emptyIdentity = await captureRepositoryIdentity({ dir: emptyGitRepo });
    assert.equal(emptyIdentity.isGitRepo, false);

    // evaluateProjectSwitch must reject isGitRepo: false even when path fields are populated
    const switchRefusal = evaluateProjectSwitch({
      requested: {
        isGitRepo: false,
        root: emptyGitRepo,
        workspaceKey: emptyGitRepo,
        projectDir: emptyGitRepo,
      },
      session: null,
    });
    assert.equal(switchRefusal.ok, false);
    assert.equal(switchRefusal.code, "NOT_A_GIT_REPOSITORY");

    const stateFile = path.join(base, "state", "projects", "fake", "users", "u1", "workflow-state.json");
    const ws = new WorkflowState(stateFile);
    ws.requireKernelMutex = true;
    await ws.load();
    try {
      const res = await handleStartTask(makeStartArgs(fakeRepo, "Fake git repo task", 81), ws, null);
      const out = res?.content?.[0]?.text || "";
      assert.match(out, /Refused|not a valid Git working tree|Dibatalkan/i, `Expected invalid git worktree refusal, got: ${out}`);
      assert.equal(ws.state.currentPhase, "idle");

      const resEmpty = await handleStartTask(makeStartArgs(emptyGitRepo, "Empty .git dir task", 81), ws, null);
      const outEmpty = resEmpty?.content?.[0]?.text || "";
      assert.match(outEmpty, /Refused|not a valid Git working tree|Dibatalkan/i, `Expected empty .git dir refusal, got: ${outEmpty}`);
      assert.equal(ws.state.currentPhase, "idle");
    } finally {
      await ws.close();
    }
  });
});

test("Adversarial 14 (F4 / A6 / B5): Post-SQLite-commit error preserves committed state, capability, and reconciles projections", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "post-commit-preserve-repo");
    const bucket = projectKey(canonicalProjectPath(repo));
    const stateFile = path.join(base, "state", "projects", bucket, "users", "u1", "workflow-state.ses_postcommit.json");

    const ws = new WorkflowState(stateFile, { sessionId: "ses_postcommit" });
    ws.requireKernelMutex = true;
    await ws.load();
    try {
      const res = await handleStartTask(
        makeStartArgs(repo, "Committed task surviving post-commit error", 81),
        ws,
        null,
        {
          transitionHooks: {
            afterSave: async () => {
              throw new Error("SIMULATED_POST_COMMIT_PROJECTION_ERROR");
            },
          },
        },
      );
      const out = res?.content?.[0]?.text || "";
      assert.doesNotMatch(out, /dikembalikan ke kondisi sebelum/i, "Must NOT falsely claim pre-commit rollback after SQLite commit");
      assert.equal(ws.state.currentPhase, "coding", "In-memory task state must remain committed");
      assert.equal(ws.state.taskDescription, "Committed task surviving post-commit error");
      assert.equal(ws.state.pendingProjectionRepair, null, "Verified projection repair must clear pendingProjectionRepair");
      assert.ok(ws.boundKernelCapability && ws.boundKernelCapability.active, "Target worktree capability must remain held");

      const verifyWs = new WorkflowState(ws.stateFile, { sessionId: "ses_postcommit" });
      await verifyWs.load();
      assert.equal(verifyWs.state.currentPhase, "coding");
      assert.equal(verifyWs.state.taskDescription, "Committed task surviving post-commit error");
      await verifyWs.close();
    } finally {
      if (ws.boundKernelCapability) {
        await releaseWorktreeMutex(ws.boundKernelCapability);
      }
      await ws.close();
    }
  });
});

test("Adversarial 15 (F3 / B2 / B4 / B6): Manual journal recovery requires verified worktree mutexes and refuses sync/unlocked mutations", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "journal-recovery-repo");
    const stateBase = path.join(base, "state");
    const sessionsDir = path.join(stateBase, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const journalFile = path.join(sessionsDir, "transition-ses_jrec.journal.json");

    const { reconcilePendingTransitionJournalsSync, reconcilePendingTransitionJournals } = await import("../workflow-state.js");

    // 1. Journal without verified worktree identity must fail closed and preserve journal evidence
    const unverifiedJournal = {
      journalId: "j-missing-wt",
      phase: "STAGED",
      pid: 999991,
      incarnationId: "dead-inc-j1",
      startedAt: Date.now() - 60_000,
      baseDir: stateBase,
      sessionKey: "ses_jrec",
      journalFile,
      sourceStateFile: path.join(stateBase, "projects", "b1", "users", "u1", "workflow-state.ses_jrec.json"),
      targetStateFile: path.join(stateBase, "projects", "b2", "users", "u1", "workflow-state.ses_jrec.json"),
    };
    await writeFile(journalFile, JSON.stringify(unverifiedJournal, null, 2), "utf8");
    setIsAliveForTests((pid) => pid === process.pid);

    const syncRes = reconcilePendingTransitionJournalsSync({ baseDir: stateBase });
    assert.equal(syncRes.length, 1);
    assert.equal(syncRes[0].action, "sync_recovery_unsupported_requires_async_worktree_mutex");
    assert.equal(existsSync(journalFile), true, "Sync recovery must preserve journal without mutating files");

    const asyncMissingWt = await reconcilePendingTransitionJournals({ baseDir: stateBase });
    assert.equal(asyncMissingWt.length, 1);
    assert.equal(asyncMissingWt[0].action, "rollback_failed_evidence_preserved");
    assert.equal(existsSync(journalFile), true, "Async recovery must preserve journal when worktree identity is missing");

    // 2. Journal with valid worktree identity held by a live worktree mutex owner must refuse and preserve journal
    const validJournal = {
      ...unverifiedJournal,
      journalId: "j-valid-wt",
      sourceProjectDir: repo,
      targetProjectDir: repo,
    };
    await writeFile(journalFile, JSON.stringify(validJournal, null, 2), "utf8");
    const liveMutex = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "live_owner_session" });
    assert.equal(liveMutex.ok, true);
    try {
      const busyRes = await reconcilePendingTransitionJournals({ baseDir: stateBase });
      assert.equal(busyRes.length, 1);
      assert.equal(busyRes[0].action, "rollback_failed_evidence_preserved");
      assert.equal(existsSync(journalFile), true, "Journal must be preserved while live owner holds worktree mutex");
    } finally {
      await releaseWorktreeMutex(liveMutex.capability);
    }

    // 3. Once the worktree mutex is free, async recovery acquires the worktree mutex and completes rollback
    const freeRes = await reconcilePendingTransitionJournals({ baseDir: stateBase });
    assert.equal(freeRes.length, 1);
    assert.equal(freeRes[0].action, "rolled_back");
    assert.equal(existsSync(journalFile), false);
  });
});

test("Adversarial 16 (F1): pinSessionProject, writeKernelLockMetadata, and WorkflowState reject mismatched/ownerless capabilities and invalid worktrees", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "repo-a");
    const repoB = await createRepo(base, "repo-b");
    const nonGit = path.join(base, "not-a-repo");
    await mkdir(nonGit, { recursive: true });

    const { resolveSessionKey } = await import("../workflow-state.js");
    const { writeKernelLockMetadata } = await import("../process-lock.js");

    const stateBase = path.join(base, "state");
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(stateBase, "workflow-state.json");
    const makeStateFile = (r, sid) =>
      path.join(stateBase, "projects", projectKey(canonicalProjectPath(r)), "users", sid, `workflow-state.${sid}.json`);
    const stateFileA = makeStateFile(repoA, "ses_A");
    const stateFileB = makeStateFile(repoA, "ses_B");
    const keyA = resolveSessionKey(process.env, "ses_A");
    const keyB = resolveSessionKey(process.env, "ses_B");

    const acqA = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: keyA });
    assert.equal(acqA.ok, true);
    try {
      // 1. Session B cannot use Session A's capability to overwrite B's pointer
      assert.throws(
        () =>
          pinSessionProject({
            stateFile: stateFileB,
            projectDir: repoA,
            kernelCapability: acqA.capability,
            requireKernelMutex: true,
          }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );

      // 2. Session A cannot use repoA's capability to pin repoB
      assert.throws(
        () =>
          pinSessionProject({
            stateFile: stateFileA,
            projectDir: repoB,
            kernelCapability: acqA.capability,
            requireKernelMutex: true,
          }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );

      // 3. pinSessionProject refuses calls without a live capability (no unsafe fallback)
      assert.throws(
        () =>
          pinSessionProject({
            stateFile: stateFileB,
            projectDir: repoB,
          }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );

      // 4. writeKernelLockMetadata rejects mismatched ownerKey or mismatched projectDir
      assert.throws(
        () =>
          writeKernelLockMetadata({
            dir: projectLockDir(stateFileA),
            capability: acqA.capability,
            projectDir: repoB,
          }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );
      assert.throws(
        () =>
          writeKernelLockMetadata({
            dir: projectLockDir(stateFileA),
            capability: acqA.capability,
            projectDir: repoA,
            expectedOwnerKey: keyB,
          }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );

      // 5. WorkflowState rejects ownerless capability and non-git projectDir fail-closed
      const ws = new WorkflowState(stateFileA, { sessionId: "ses_A" });
      await ws.load();
      ws.requireKernelMutex = true;
      const savedOwner = acqA.capability.ownerKey;
      acqA.capability.ownerKey = null;
      ws.bindKernelCapability(acqA.capability);
      ws.state.projectDir = repoA;
      await assert.rejects(
        () => ws.save({ allowReplaceRunningTask: true }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );
      acqA.capability.ownerKey = savedOwner;

      ws.state.projectDir = nonGit;
      await assert.rejects(
        () => ws.save({ allowReplaceRunningTask: true }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );
      await ws.close();
    } finally {
      await releaseWorktreeMutex(acqA.capability);
    }
  });
});

test("Adversarial 17 (F2): overlapping rollbackTransitionJournal calls cannot share or prematurely release a live recovery mutex", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "repo-overlap");
    const stateBase = path.join(base, "state");
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(stateBase, "workflow-state.json");
    const {
      resolveSessionKey,
      beginTransitionJournal,
      rollbackTransitionJournal,
    } = await import("../workflow-state.js");

    const stateFile = path.join(
      stateBase,
      "projects",
      projectKey(canonicalProjectPath(repo)),
      "users",
      "ses_rec_overlap",
      "workflow-state.ses_rec_overlap.json",
    );
    const ws = new WorkflowState(stateFile, { sessionId: "ses_rec_overlap" });
    await ws.load();

    const journal = await beginTransitionJournal({
      sessionKey: resolveSessionKey(process.env, "ses_rec_overlap"),
      sourceStateFile: stateFile,
      targetStateFile: stateFile,
      sourceHistoryFile: ws.historyFile,
      targetHistoryFile: ws.historyFile,
      sourceProjectDir: repo,
      targetProjectDir: repo,
      priorInMemory: { state: structuredClone(ws.state), stateVersion: ws.stateVersion, loadedTask: ws.loadedTask },
      workflowState: ws,
    });
    await ws.close();

    let enteredFirst = null;
    const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
    let releaseFirst = null;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

    let capObservedInFirst = null;
    const firstCall = rollbackTransitionJournal(journal, {
      hooks: {
        onBeforeRestore: async ({ capabilities }) => {
          capObservedInFirst = capabilities[0];
          enteredFirst();
          await firstGate;
        },
      },
    });

    await firstEntered;
    assert.ok(capObservedInFirst && capObservedInFirst.inFlightCount >= 1, "recovery must register inFlightCount via useWorktreeCapability");

    // Overlapping second call must fail closed instead of sharing the capability via re-entry
    const secondResult = await rollbackTransitionJournal(journal);
    assert.equal(secondResult, false, "overlapping recovery call must fail closed while first recovery holds mutex");
    assert.equal(capObservedInFirst.active, true, "first recovery capability must stay active");

    releaseFirst();
    const firstResult = await firstCall;
    assert.equal(firstResult, true, "first recovery call must complete cleanly");
    assert.equal(capObservedInFirst.active, false, "capability must be released after drain completes");
  });
});

test("Adversarial 18 (F3): post-commit _exportJson() === false is accounted as failed projection with pendingProjectionRepair and safe retry", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "repo-proj");
    const stateBase = path.join(base, "state");
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(stateBase, "workflow-state.json");
    const stateFile = path.join(
      stateBase,
      "projects",
      projectKey(canonicalProjectPath(repo)),
      "users",
      "ses_proj_fail",
      "workflow-state.ses_proj_fail.json",
    );
    const ws = new WorkflowState(stateFile, { sessionId: "ses_proj_fail" });
    await ws.load();

    // Force _exportJson() to return false (non-throwing I/O failure)
    const origExportJson = ws._exportJson.bind(ws);
    let failExport = true;
    ws._exportJson = async () => {
      if (failExport) return false;
      return await origExportJson();
    };

    const res1 = await handleStartTask(
      makeStartArgs(repo, "Test post-commit exportJson false accounting", 81),
      ws,
      null,
    );

    const text1 = res1?.content?.[0]?.text || "";
    assert.match(text1, /PENDING|reconcil/i, "Response must warn that post-commit projection repair is pending");
    assert.ok(ws.state.pendingProjectionRepair, "pendingProjectionRepair must be recorded on state");
    assert.ok(
      ws.state.pendingProjectionRepair.repairErrors.some((e) => e.includes("exportJson:EXPORT_RETURNED_FALSE")),
      "repairErrors must record exportJson:EXPORT_RETURNED_FALSE",
    );

    // Safe retry: restore _exportJson and start next/updated task or reconcile; pendingProjectionRepair clears
    failExport = false;
    const res2 = await handleStartTask(
      {
        ...makeStartArgs(repo, "Retry after exportJson recovers", 81),
        allowReplaceRunningTask: true,
      },
      ws,
      null,
    );
    const text2 = res2?.content?.[0]?.text || "";
    assert.doesNotMatch(text2, /projection repair is PENDING/i);
    assert.equal(ws.state.pendingProjectionRepair, null);

    await releaseWorktreeMutex(ws.boundKernelCapability);
    await ws.close();
  });
});

test("Adversarial 19 (R1): load() with legacy JSON and requireKernelMutex=true fails closed without live capability and fences adoption when held", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "repo-r1");
    const stateBase = path.join(base, "state");
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(stateBase, "workflow-state.json");

    const { resolveSessionKey } = await import("../workflow-state.js");
    const stateFile = path.join(
      stateBase,
      "projects",
      projectKey(canonicalProjectPath(repo)),
      "users",
      "ses_r1",
      "workflow-state.ses_r1.json",
    );
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(
      stateFile,
      JSON.stringify({
        currentPhase: "coding",
        taskDescription: "Legacy JSON task",
        projectDir: repo,
      }),
      "utf8",
    );

    // When another session holds the worktree mutex, load() with legacy JSON must fail closed
    const otherAcq = await acquireWorktreeMutex({
      projectDir: repo,
      ownerKey: resolveSessionKey(process.env, "ses_other_owner"),
    });
    assert.equal(otherAcq.ok, true);
    const wsUnfenced = new WorkflowState(stateFile, { sessionId: "ses_r1" });
    wsUnfenced.requireKernelMutex = true;
    try {
      await assert.rejects(
        () => wsUnfenced.load(),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );
    } finally {
      await wsUnfenced.close();
      await releaseWorktreeMutex(otherAcq.capability);
    }

    const acq = await acquireWorktreeMutex({
      projectDir: repo,
      ownerKey: resolveSessionKey(process.env, "ses_r1"),
    });
    assert.equal(acq.ok, true);
    const wsFenced = new WorkflowState(stateFile, { sessionId: "ses_r1" });
    wsFenced.bindKernelCapability(acq.capability);
    try {
      await wsFenced.load();
      assert.equal(wsFenced.state.taskDescription, "Legacy JSON task");
    } finally {
      await wsFenced.close();
      await releaseWorktreeMutex(acq.capability);
    }
  });
});

test("Adversarial 20 (R2): pinSessionProject rejects expectedOwnerKey override and newer pointer overwrite", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "repo-r2");
    const stateBase = path.join(base, "state");
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(stateBase, "workflow-state.json");

    const { resolveSessionKey } = await import("../workflow-state.js");
    const keyS1 = resolveSessionKey(process.env, "ses_s1");
    const keyS2 = resolveSessionKey(process.env, "ses_s2");
    const stateFileS2 = path.join(
      stateBase,
      "projects",
      projectKey(canonicalProjectPath(repo)),
      "users",
      "ses_s2",
      "workflow-state.ses_s2.json",
    );

    const acq1 = await acquireWorktreeMutex({ projectDir: repo, ownerKey: keyS1 });
    assert.equal(acq1.ok, true);
    try {
      assert.throws(
        () =>
          pinSessionProject({
            stateFile: stateFileS2,
            projectDir: repo,
            kernelCapability: acq1.capability,
            requireKernelMutex: true,
            expectedOwnerKey: keyS1,
          }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );
    } finally {
      await releaseWorktreeMutex(acq1.capability);
    }

    // Newer pointer protection: write pointer with newer capability, then older capability cannot overwrite it
    const acqOld = await acquireWorktreeMutex({ projectDir: repo, ownerKey: keyS2 });
    assert.equal(acqOld.ok, true);
    acqOld.capability.acquiredAt = Date.now() - 60000;
    const ptrDir = path.join(stateBase, "sessions");
    await mkdir(ptrDir, { recursive: true });
    await writeFile(
      path.join(ptrDir, `${keyS2}.json`),
      JSON.stringify({
        projectDir: repo,
        ownerKey: keyS2,
        leaseId: "newer-lease-id",
        updatedAtMs: Date.now() + 10000,
      }),
      "utf8",
    );
    try {
      const staleRes = pinSessionProject({
        stateFile: stateFileS2,
        projectDir: repo,
        kernelCapability: acqOld.capability,
        requireKernelMutex: true,
      });
      assert.equal(staleRes.ok, false);
      assert.equal(staleRes.error, "superseded_by_newer_pointer");
    } finally {
      await releaseWorktreeMutex(acqOld.capability);
    }
  });
});

test("Adversarial 21 (R3): pre-commit focus rollback failure records pendingFocusCleanup and reports incomplete rollback", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "repo-r3");
    const stateBase = path.join(base, "state");
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(stateBase, "workflow-state.json");

    const stateFile = path.join(
      stateBase,
      "projects",
      projectKey(canonicalProjectPath(repo)),
      "users",
      "ses_r3",
      "workflow-state.ses_r3.json",
    );
    const ws = new WorkflowState(stateFile, { sessionId: "ses_r3" });
    await ws.load();

    // Hold focus-991.lock so retireFocusBinding fails when pre-commit transition throws
    const lockDir = path.join(stateBase, "sessions");
    await mkdir(lockDir, { recursive: true });
    const res = await handleStartTask(
      { ...makeStartArgs(repo, "Pre-commit focus rollback failure test"), focusId: 991 },
      ws,
      null,
      {
        transitionHooks: {
          afterClaimFocus: async () => {
            await writeFile(
              path.join(lockDir, "focus-991.lock"),
              JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
              "utf8",
            );
            throw new Error("SIMULATED_PRE_COMMIT_FAILURE");
          },
        },
      },
    );

    const out = res?.content?.[0]?.text || "";
    assert.match(out, /TIDAK LENGKAP|pendingFocusCleanup/i);
    assert.ok(ws.state.pendingFocusCleanup, "pendingFocusCleanup must be recorded when retireFocusBinding fails");
    assert.equal(ws.state.pendingFocusCleanup.focusId, 991);
    await ws.close();
  });
});

test("Adversarial 22 (F1): load({ skipWrites: true }) and ensurePrimaryFile enforce capability fencing", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "adv22-f1");
    const stateBase = path.join(base, "state");
    const stateFile = path.join(stateBase, "projects", "adv22", "users", "u1", "workflow-state.s22.json");

    const ws = new WorkflowState(stateFile, {
      sessionId: "s22",
      requireKernelMutex: true,
    });
    ws.state.projectDir = repo;

    // 1. load() without a capability must not write stateFile or project-summary.json
    await ws.load({ skipWrites: true });
    assert.equal(existsSync(stateFile), false, "load({ skipWrites: true }) must not create stateFile");
    assert.equal(
      existsSync(path.join(path.dirname(stateFile), "project-summary.json")),
      false,
      "load({ skipWrites: true }) must not write project-summary.json",
    );

    // 2. ensurePrimaryFile() without a capability must fail closed
    await assert.rejects(
      () => ws.ensurePrimaryFile(),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );

    await ws.close();
  });
});

test("Adversarial 23 (F2): migration is scoped to active session/project and pre-commit start_task failure leaves legacy JSON untouched", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "adv23-f2-a");
    const repoB = await createRepo(base, "adv23-f2-b");
    const stateBase = path.join(base, "state");
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(stateBase, "workflow-state.json");

    const slugA = projectKey(canonicalProjectPath(repoA));
    const slugB = projectKey(canonicalProjectPath(repoB));
    const legacyFileA = path.join(stateBase, "projects", slugA, "users", "u1", "workflow-state.s23a.json");
    const legacyFileB = path.join(stateBase, "projects", slugB, "users", "u1", "workflow-state.s23b.json");
    await mkdir(path.dirname(legacyFileA), { recursive: true });
    await mkdir(path.dirname(legacyFileB), { recursive: true });
    await writeFile(
      legacyFileA,
      JSON.stringify({ currentPhase: "executing", taskDescription: "Legacy A", projectDir: repoA }),
      "utf8",
    );
    await writeFile(
      legacyFileB,
      JSON.stringify({ currentPhase: "executing", taskDescription: "Legacy B", projectDir: repoB }),
      "utf8",
    );

    // 1. Pre-commit failure in handleStartTask on repoA must NOT migrate or move legacyFileA or legacyFileB
    const ws = new WorkflowState(path.join(stateBase, "users", "u1", "workflow-state.s23a.json"), {
      sessionId: "s23a",
      requireKernelMutex: true,
    });
    const res = await handleStartTask(
      makeStartArgs(repoA, "Should fail before save"),
      ws,
      null,
      {
        transitionHooks: {
          beforeSave: async () => {
            throw new Error("SIMULATED_PRE_COMMIT_FAILURE_F2");
          },
        },
      },
    );
    assert.match(res?.content?.[0]?.text || "", /SIMULATED_PRE_COMMIT_FAILURE_F2|dibatalkan|rolled back/i);
    assert.equal(existsSync(legacyFileA), true, "legacyFileA must remain untouched on pre-commit failure");
    assert.equal(existsSync(legacyFileB), true, "legacyFileB must remain untouched");
    await ws.close();
  });
});

test("Adversarial 24 (F3): pinSessionProject atomically rejects stale older writer across distinct worktrees", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "adv24-f3-a");
    const repoB = await createRepo(base, "adv24-f3-b");
    const stateBase = path.join(base, "state");
    const sessionKey = "s24";
    const stateFileA = path.join(stateBase, "projects", "a", "users", "u1", `workflow-state.${sessionKey}.json`);
    const stateFileB = path.join(stateBase, "projects", "b", "users", "u1", `workflow-state.${sessionKey}.json`);

    const acqA = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: sessionKey });
    assert.equal(acqA.ok, true);
    await new Promise((r) => setTimeout(r, 25));
    const acqB = await acquireWorktreeMutex({ projectDir: repoB, ownerKey: sessionKey });
    assert.equal(acqB.ok, true);

    try {
      const resB = pinSessionProject({
        stateFile: stateFileB,
        projectDir: repoB,
        kernelCapability: acqB.capability,
        requireKernelMutex: true,
        expectedOwnerKey: sessionKey,
      });
      assert.equal(resB.ok, true);

      const resA = pinSessionProject({
        stateFile: stateFileA,
        projectDir: repoA,
        kernelCapability: acqA.capability,
        requireKernelMutex: true,
        expectedOwnerKey: sessionKey,
      });
      assert.equal(resA.ok, false);
      assert.equal(resA.error, "superseded_by_newer_pointer");
    } finally {
      await releaseWorktreeMutex(acqA.capability);
      await releaseWorktreeMutex(acqB.capability);
    }
  });
});

test("Adversarial 25 (R1/R3/R4): CLI non-start_task acquires mutex, stale _lastLoadCommittedSqlite cannot trigger post-commit mode, and restoreSessionPointerSnapshot is fenced & atomic", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "adv25-repo");
    const stateBase = path.join(base, "state", ".state");
    const env = {
      ...process.env,
      DEV_WORKFLOW_STATE_FILE: path.join(stateBase, "workflow-state.json"),
      OPENCODE_SESSION_ID: "s25",
    };

    // 1. R1: Real CLI `start_task` followed by non-start_task CLI `set_plan` from repo CWD
    const cliStart = spawnSync(
      process.execPath,
      [path.resolve("index.js"), "call", "start_task", "--args", JSON.stringify(makeStartArgs(repo, "CLI R1 task"))],
      { cwd: repo, env, encoding: "utf8" },
    );
    assert.equal(cliStart.status, 0, `CLI start_task failed: ${cliStart.stderr}\n${cliStart.stdout}`);

    const { readdir, readFile } = await import("node:fs/promises");
    const sessionsDir = path.join(stateBase, "sessions");
    const ptrFiles = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json") && !f.startsWith("focus-"));
    assert.ok(ptrFiles.length >= 1, "start_task must publish session pointer");
    const ptrFile = path.join(sessionsDir, ptrFiles[0]);
    const ptr = JSON.parse(await readFile(ptrFile, "utf8"));

    const cliPlan = spawnSync(
      process.execPath,
      [path.resolve("index.js"), "call", "set_plan", "--args", JSON.stringify({ steps: ["step A", "step B"] })],
      { cwd: repo, env, encoding: "utf8" },
    );
    assert.equal(cliPlan.status, 0, `CLI set_plan failed: ${cliPlan.stderr}\n${cliPlan.stdout}`);

    // Contending worktree mutex held by another owner must block CLI non-start_task
    const contender = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "other-holder" });
    assert.equal(contender.ok, true);
    try {
      const cliPlanBlocked = spawnSync(
        process.execPath,
        [path.resolve("index.js"), "call", "set_plan", "--args", JSON.stringify({ steps: ["step C"] })],
        { cwd: repo, env, encoding: "utf8" },
      );
      assert.notEqual(cliPlanBlocked.status, 0, "CLI set_plan must fail when another owner holds the worktree mutex");
    } finally {
      await releaseWorktreeMutex(contender.capability);
    }

    // 2. R4: restoreSessionPointerSnapshot requires live capability and preserves newer pinSessionProject
    assert.throws(
      () => restoreSessionPointerSnapshot({ applicable: true, file: ptrFile, raw: null }, { sourceProjectDir: repo, sessionKey: ptr.ownerKey }),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );

    const acq = await acquireWorktreeMutex({ projectDir: repo, ownerKey: ptr.ownerKey });
    assert.equal(acq.ok, true);
    try {
      const staleJournal = {
        sessionKey: ptr.ownerKey,
        sourceProjectDir: repo,
        startedAt: Date.now() - 60000,
      };
      const restoreRes = restoreSessionPointerSnapshot(
        { applicable: true, file: ptrFile, raw: null },
        staleJournal,
        { kernelCapability: acq.capability },
      );
      assert.equal(restoreRes.ok, true);
      assert.equal(restoreRes.skippedNewerOwner, true, "stale journal must not delete newer pointer");

      // C7-2 regression: valid newer journal removes both JSON pointer and authoritative SQLite row,
      // and never creates sessions/sessions/session-pointers.sqlite
      const freshJournal = {
        sessionKey: ptr.ownerKey,
        sourceProjectDir: repo,
        startedAtMs: Date.now() + 60000,
      };
      const appliedRes = restoreSessionPointerSnapshot(
        { applicable: true, file: ptrFile, raw: null },
        freshJournal,
        { kernelCapability: acq.capability },
      );
      assert.equal(appliedRes.ok, true);
      assert.equal(appliedRes.skippedNewerOwner, false);
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(ptrFile), false, "JSON pointer must be deleted on restore");
      assert.equal(
        existsSync(path.join(sessionsDir, "sessions", "session-pointers.sqlite")),
        false,
        "must never create nested sessions/sessions/session-pointers.sqlite",
      );
      const Database = (await import("better-sqlite3")).default;
      const ptrDb = new Database(path.join(sessionsDir, "session-pointers.sqlite"), { readonly: true });
      try {
        const row = ptrDb
          .prepare("SELECT session_key FROM session_pointers WHERE session_key = ?")
          .get(ptr.ownerKey);
        assert.equal(row, undefined, "authoritative SQLite session_pointers row must be deleted on restore");
      } finally {
        ptrDb.close();
      }
    } finally {
      await releaseWorktreeMutex(acq.capability);
    }
  });
});

test("Adversarial 26 (C8-1..C8-4): readDiskState & constructor skip pre-mutex writes, pointer restore binds destination worktree/session, and summary failure records pendingProjectionRepair", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "adv26-a");
    const repoB = await createRepo(base, "adv26-b");
    const stateBase = path.join(base, "state", ".state");
    const legacyFile = path.join(stateBase, "workflow-state.json");
    const { mkdir, writeFile, readdir } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    await mkdir(stateBase, { recursive: true });
    await writeFile(
      legacyFile,
      JSON.stringify({ currentPhase: "idle", taskDescription: "", projectDir: repoA }),
      "utf8",
    );

    const prevStateFile = process.env.DEV_WORKFLOW_STATE_FILE;
    const prevSess = process.env.OPENCODE_SESSION_ID;
    process.env.DEV_WORKFLOW_STATE_FILE = legacyFile;
    process.env.OPENCODE_SESSION_ID = "s26";
    try {
      // C8-2: new WorkflowState() must not migrate/write before mutex acquisition
      const preMutexWs = new WorkflowState(undefined, { requireKernelMutex: true });
      assert.equal(existsSync(preMutexWs.stateFile), false, "constructor must not write migrated session file");

      // C8-1: readDiskState() on corrupt state without capability fails closed without backup rename
      await mkdir(path.dirname(preMutexWs.stateFile), { recursive: true });
      await writeFile(preMutexWs.stateFile, "{corrupt-json", "utf8");
      await assert.rejects(
        () => preMutexWs.readDiskState(),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );
      const siblings = await readdir(path.dirname(preMutexWs.stateFile));
      assert.equal(
        siblings.some((f) => f.includes(".corrupt-")),
        false,
        "readDiskState without live capability must not rename corrupt file",
      );
    } finally {
      if (prevStateFile === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
      else process.env.DEV_WORKFLOW_STATE_FILE = prevStateFile;
      if (prevSess === undefined) delete process.env.OPENCODE_SESSION_ID;
      else process.env.OPENCODE_SESSION_ID = prevSess;
    }

    // C8-3: restoreSessionPointerSnapshot rejects foreign worktree and foreign session capability
    const ptrFile = path.join(stateBase, "sessions", "s26.json");
    const acqB = await acquireWorktreeMutex({ projectDir: repoB, ownerKey: "s26" });
    assert.equal(acqB.ok, true);
    try {
      assert.throws(
        () =>
          restoreSessionPointerSnapshot(
            { applicable: true, file: ptrFile, raw: null },
            { sourceProjectDir: repoA, sessionKey: "s26", startedAtMs: Date.now() },
            { kernelCapability: acqB.capability },
          ),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );
    } finally {
      await releaseWorktreeMutex(acqB.capability);
    }
    const acqForeignSess = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "other-session" });
    assert.equal(acqForeignSess.ok, true);
    try {
      assert.throws(
        () =>
          restoreSessionPointerSnapshot(
            { applicable: true, file: ptrFile, raw: null },
            { sourceProjectDir: repoA, sessionKey: "s26", startedAtMs: Date.now() },
            { kernelCapability: acqForeignSess.capability },
          ),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );
    } finally {
      await releaseWorktreeMutex(acqForeignSess.capability);
    }

    // C8-4: summary projection failure after SQLite commit records pendingProjectionRepair
    const prevState2 = process.env.DEV_WORKFLOW_STATE_FILE;
    process.env.DEV_WORKFLOW_STATE_FILE = legacyFile;
    const acqC8 = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "ses_c8_4" });
    try {
      const ws = new WorkflowState(path.join(stateBase, "users", "ses_c8_4", "workflow-state.ses_c8_4.json"), {
        sessionId: "ses_c8_4",
        requireKernelMutex: true,
        kernelCapability: acqC8.capability,
      });
      await ws.load();
      const origUpdateSummary = ws.updateProjectSummary.bind(ws);
      ws.updateProjectSummary = async () => {
        throw new Error("DISK_FULL_SUMMARY");
      };
      await handleStartTask(makeStartArgs(repoA, "C8-4 summary failure task"), ws);
      assert.ok(ws.state.pendingProjectionRepair, "summary failure must record pendingProjectionRepair");
      assert.ok(
        ws.state.pendingProjectionRepair.repairErrors.some((e) => e.includes("summaryOrHistory:DISK_FULL_SUMMARY")),
      );
      ws.updateProjectSummary = origUpdateSummary;
    } finally {
      await releaseWorktreeMutex(acqC8.capability);
      if (prevState2 === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
      else process.env.DEV_WORKFLOW_STATE_FILE = prevState2;
    }
  });
});

test("Adversarial 27 (C9-1..C9-4): cli/runtime enforces OS mutex, useSession skips migration writes, pointer restore rejects file/journal mismatch, and history failures record pendingProjectionRepair", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "adv27-repo");
    const stateBase = path.join(base, "state", ".state");
    const legacyFile = path.join(stateBase, "workflow-state.json");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    await mkdir(stateBase, { recursive: true });
    await writeFile(
      legacyFile,
      JSON.stringify({ currentPhase: "idle", taskDescription: "", projectDir: repo }),
      "utf8",
    );

    // C9-1: cli/runtime openSessionState & drop fail closed when worktree mutex is held
    const { createHandlers } = await import("../cli/runtime.js");
    const acqOwner = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "ses_c9_owner" });
    assert.equal(acqOwner.ok, true);
    const prevStateFile = process.env.DEV_WORKFLOW_STATE_FILE;
    process.env.DEV_WORKFLOW_STATE_FILE = legacyFile;
    let savedSessionFile = "";
    try {
      const wsOwner = new WorkflowState(
        path.join(stateBase, "users", "ses_c9_owner", "workflow-state.ses_c9_owner.json"),
        { sessionId: "ses_c9_owner", requireKernelMutex: true, kernelCapability: acqOwner.capability },
      );
      await wsOwner.load();
      await handleStartTask(makeStartArgs(repo, "C9-1 protected task"), wsOwner);
      savedSessionFile = wsOwner.stateFile;
    } finally {
      await releaseWorktreeMutex(acqOwner.capability);
      if (prevStateFile === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
      else process.env.DEV_WORKFLOW_STATE_FILE = prevStateFile;
    }

    const acqContender = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "ses_c9_other_session" });
    assert.equal(acqContender.ok, true);
    try {
      const handlers = createHandlers({ out: () => {} });
      await assert.rejects(
        () => handlers.drop({ file: savedSessionFile, reason: "unauthorized" }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );
    } finally {
      await releaseWorktreeMutex(acqContender.capability);
    }

    // C9-2: useSession("B") skips migration writes even when session A holds CWD mutex
    const acqCwdA = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "ses_A" });
    const prevCwd = process.cwd();
    const prevStateC9 = process.env.DEV_WORKFLOW_STATE_FILE;
    process.chdir(repo);
    process.env.DEV_WORKFLOW_STATE_FILE = legacyFile;
    try {
      const wsA = new WorkflowState(undefined, {
        sessionId: "ses_A",
        requireKernelMutex: true,
        kernelCapability: acqCwdA.capability,
      });
      await wsA.useSession("ses_B");
      assert.equal(existsSync(wsA.stateFile), false, "useSession(ses_B) must not migrate/write files before capability binding");
    } finally {
      process.chdir(prevCwd);
      if (prevStateC9 === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
      else process.env.DEV_WORKFLOW_STATE_FILE = prevStateC9;
      await releaseWorktreeMutex(acqCwdA.capability);
    }

    // C9-3: restoreSessionPointerSnapshot rejects snapshot.file (B.json) vs journal.sessionKey (A) mismatch
    const acqCapA = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "A" });
    try {
      assert.throws(
        () =>
          restoreSessionPointerSnapshot(
            { applicable: true, file: path.join(stateBase, "sessions", "B.json"), raw: null },
            { sourceProjectDir: repo, sessionKey: "A", startedAtMs: Date.now() },
            { kernelCapability: acqCapA.capability },
          ),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
      );
    } finally {
      await releaseWorktreeMutex(acqCapA.capability);
    }

    // C9-4: writeHistoryFile / _syncHistoryToDatabase failures record pendingProjectionRepair and are not cleared
    const prevState4 = process.env.DEV_WORKFLOW_STATE_FILE;
    process.env.DEV_WORKFLOW_STATE_FILE = legacyFile;
    const acqC9_4 = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "ses_c9_4" });
    try {
      const ws4 = new WorkflowState(path.join(stateBase, "users", "ses_c9_4", "workflow-state.ses_c9_4.json"), {
        sessionId: "ses_c9_4",
        requireKernelMutex: true,
        kernelCapability: acqC9_4.capability,
      });
      await ws4.load();
      ws4.writeHistoryFile = async () => {
        throw new Error("HISTORY_FILE_EIO");
      };
      ws4._syncHistoryToDatabase = async () => ({ skipped: 1, sent: 0, summaryFailed: true, summaryError: "HIST_SUM_ERR" });
      await handleStartTask(makeStartArgs(repo, "C9-4 history failure task"), ws4);
      assert.ok(ws4.state.pendingProjectionRepair, "history failure must record pendingProjectionRepair");
      assert.ok(
        ws4.state.pendingProjectionRepair.repairErrors.some((e) => e.includes("HISTORY_FILE_EIO")),
        "repairErrors must preserve writeHistoryFile error",
      );
      assert.ok(
        ws4.state.pendingProjectionRepair.repairErrors.some((e) => e.includes("syncHistoryDb:SKIPPED_1")),
        "repairErrors must preserve _syncHistoryToDatabase skipped count",
      );
    } finally {
      await releaseWorktreeMutex(acqC9_4.capability);
      if (prevState4 === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
      else process.env.DEV_WORKFLOW_STATE_FILE = prevState4;
    }
  });
});
