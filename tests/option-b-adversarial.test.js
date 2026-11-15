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
        params: {
          name: "start_task",
          arguments: makeStartArgs(repoA, "CLI Task A"),
          _meta: { "ai.opencode/sessionID": "ses_adv9_a" },
        },
      });
      const resB = await sendJsonRpc(srvB, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "start_task",
          arguments: makeStartArgs(repoB, "CLI Task B"),
          _meta: { "ai.opencode/sessionID": "ses_adv9_b" },
        },
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
          _meta: { "ai.opencode/sessionID": "ses_adv9_b" },
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

test("Adversarial 28 (C10-1..C10-6): commit/release fenced, proc-* CLI session preserved, skipWrites avoids DB creation, same-ms pointer CAS & summary repair persistence", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "adv28-a");
    const repoB = await createRepo(base, "adv28-b");
    const stateBase = path.join(base, "state", ".state");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    await mkdir(stateBase, { recursive: true });

    // C10-3: load({ skipWrites: true }) on fresh stateBase does not create SQLite DB file
    const wsSkip = new WorkflowState(
      path.join(stateBase, "users", "ses_c10_skip", "workflow-state.ses_c10_skip.json"),
      { sessionId: "ses_c10_skip", requireKernelMutex: true },
    );
    await wsSkip.load({ skipWrites: true });
    assert.equal(existsSync(path.join(stateBase, "dev-workflow.db")), false, "skipWrites must not create SQLite DB");

    // C10-1: handleCommitAndPush fails closed before git add/commit when capability is missing
    const { handleCommitAndPush } = await import("../tools/handler-modules/commit-handlers.js");
    let execCalled = false;
    wsSkip.state.projectDir = repoA;
    wsSkip.state.currentPhase = "commit";
    wsSkip.state.readyToCommit = true;
    wsSkip.state.readyCheckCompleted = true;
    wsSkip.state.taskDescription = "C10-1 task";
    wsSkip.state.definitionOfDone = [{ id: 1, text: "done", status: "done", evidence: "ok", revision: 1 }];
    wsSkip.state.dodRevision = 1;
    await assert.rejects(
      () =>
        handleCommitAndPush(
          { commitMessage: "should not run", projectDir: repoA },
          {
            workflowState: wsSkip,
            exec: async () => {
              execCalled = true;
              return { stdout: "", stderr: "" };
            },
            git: {
              getPrimaryBranch: async () => "main",
              getCurrentBranch: async () => "main",
              hasWorkingChanges: async () => true,
              getStatusOutput: async () => "M tests/file.test.js",
              getToplevel: async () => repoA,
            },
            utils: {
              createCommitMessageParts: () => ({ summary: "msg", body: "" }),
              shellEscape: (s) => s,
            },
          },
        ),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );
    assert.equal(execCalled, false, "handleCommitAndPush must not run git exec without live capability");

    // C10-2: openSessionState preserves proc-* sessionId from filename
    const { openSessionState } = await import("../cli/runtime.js");
    const procFile = path.join(stateBase, "users", "u1", "workflow-state.proc-c10.json");
    await mkdir(path.dirname(procFile), { recursive: true });
    await writeFile(procFile, JSON.stringify({ currentPhase: "idle", projectDir: repoA }), "utf8");
    const opened = await openSessionState({ file: procFile });
    try {
      assert.equal(opened.workflowState.sessionId, "proc-c10", "openSessionState must preserve proc-* sessionId");
    } finally {
      await releaseWorktreeMutex(opened.capability);
    }

    // C10-5: same-millisecond acquiredAt tie still rejects older capability via acquireSeq
    const acq1 = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "s_c10_5" });
    const acq2 = await acquireWorktreeMutex({ projectDir: repoB, ownerKey: "s_c10_5" });
    const sameMs = Date.now();
    acq1.capability.acquiredAt = sameMs;
    acq2.capability.acquiredAt = sameMs;
    try {
      const f1 = path.join(stateBase, "projects", "a", "users", "u1", "workflow-state.s_c10_5.json");
      const f2 = path.join(stateBase, "projects", "b", "users", "u1", "workflow-state.s_c10_5.json");
      const r2 = pinSessionProject({
        stateFile: f2,
        projectDir: repoB,
        kernelCapability: acq2.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "s_c10_5",
      });
      assert.equal(r2.ok, true);
      const r1 = pinSessionProject({
        stateFile: f1,
        projectDir: repoA,
        kernelCapability: acq1.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "s_c10_5",
      });
      assert.equal(r1.ok, false);
      assert.equal(r1.error, "superseded_by_newer_pointer");
    } finally {
      await releaseWorktreeMutex(acq1.capability);
      await releaseWorktreeMutex(acq2.capability);
    }

    // C10-6: _syncHistoryToDatabase retries failed summary even when sent === 0 on next call
    const wsHist = new WorkflowState(path.join(stateBase, "users", "u1", "workflow-state.s_c10_6.json"), {
      sessionId: "s_c10_6",
    });
    wsHist.state.history = [{ timestamp: new Date().toISOString(), taskDescription: "t1" }];
    let summaryShouldFail = true;
    const fakeDb = {
      insertHistoryEntry: async () => {},
      updateSummaryForUser: async () => {
        if (summaryShouldFail) throw new Error("SUMMARY_IO_ERR");
      },
    };
    const first = await wsHist._syncHistoryToDatabase(fakeDb, "u1", repoA);
    assert.equal(first.sent, 1);
    assert.equal(first.summaryFailed, true);
    const second = await wsHist._syncHistoryToDatabase(fakeDb, "u1", repoA);
    assert.equal(second.sent, 0);
    assert.equal(second.summaryFailed, true, "second call with sent=0 must still retry failed summary");
    summaryShouldFail = false;
    const third = await wsHist._syncHistoryToDatabase(fakeDb, "u1", repoA);
    assert.equal(third.summaryFailed, false, "summary repair clears once updateSummaryForUser succeeds");

    // C10-4: dangling .git symlink inside a valid Git parent repo fails closed without ancestor fallback
    const { symlink } = await import("node:fs/promises");
    const danglingChild = path.join(repoA, "dangling-git-child");
    await mkdir(danglingChild, { recursive: true });
    const symlinkType = process.platform === "win32" ? "junction" : "file";
    try {
      await symlink(path.join(danglingChild, "missing-git-target"), path.join(danglingChild, ".git"), symlinkType);
      const danglingRes = resolveCanonicalWorktreeRoot(danglingChild);
      assert.equal(danglingRes.ok, false, "dangling .git symlink must fail closed without ancestor fallback");
      assert.equal(danglingRes.error, "INVALID_GIT_WORKTREE");
    } catch (err) {
      if (err?.code !== "EPERM" && err?.code !== "ENOTSUP") throw err;
    }
  });
});

test("Adversarial 29 (Cycle 11): early push/release-lock fencing, read-only existing SQLite, cross-process stamp, startup placeholder release, CLI corrupt lock refusal & scoped summary repair", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "adv29-a");
    const repoB = await createRepo(base, "adv29-b");
    const stateBase = path.join(base, "state", ".state");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    await mkdir(stateBase, { recursive: true });

    // 1. Early no-working-changes push branch in handleCommitAndPush & acquire_release_lock / release_release_lock fail closed without capability
    const wsNoCap = new WorkflowState(
      path.join(stateBase, "users", "ses_c11_1", "workflow-state.ses_c11_1.json"),
      { sessionId: "ses_c11_1", requireKernelMutex: true },
    );
    wsNoCap.state.projectDir = repoA;
    wsNoCap.state.currentPhase = "commit";
    wsNoCap.state.readyToCommit = true;
    wsNoCap.state.readyCheckCompleted = true;
    wsNoCap.state.taskDescription = "C11-1 task";
    wsNoCap.state.definitionOfDone = [{ id: 1, text: "done", status: "done", evidence: "ok", revision: 1 }];
    wsNoCap.state.dodRevision = 1;
    let pushedEarly = false;
    const { handleCommitAndPush } = await import("../tools/handler-modules/commit-handlers.js");
    await assert.rejects(
      () =>
        handleCommitAndPush(
          { commitMessage: "no changes", projectDir: repoA },
          {
            workflowState: wsNoCap,
            exec: async () => {
              pushedEarly = true;
              return { stdout: "", stderr: "" };
            },
            git: {
              getPrimaryBranch: async () => "main",
              getCurrentBranch: async () => "main",
              hasWorkingChanges: async () => false,
              getLastCommitMessage: async () => "feat: prev",
              getHeadSha: async () => "abc1234",
              isCommitOnRemoteBranch: async () => false,
              getToplevel: async () => repoA,
            },
            utils: {
              createCommitMessageParts: () => ({ summary: "msg", body: "" }),
              shellEscape: (s) => s,
            },
          },
        ),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );
    assert.equal(pushedEarly, false, "no-working-changes branch must not push without ownership");

    const { handleAcquireReleaseLock, handleReleaseReleaseLock } = await import("../tools/handler-modules/release-handlers.js");
    await assert.rejects(
      () => handleAcquireReleaseLock({ projectDir: repoA }, { workflowState: wsNoCap }),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );
    await assert.rejects(
      () => handleReleaseReleaseLock({ projectDir: repoA, force: true }, { workflowState: wsNoCap }),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST",
    );

    // 2. Existing dev-workflow.db with no tables is opened strictly read-only on load({ skipWrites: true }) without WAL or schema migration
    const { default: Database } = await import("better-sqlite3");
    const preExistingDbPath = path.join(stateBase, "dev-workflow.db");
    const rawDb = new Database(preExistingDbPath);
    rawDb.exec("CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY);");
    rawDb.close();
    await wsNoCap.load({ skipWrites: true });
    assert.equal(existsSync(`${preExistingDbPath}-wal`), false, "skipWrites must not switch existing DB to WAL");
    const checkDb = new Database(preExistingDbPath, { readonly: true });
    const tables = checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    checkDb.close();
    assert.deepEqual(tables, ["legacy_marker"], "skipWrites must not run schema migrations on existing DB");

    // 3. Startup placeholder capability is released by useSession when metadata-selected session arrives
    const wsStartup = new WorkflowState(
      path.join(stateBase, "users", "proc-startup", "workflow-state.proc-startup.json"),
      { sessionId: "proc-startup", requireKernelMutex: true },
    );
    const startupAcq = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "proc-startup" });
    assert.equal(startupAcq.ok, true);
    startupAcq.capability._isStartupPlaceholder = true;
    wsStartup.bindKernelCapability(startupAcq.capability);
    await wsStartup.useSession("ses_first_real");
    const realAcq = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "ses_first_real" });
    assert.equal(realAcq.ok, true, "first metadata-selected session must not be stranded by startup placeholder");
    await releaseWorktreeMutex(realAcq.capability);

    // 4. CLI openSessionState refuses corrupt mcp-process.lock fail-closed
    const { openSessionState } = await import("../cli/runtime.js");
    const badStateFile = path.join(stateBase, "users", "u_corrupt", "workflow-state.ses_corrupt.json");
    await mkdir(path.dirname(badStateFile), { recursive: true });
    await writeFile(badStateFile, JSON.stringify({ currentPhase: "coding", projectDir: repoA }), "utf8");
    await writeFile(path.join(stateBase, "mcp-process.lock"), "{corrupt-json", "utf8");
    await assert.rejects(
      () => openSessionState({ file: badStateFile }),
      (err) => err instanceof ProjectOwnershipLostError,
    );

    // 5. _syncHistoryToDatabase scopes summary repair per project and honors persisted pendingProjectionRepair
    const wsScoped = new WorkflowState(
      path.join(stateBase, "users", "u1", "workflow-state.ses_scoped.json"),
      { sessionId: "ses_scoped" },
    );
    wsScoped.state.history = [{ timestamp: new Date().toISOString(), taskDescription: "tA" }];
    let failProjA = true;
    const retriedProjects = [];
    const scopedDb = {
      insertHistoryEntry: async () => {},
      updateSummaryForUser: async (_u, proj) => {
        retriedProjects.push(proj);
        if (proj === repoA && failProjA) throw new Error("PROJ_A_SUMMARY_ERR");
      },
    };
    const rA1 = await wsScoped._syncHistoryToDatabase(scopedDb, "u1", repoA);
    assert.equal(rA1.summaryFailed, true);
    const rB = await wsScoped._syncHistoryToDatabase(scopedDb, "u1", repoB);
    assert.equal(rB.summaryFailed, false);
    const rA2 = await wsScoped._syncHistoryToDatabase(scopedDb, "u1", repoA);
    assert.equal(rA2.sent, 0);
    assert.equal(rA2.summaryFailed, true, "project B success must not clear project A pending repair");
    failProjA = false;
    const rA3 = await wsScoped._syncHistoryToDatabase(scopedDb, "u1", repoA);
    assert.equal(rA3.summaryFailed, false, "project A repair succeeds once unblocked");
  });
});

test("Adversarial 30 (Cycle 12): projectDir override to repoB refused, pointer stores acquiredAt tuple, and summary repair survives restart", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "adv30-a");
    const repoB = await createRepo(base, "adv30-b");
    const stateBase = path.join(base, "state", ".state");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateBase, { recursive: true });

    // 1. commit_and_push({ projectDir: repoB }) on a task bound to repoA is refused before any git exec
    const acqA = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "ses_c12_1" });
    assert.equal(acqA.ok, true);
    try {
      const wsA = new WorkflowState(
        path.join(stateBase, "users", "u1", "workflow-state.ses_c12_1.json"),
        { sessionId: "ses_c12_1", requireKernelMutex: true },
      );
      wsA.bindKernelCapability(acqA.capability);
      wsA.state.projectDir = repoA;
      wsA.state.currentPhase = "commit";
      wsA.state.readyToCommit = true;
      wsA.state.readyCheckCompleted = true;
      wsA.state.taskDescription = "C12-1 task";
      wsA.state.definitionOfDone = [{ id: 1, text: "done", status: "done", evidence: "ok", revision: 1 }];
      wsA.state.dodRevision = 1;
      const { handleCommitAndPush } = await import("../tools/handler-modules/commit-handlers.js");
      let execRan = false;
      const res = await handleCommitAndPush(
        { commitMessage: "cross-repo", projectDir: repoB },
        {
          workflowState: wsA,
          exec: async () => {
            execRan = true;
            return { stdout: "", stderr: "" };
          },
          git: {
            getPrimaryBranch: async () => "main",
            getCurrentBranch: async () => "main",
            hasWorkingChanges: async () => true,
            getStatusOutput: async () => "M tests/file.test.js",
            getToplevel: async () => repoB,
          },
          utils: {
            createCommitMessageParts: () => ({ summary: "msg", body: "" }),
            shellEscape: (s) => s,
          },
        },
      );
      assert.equal(execRan, false, "cross-repo projectDir override must be refused before git exec");
      assert.match(res.content[0].text, /Refused|BERBEDA|dibatalkan/i);
    } finally {
      await releaseWorktreeMutex(acqA.capability);
    }

    // 2. pinSessionProject persists cap.acquiredAt as updatedAtMs (immune to wall-clock rollback)
    const acqOld = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "ses_c12_2" });
    const acqNew = await acquireWorktreeMutex({ projectDir: repoB, ownerKey: "ses_c12_2" });
    const fixedMs = Date.now() + 50000;
    acqOld.capability.acquiredAt = fixedMs;
    acqOld.capability.acquireSeq = 1;
    acqNew.capability.acquiredAt = fixedMs;
    acqNew.capability.acquireSeq = 2;
    try {
      const fOld = path.join(stateBase, "projects", "a", "users", "u1", "workflow-state.ses_c12_2.json");
      const fNew = path.join(stateBase, "projects", "b", "users", "u1", "workflow-state.ses_c12_2.json");
      const pNew = pinSessionProject({
        stateFile: fNew,
        projectDir: repoB,
        kernelCapability: acqNew.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "ses_c12_2",
      });
      assert.equal(pNew.ok, true);
      const pOld = pinSessionProject({
        stateFile: fOld,
        projectDir: repoA,
        kernelCapability: acqOld.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "ses_c12_2",
      });
      assert.equal(pOld.ok, false);
      assert.equal(pOld.error, "superseded_by_newer_pointer");
    } finally {
      await releaseWorktreeMutex(acqOld.capability);
      await releaseWorktreeMutex(acqNew.capability);
    }

    // 3. Summary repair persists via pendingProjectionRepair.repairErrors across fresh WorkflowState instance
    const wsRestart = new WorkflowState(
      path.join(stateBase, "users", "u1", "workflow-state.ses_c12_3.json"),
      { sessionId: "ses_c12_3" },
    );
    wsRestart.state.history = [{ timestamp: new Date().toISOString(), taskDescription: "tRestart" }];
    wsRestart.state.pendingProjectionRepair = {
      failedAt: new Date().toISOString(),
      triggerError: "post_commit",
      repairErrors: ["syncHistorySummary:DISK_FULL"],
    };
    wsRestart._syncedHistoryCount = 1;
    let retriedAfterRestart = false;
    const restartRes = await wsRestart._syncHistoryToDatabase(
      {
        insertHistoryEntry: async () => {},
        updateSummaryForUser: async () => {
          retriedAfterRestart = true;
        },
      },
      "u1",
      repoA,
    );
    assert.equal(restartRes.sent, 0);
    assert.equal(retriedAfterRestart, true, "persisted syncHistorySummary repairError must trigger retry even when sent === 0");
  });
});

test("Adversarial 31 (Cycle 13): ref: without target rejected, skipWrites does not write user-id, and save() persists summary repair marker across restart", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "adv31-a");
    const stateBase = path.join(base, "state", ".state");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    await mkdir(stateBase, { recursive: true });

    // 1. .git/HEAD containing "ref:" without target fails closed before acquiring mutex
    const emptyRefRepo = path.join(base, "bad-ref-repo");
    await mkdir(path.join(emptyRefRepo, ".git"), { recursive: true });
    await writeFile(path.join(emptyRefRepo, ".git", "HEAD"), "ref:\n", "utf8");
    const wtBad = resolveCanonicalWorktreeRoot(emptyRefRepo);
    assert.equal(wtBad.ok, false, "ref: without target must be rejected");
    assert.equal(wtBad.error, "INVALID_GIT_WORKTREE");

    // 2. load({ skipWrites: true }) with DEV_WORKFLOW_USER_ID unset does not write user-id file
    const savedEnvUserId = process.env.DEV_WORKFLOW_USER_ID;
    delete process.env.DEV_WORKFLOW_USER_ID;
    try {
      const noWriteStateBase = path.join(base, "nowrite-state", ".state");
      const wsReadOnly = new WorkflowState(
        path.join(noWriteStateBase, "users", "u_ro", "workflow-state.ses_ro.json"),
        { sessionId: "ses_ro", requireKernelMutex: true },
      );
      await wsReadOnly.load({ skipWrites: true });
      assert.equal(
        existsSync(path.join(noWriteStateBase, "user-id")),
        false,
        "load({ skipWrites: true }) must not write user-id file",
      );
    } finally {
      if (savedEnvUserId !== undefined) process.env.DEV_WORKFLOW_USER_ID = savedEnvUserId;
    }

    // 3. save() with updateSummaryForUser failure persists pendingHistorySummaryRepairKeys into SQLite across restart
    const acq = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "ses_c13_repair" });
    assert.equal(acq.ok, true);
    try {
      const stateFile = path.join(stateBase, "projects", "adv31", "users", "u1", "workflow-state.ses_c13_repair.json");
      let failSummary = true;
      let summaryCalls = 0;
      const { SqliteAdapter } = await import("../db/adapters/sqlite.js");
      const db1 = new SqliteAdapter({ stateFile });
      await db1.connect();
      const origInsert1 = db1.insertHistoryEntry.bind(db1);
      const origUpdate1 = db1.updateSummaryForUser.bind(db1);
      let inInsert = false;
      db1.insertHistoryEntry = async (...iArgs) => {
        inInsert = true;
        try {
          return await origInsert1(...iArgs);
        } finally {
          inInsert = false;
        }
      };
      db1.updateSummaryForUser = async (...uArgs) => {
        if (inInsert) return origUpdate1(...uArgs);
        summaryCalls += 1;
        if (failSummary) throw new Error("C13_SUMMARY_FAIL");
        return origUpdate1(...uArgs);
      };
      const ws1 = new WorkflowState(stateFile, {
        sessionId: "ses_c13_repair",
        requireKernelMutex: true,
        db: db1,
      });
      ws1.bindKernelCapability(acq.capability);
      await ws1.load();
      ws1.state.projectDir = repoA;
      ws1.state.history = [{ timestamp: new Date().toISOString(), taskDescription: "c13-t1" }];
      await ws1.save();
      assert.equal(summaryCalls, 1);
      await db1.close();

      // Simulate restart: new SqliteAdapter and new WorkflowState loading from SQLite
      failSummary = false;
      const db2 = new SqliteAdapter({ stateFile });
      await db2.connect();
      const origUpdate2 = db2.updateSummaryForUser.bind(db2);
      db2.updateSummaryForUser = async (...uArgs) => {
        summaryCalls += 1;
        return origUpdate2(...uArgs);
      };
      const ws2 = new WorkflowState(stateFile, {
        sessionId: "ses_c13_repair",
        requireKernelMutex: true,
        db: db2,
      });
      ws2.bindKernelCapability(acq.capability);
      await ws2.load();
      await ws2.save();
      assert.equal(summaryCalls, 2, "persisted summary repair marker must trigger retry after restart even with sent === 0");
      assert.equal(ws2.state.pendingHistorySummaryRepairKeys, undefined);
      await db2.close();
    } finally {
      await releaseWorktreeMutex(acq.capability);
    }
  });
});

test("Adversarial 32 (Cycle 14): retireFocusBinding fenced, pendingFocusCleanup preserved/persisted, skipWrites avoids user-id, preflight throw releases mutex, HEAD hex length exact", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "adv32-a");
    const repoB = await createRepo(base, "adv32-b");
    const stateBase = path.join(base, "state", ".state");
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { resolveCanonicalWorktreeRoot } = await import("../process-lock.js");
    const {
      claimFocusBinding,
      retireFocusBinding,
      readFocusBinding,
      resolveStateFile,
      resolveTargetProjectState,
    } = await import("../workflow-state.js");
    await mkdir(stateBase, { recursive: true });

    // 1. 41-char HEAD is rejected by resolveCanonicalWorktreeRoot
    const badGitRepo = path.join(base, "bad-head-repo");
    await mkdir(path.join(badGitRepo, ".git"), { recursive: true });
    await writeFile(path.join(badGitRepo, ".git", "HEAD"), `${"a".repeat(41)}\n`, "utf8");
    const badRoot = resolveCanonicalWorktreeRoot(badGitRepo);
    assert.equal(badRoot.ok, false, "41-char hex HEAD must be rejected");
    assert.match(badRoot.error || "", /INVALID_PROJECT_DIR|INVALID_GIT/i, "41-char hex HEAD must fail with invalid project/git error");

    // 2. resolveStateFile({ skipMigrationWrites: true }) and resolveTargetProjectState({ skipWrites: true }) create no user-id
    const noWriteBase = path.join(base, "nowrite-c14");
    await mkdir(noWriteBase, { recursive: true });
    const prevUserId = process.env.DEV_WORKFLOW_USER_ID;
    const prevStateEnv = process.env.DEV_WORKFLOW_STATE_FILE;
    delete process.env.DEV_WORKFLOW_USER_ID;
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(noWriteBase, "workflow-state.json");
    try {
      const resolvedFile = resolveStateFile({ skipMigrationWrites: true });
      assert.equal(existsSync(path.join(noWriteBase, "user-id")), false, "resolveStateFile({ skipMigrationWrites: true }) must not create user-id");
      resolveTargetProjectState({ stateFile: resolvedFile, projectDir: repoA, skipWrites: true });
      assert.equal(existsSync(path.join(noWriteBase, "user-id")), false, "resolveTargetProjectState({ skipWrites: true }) must not create user-id");
    } finally {
      if (prevUserId !== undefined) process.env.DEV_WORKFLOW_USER_ID = prevUserId;
      if (prevStateEnv === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
      else process.env.DEV_WORKFLOW_STATE_FILE = prevStateEnv;
    }

    // 3. retireFocusBinding enforces kernelCapability/requireKernelMutex and projectDir binding match
    const stateFileA = path.join(stateBase, "projects", "adv32a", "users", "u1", "workflow-state.ses_c14_retire.json");
    const acqA = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "ses_c14_retire" });
    const acqB = await acquireWorktreeMutex({ projectDir: repoB, ownerKey: "ses_c14_retire" });
    try {
      const claimRes = await claimFocusBinding({
        stateFile: stateFileA,
        focusId: 93201,
        projectDir: repoA,
        kernelCapability: acqA.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "ses_c14_retire",
      });
      assert.equal(claimRes.ok, true);

      await assert.rejects(
        () =>
          retireFocusBinding({
            stateFile: stateFileA,
            focusId: 93201,
            projectDir: repoA,
            requireKernelMutex: true,
            expectedOwnerKey: "wrong_owner",
          }),
        /capability|owner|mutex/i,
        "retireFocusBinding must reject missing/mismatched capability when requireKernelMutex is true",
      );

      const wrongProjectRetire = await retireFocusBinding({
        stateFile: stateFileA,
        focusId: 93201,
        projectDir: repoB,
        kernelCapability: acqB.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "ses_c14_retire",
      });
      assert.equal(wrongProjectRetire.ok, false);
      assert.equal(wrongProjectRetire.reason, "FOCUS_BOUND_TO_ANOTHER_PROJECT");
      assert.ok(readFocusBinding({ stateFile: stateFileA, focusId: 93201 }), "binding must remain intact");

      const okRetire = await retireFocusBinding({
        stateFile: stateFileA,
        focusId: 93201,
        projectDir: repoA,
        kernelCapability: acqA.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "ses_c14_retire",
      });
      assert.equal(okRetire.ok, true);
      assert.equal(okRetire.retired, true);
    } finally {
      await releaseWorktreeMutex(acqA.capability);
      await releaseWorktreeMutex(acqB.capability);
    }

    // 4. runPreflight throwing (e.g., README.md is a directory) must release targetMutex.capability
    const readmeDir = path.join(repoA, "README.md");
    await rm(readmeDir, { recursive: true, force: true });
    await mkdir(readmeDir, { recursive: true });
    const prevState4 = process.env.DEV_WORKFLOW_STATE_FILE;
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(stateBase, "workflow-state.json");
    try {
      const wsPreflight = new WorkflowState(
        path.join(stateBase, "projects", "adv32a", "users", "u1", "workflow-state.ses_c14_preflight.json"),
        { sessionId: "ses_c14_preflight", requireKernelMutex: true },
      );
      await wsPreflight.load();
      const resPreflight = await handleStartTask(makeStartArgs(repoA, "preflight throw test"), wsPreflight);
      assert.ok(resPreflight.content[0].text.includes("PREFLIGHT_ERROR") || resPreflight.content[0].text.includes("Task not started"));
      const verifyUnlocked = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "ses_c14_other" });
      assert.equal(verifyUnlocked.ok, true, "mutex must not leak if runPreflight throws");
      await releaseWorktreeMutex(verifyUnlocked.capability);
    } finally {
      await rm(readmeDir, { recursive: true, force: true });
      if (prevState4 === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
      else process.env.DEV_WORKFLOW_STATE_FILE = prevState4;
    }

    // 5. pendingFocusCleanup persists across rollback and survives reset() if retry fails
    const prevState5 = process.env.DEV_WORKFLOW_STATE_FILE;
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(stateBase, "workflow-state.json");
    try {
      const wsCleanup = new WorkflowState(
        path.join(stateBase, "projects", "adv32b", "users", "u1", "workflow-state.ses_c14_cleanup.json"),
        { sessionId: "ses_c14_cleanup", requireKernelMutex: true },
      );
      await wsCleanup.load();
      const acqCleanup = await acquireWorktreeMutex({ projectDir: repoB, ownerKey: "ses_c14_cleanup" });
      wsCleanup.bindKernelCapability(acqCleanup.capability);
      wsCleanup.state.pendingFocusCleanup = {
        focusId: 93202,
        stateFile: wsCleanup.stateFile,
        projectDir: repoB,
        error: "SIMULATED_PRIOR_CLEANUP_FAILURE",
        failedAt: new Date().toISOString(),
      };
      await claimFocusBinding({
        stateFile: wsCleanup.stateFile,
        focusId: 93202,
        projectDir: repoA,
      });
      await releaseWorktreeMutex(acqCleanup.capability);

      const resCleanup = await handleStartTask(makeStartArgs(repoB, "retry cleanup survives reset"), wsCleanup);
      assert.ok(!resCleanup.content[0].text.includes("Refused"), "task should start even if pending cleanup still blocked");
      assert.ok(
        wsCleanup.state.pendingFocusCleanup && wsCleanup.state.pendingFocusCleanup.focusId === 93202,
        "pendingFocusCleanup must survive reset() when retry fails",
      );
    } finally {
      if (prevState5 === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
      else process.env.DEV_WORKFLOW_STATE_FILE = prevState5;
    }
  });
});

test("Adversarial 33 (Cycle 15): same-repoKey different-worktree retire rejected, focus revalidates cap after lock wait, ordinary save persists pendingProjectionRepair", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "adv33-a");
    const repoB = await createRepo(base, "adv33-b");
    const stateBase = path.join(base, "state", ".state");
    const { mkdir } = await import("node:fs/promises");
    const { claimFocusBinding, retireFocusBinding, readFocusBinding } = await import("../workflow-state.js");
    const { SqliteAdapter } = await import("../db/adapters/sqlite.js");
    await mkdir(stateBase, { recursive: true });

    // 1. Same repoKey across different worktree directories cannot retire another worktree's focus binding
    const stateFileA = path.join(stateBase, "projects", "adv33a", "users", "u1", "workflow-state.ses_c15_f.json");
    const acqA = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "ses_c15_f" });
    const acqB = await acquireWorktreeMutex({ projectDir: repoB, ownerKey: "ses_c15_f" });
    try {
      const claim = await claimFocusBinding({
        stateFile: stateFileA,
        focusId: 93301,
        projectDir: repoA,
        repoKey: "shared-remote-key",
        kernelCapability: acqA.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "ses_c15_f",
      });
      assert.equal(claim.ok, true);

      const crossDirRetire = await retireFocusBinding({
        stateFile: stateFileA,
        focusId: 93301,
        projectDir: repoB,
        repoKey: "shared-remote-key",
        kernelCapability: acqB.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "ses_c15_f",
      });
      assert.equal(crossDirRetire.ok, false);
      assert.equal(crossDirRetire.reason, "FOCUS_BOUND_TO_ANOTHER_PROJECT");
      assert.ok(readFocusBinding({ stateFile: stateFileA, focusId: 93301 }), "binding must remain intact");
    } finally {
      await releaseWorktreeMutex(acqA.capability);
      await releaseWorktreeMutex(acqB.capability);
    }

    // 2. Ordinary save() persists pendingProjectionRepair to SQLite across restart when _exportJson() / writeHistoryFile() fails
    const acqSave = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "ses_c15_proj" });
    try {
      const sf = path.join(stateBase, "projects", "adv33a", "users", "u1", "workflow-state.ses_c15_proj.json");
      const db1 = new SqliteAdapter({ stateFile: sf });
      await db1.connect();
      const ws1 = new WorkflowState(sf, { sessionId: "ses_c15_proj", requireKernelMutex: true, db: db1 });
      ws1.bindKernelCapability(acqSave.capability);
      await ws1.load();
      ws1.state.projectDir = repoA;
      ws1._exportJson = async () => false;
      ws1.writeHistoryFile = async () => {
        throw new Error("C15_HIST_ERR");
      };
      await ws1.save();
      assert.ok(ws1.state.pendingProjectionRepair, "ordinary save() must record pendingProjectionRepair");
      await db1.close();

      const db2 = new SqliteAdapter({ stateFile: sf });
      await db2.connect();
      const ws2 = new WorkflowState(sf, { sessionId: "ses_c15_proj", requireKernelMutex: true, db: db2 });
      ws2.bindKernelCapability(acqSave.capability);
      await ws2.load();
      assert.ok(
        ws2.state.pendingProjectionRepair &&
          Array.isArray(ws2.state.pendingProjectionRepair.errors) &&
          ws2.state.pendingProjectionRepair.errors.some((e) => e.includes("EXPORT_RETURNED_FALSE")),
        "pendingProjectionRepair must survive SQLite reload/restart",
      );
      await ws2.save();
      assert.equal(ws2.state.pendingProjectionRepair, undefined, "clean save() must clear pendingProjectionRepair");
      await db2.close();
    } finally {
      await releaseWorktreeMutex(acqSave.capability);
    }
  });
});

test("Adversarial 34 (Cycle 16): sessionKey collision-free, multi-line HEAD rejected, retire requires target, save preserves transition repairErrors, same-ms restore respects acquireSeq", async () => {
  await withTempWorkspace(async (base) => {
    const repoA = await createRepo(base, "adv34-a");
    const stateBase = path.join(base, "state", ".state");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { canonicalSessionKey, resolveSessionKeyWithSource } = await import("../db/session-key.js");
    const { resolveCanonicalWorktreeRoot } = await import("../process-lock.js");
    const {
      claimFocusBinding,
      retireFocusBinding,
      pinSessionProject,
      restoreSessionPointerSnapshot,
    } = await import("../workflow-state.js");
    const { SqliteAdapter } = await import("../db/adapters/sqlite.js");
    await mkdir(stateBase, { recursive: true });

    // 1. F6: session/a vs session?a and derived key vs raw key must not collide
    const keySlash = canonicalSessionKey("session/a");
    assert.notEqual(
      keySlash,
      canonicalSessionKey("session?a"),
      "distinct punctuation session keys must not collide",
    );
    assert.notEqual(
      keySlash,
      canonicalSessionKey(keySlash),
      "raw identity equal to a hashed output must not collide with the hashed identity",
    );
    assert.notEqual(
      resolveSessionKeyWithSource({}, "session/a").key,
      resolveSessionKeyWithSource({}, "session?a").key,
      "resolveSessionKeyWithSource must preserve distinct session identities",
    );
    assert.equal(canonicalSessionKey("ses_plain-1"), "ses_plain-1", "safe <=64-char keys stay unchanged");

    // 2. F8: multi-line HEAD (both trailing line and ref:\nrefs/...) rejected
    const badHeadRepo = path.join(base, "bad-multiline-head");
    await mkdir(path.join(badHeadRepo, ".git"), { recursive: true });
    await writeFile(path.join(badHeadRepo, ".git", "HEAD"), "ref: refs/heads/main\nextra line\n", "utf8");
    const badRes = resolveCanonicalWorktreeRoot(badHeadRepo);
    assert.equal(badRes.ok, false, "multi-line HEAD must be rejected fail-closed");
    await writeFile(path.join(badHeadRepo, ".git", "HEAD"), "ref:\nrefs/heads/main\n", "utf8");
    assert.equal(resolveCanonicalWorktreeRoot(badHeadRepo).ok, false, "ref:\\nrefs/... must be rejected fail-closed");

    // 3. F2 & F4: retire without projectDir/repoKey rejected when fenced; save() preserves transition repairErrors
    const acq = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: "ses_c16" });
    try {
      const sf = path.join(stateBase, "projects", "adv34a", "users", "u1", "workflow-state.ses_c16.json");
      await claimFocusBinding({
        stateFile: sf,
        focusId: 93401,
        projectDir: repoA,
        kernelCapability: acq.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "ses_c16",
      });
      const noTargetRetire = await retireFocusBinding({
        stateFile: sf,
        focusId: 93401,
        kernelCapability: acq.capability,
        requireKernelMutex: true,
        expectedOwnerKey: "ses_c16",
      });
      assert.equal(noTargetRetire.ok, false);
      assert.equal(noTargetRetire.reason, "FOCUS_BOUND_TO_ANOTHER_PROJECT");

      const db = new SqliteAdapter({ stateFile: sf });
      await db.connect();
      const ws = new WorkflowState(sf, { sessionId: "ses_c16", requireKernelMutex: true, db });
      ws.bindKernelCapability(acq.capability);
      await ws.load();
      ws.state.projectDir = repoA;
      ws.state.pendingProjectionRepair = {
        failedAt: new Date().toISOString(),
        triggerError: "POINTER_FAIL",
        repairErrors: ["pointerUpdateFailed"],
      };
      await ws.save();
      assert.ok(
        ws.state.pendingProjectionRepair?.repairErrors?.includes("pointerUpdateFailed"),
        "clean ordinary save must preserve unresolved transition repairErrors",
      );
      await db.close();

      // 4. F3: same-ms restore with lower acquireSeq cannot overwrite newer pointer with higher acquireSeq
      const repoB = await createRepo(base, "adv34-b");
      const acqB = await acquireWorktreeMutex({ projectDir: repoB, ownerKey: "ses_c16" });
      try {
        const ptrDir = path.join(stateBase, "sessions");
        await mkdir(ptrDir, { recursive: true });
        const sameMs = Date.now();
        const pinOld = await pinSessionProject({
          stateFile: sf,
          projectDir: repoA,
          projectDirPath: path.join(stateBase, "projects", "adv34a"),
          kernelCapability: acq.capability,
          requireKernelMutex: true,
          expectedOwnerKey: "ses_c16",
          nowMs: sameMs,
        });
        assert.equal(pinOld.ok, true);
        const ptrFile = path.join(ptrDir, "ses_c16.json");
        const { readFile } = await import("node:fs/promises");
        const snapRaw = await readFile(ptrFile, "utf8");
        const sfB = path.join(stateBase, "projects", "adv34b", "users", "u1", "workflow-state.ses_c16.json");
        const pinNew = await pinSessionProject({
          stateFile: sfB,
          projectDir: repoB,
          projectDirPath: path.join(stateBase, "projects", "adv34b"),
          kernelCapability: acqB.capability,
          requireKernelMutex: true,
          expectedOwnerKey: "ses_c16",
          nowMs: sameMs,
        });
        assert.equal(pinNew.ok, true);
        const restoreRes = restoreSessionPointerSnapshot(
          { applicable: true, file: ptrFile, raw: snapRaw },
          { startedAtMs: sameMs, acquireSeq: acq.capability.acquireSeq },
          { kernelCapability: acq.capability },
        );
        assert.equal(restoreRes.skippedNewerOwner, true, "same-ms older acquireSeq snapshot must not overwrite newer pointer");
      } finally {
        await releaseWorktreeMutex(acqB.capability);
      }
    } finally {
      await releaseWorktreeMutex(acq.capability);
    }
  });
});

test("Adversarial 35 (Cycle 18): canonical hashed keys never re-hashed or colliding, unconditional retireFocusBinding target check, and SQLite-serialized stale focus lock recovery", async () => {
  await withTempWorkspace(async (base) => {
    const stateBase = path.join(base, "state-c18");
    const repoA = await createRepo(base, "adv35-a");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { resolveStateFile, resolveTargetProjectState, pinSessionProject, claimFocusBinding, retireFocusBinding, readFocusBinding } =
      await import("../workflow-state.js");
    const rawSlashId = "org/repo:ses#1";
    const resolvedInitial = resolveStateFile({ sessionId: rawSlashId, stateDir: stateBase });
    const hashedFile = path.basename(resolvedInitial);
    const hashedKey = /^workflow-state\.(.+)\.json$/.exec(hashedFile)?.[1];
    assert.ok(hashedKey && /-h[0-9a-f]{10}$/.test(hashedKey), `expected hashed key, got ${hashedKey}`);

    // 1. Literal hashed-looking raw ID must not collide with routed hashed key
    const literalCollisionCandidate = resolveStateFile({ sessionId: hashedKey, stateDir: stateBase });
    assert.notEqual(
      path.basename(literalCollisionCandidate),
      hashedFile,
      "literal -h<10hex> raw session ID must not collide with hashed raw session ID",
    );

    // 2. WorkflowState constructed from routed stateFile must NOT re-hash canonical key
    const ws = new WorkflowState(resolvedInitial);
    assert.equal(ws._sessionKey().key, hashedKey, "WorkflowState._sessionKey() must preserve canonical hashed key without re-hashing");

    // 3. resolveTargetProjectState and pinSessionProject must NOT re-hash canonical key
    const acq = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: hashedKey });
    try {
      const routed = resolveTargetProjectState({
        stateFile: path.join(stateBase, "projects", "dummy", "users", "u1", hashedFile),
        projectDir: repoA,
        skipWrites: true,
      });
      assert.equal(
        path.basename(routed.stateFile),
        hashedFile,
        "resolveTargetProjectState must preserve canonical hashed filename",
      );
      const pinned = await pinSessionProject({
        stateFile: routed.stateFile,
        projectDir: repoA,
        projectDirPath: routed.projectDirPath,
        kernelCapability: acq.capability,
        requireKernelMutex: true,
        expectedOwnerKey: hashedKey,
      });
      assert.equal(pinned.ok, true);
      assert.equal(
        path.basename(pinned.stateFile),
        hashedFile,
        "pinSessionProject must preserve canonical hashed filename",
      );
    } finally {
      await releaseWorktreeMutex(acq.capability);
    }

    // 4. retireFocusBinding without requireKernelMutex/kernelCapability must still reject missing/wrong target
    const sf = path.join(stateBase, "projects", "adv35", "users", "u1", "workflow-state.ses_c18.json");
    await mkdir(path.dirname(sf), { recursive: true });
    const claimed = await claimFocusBinding({
      stateFile: sf,
      focusId: 93501,
      projectDir: repoA,
      repoKey: "repo-adv35-a",
    });
    assert.equal(claimed.ok, true);
    const blindRetire = await retireFocusBinding({
      stateFile: sf,
      focusId: 93501,
      reason: "blind bypass attempt",
    });
    assert.equal(blindRetire.ok, false, "retireFocusBinding without target must be rejected even without requireKernelMutex");
    assert.equal(blindRetire.reason, "FOCUS_BOUND_TO_ANOTHER_PROJECT");
    assert.ok(readFocusBinding({ stateFile: sf, focusId: 93501 }), "binding must remain intact after blind retire");

    // 5. Stale focus lock recovery + fresh lock acquisition across independent child processes
    //    using production focusLockPath (`sessions/focus-93502.lock`), local hostname, and confirmed-dead PID
    const sessionsDir = path.join(stateBase, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const staleLockFile = path.join(sessionsDir, "focus-93502.lock");
    const os = await import("node:os");
    const { spawn, spawnSync } = await import("node:child_process");
    const deadProc = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(deadProc.status, 0);
    await writeFile(
      staleLockFile,
      JSON.stringify({ pid: deadProc.pid, host: os.hostname(), startedAt: Date.now() - 60000, token: "dead-tok" }),
      "utf8",
    );
    const repoB = await createRepo(base, "adv35-b");
    const runChildClaim = (targetRepo, targetKey) =>
      new Promise((resolve, reject) => {
        const script = `
          import { claimFocusBinding } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "workflow-state.js")).href)};
          const res = await claimFocusBinding({
            stateFile: ${JSON.stringify(sf)},
            focusId: 93502,
            projectDir: ${JSON.stringify(targetRepo)},
            repoKey: ${JSON.stringify(targetKey)},
          });
          process.stdout.write(JSON.stringify(res));
        `;
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { err += d; });
        child.on("close", (code) => {
          if (code !== 0) return reject(new Error(`child exited ${code}: ${err}`));
          resolve(JSON.parse(out));
        });
      });
    const [r1, r2] = await Promise.all([
      runChildClaim(repoA, "repo-adv35-a"),
      runChildClaim(repoB, "repo-adv35-b"),
    ]);
    assert.equal([r1.ok, r2.ok].filter(Boolean).length, 1, "exactly one child process must win stale focus lock recovery");
    // Verify a live focus lock cannot be evicted by a contender
    const liveLockFile = path.join(sessionsDir, "focus-93503.lock");
    await writeFile(
      liveLockFile,
      JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() - 60000, token: "live-tok" }),
      "utf8",
    );
    const blocked = await claimFocusBinding({
      stateFile: sf,
      focusId: 93503,
      projectDir: repoA,
      repoKey: "repo-adv35-a",
      timeoutMs: 250,
    });
    assert.equal(blocked.ok, false, "live focus lock must not be evicted");
    assert.equal(blocked.reason, "FOCUS_CLAIM_TIMEOUT");
  });
});

test("Adversarial 36 (Cycle 19): CLI hashed sessionKey preserved, load({skipWrites:true}) avoids shared history write, and reset() preserves unresolved repair markers", async () => {
  await withTempWorkspace(async (base) => {
    const stateBase = path.join(base, "state-c19");
    const repoA = await createRepo(base, "adv36-a");
    const { openSessionState } = await import("../cli/runtime.js");
    const { resolveStateFile } = await import("../workflow-state.js");
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");

    // 1. CLI openSessionState preserves canonical hashed key without re-hashing
    const rawId = "org/repo:cli#19";
    const resolved = resolveStateFile({ sessionId: rawId, stateDir: path.join(stateBase, "projects", "p1", "users", "u1") });
    const hashedFile = path.basename(resolved);
    const hashedKey = /^workflow-state\.(.+)\.json$/.exec(hashedFile)?.[1];
    assert.ok(hashedKey && /-h[0-9a-f]{10}$/.test(hashedKey));
    const discoveredFile = path.join(stateBase, "projects", "adv36", "users", "u1", hashedFile);
    await mkdir(path.dirname(discoveredFile), { recursive: true });
    await writeFile(discoveredFile, JSON.stringify({ currentPhase: "idle", projectDir: repoA, history: [] }), "utf8");
    const acq = await acquireWorktreeMutex({ projectDir: repoA, ownerKey: hashedKey });
    try {
      const opened = await openSessionState({ file: discoveredFile });
      const ws = opened.workflowState;
      assert.equal(ws._sessionKey().key, hashedKey, "CLI openSessionState must preserve canonical hashed session key");
      ws.bindKernelCapability(acq.capability);
      await ws.load();
      await ws.save();

      // 2. load({ skipWrites: true }) merges shared history in memory without writing historyFile (both pre-mutex and with cap)
      const sharedHist = ws.historyFile;
      await writeFile(
        sharedHist,
        JSON.stringify({ history: [{ taskDescription: "shared-entry-c19", timestamp: new Date().toISOString() }] }, null, 2),
        "utf8",
      );
      const beforeHistRaw = await readFile(sharedHist, "utf8");
      ws.state.history.push({ taskDescription: "session-only-c19", timestamp: new Date().toISOString() });
      const roNoCap = new WorkflowState(discoveredFile, { canonicalSessionKey: hashedKey, requireKernelMutex: true });
      await roNoCap.load({ skipWrites: true });
      assert.ok(
        roNoCap.state.history.some((e) => e.taskDescription === "shared-entry-c19"),
        "pre-mutex load({skipWrites:true}) must merge shared history in memory without throwing",
      );
      await ws.load({ skipWrites: true });
      assert.equal(await readFile(sharedHist, "utf8"), beforeHistRaw, "load({skipWrites:true}) must not write shared history file");

      // 3. reset() preserves pendingProjectionRepair, pendingFocusCleanup, and pendingHistorySummaryRepairKeys
      ws.state.pendingProjectionRepair = { failedAt: new Date().toISOString(), repairErrors: ["C19_ERR"] };
      ws.state.pendingFocusCleanup = { focusId: 99, projectDir: repoA };
      ws.state.pendingHistorySummaryRepairKeys = { "u1::p1": true };
      ws.reset();
      assert.deepEqual(ws.state.pendingProjectionRepair?.repairErrors, ["C19_ERR"]);
      assert.equal(ws.state.pendingFocusCleanup?.focusId, 99);
      assert.equal(ws.state.pendingHistorySummaryRepairKeys?.["u1::p1"], true);
    } finally {
      await releaseWorktreeMutex(acq.capability);
    }
  });
});
