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
  claimFocusBinding,
} from "../workflow-state.js";
import { resolveProjectDir } from "../exec.js";
import { handleStartTask } from "../tools/handler-modules/workflow-handlers.js";

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
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    const acq = await acquireWorktreeMutex({ projectDir: repo });
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

    const acq1 = await acquireWorktreeMutex({ projectDir: repo });
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
    const acq2 = await acquireWorktreeMutex({ projectDir: repo });
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
    const acq3 = await acquireWorktreeMutex({ projectDir: repo });
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

test("Adversarial 13 (A2): Directory with invalid .git file is rejected fail-closed", async () => {
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

    const stateFile = path.join(base, "state", "projects", "fake", "users", "u1", "workflow-state.json");
    const ws = new WorkflowState(stateFile);
    ws.requireKernelMutex = true;
    await ws.load();
    try {
      const res = await handleStartTask(makeStartArgs(fakeRepo, "Fake git repo task", 81), ws, null);
      const out = res?.content?.[0]?.text || "";
      assert.match(out, /Refused|not a valid Git working tree|Dibatalkan/i, `Expected invalid git worktree refusal, got: ${out}`);
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
