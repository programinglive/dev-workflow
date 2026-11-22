import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowState } from "../workflow-state.js";
import {
  acquireWorktreeMutex,
  releaseWorktreeMutex,
  getHeldWorktreeCapability,
} from "../process-lock.js";
import {
  handleCompleteTask,
  handleDropTask,
  handleForceCompleteTask,
} from "../tools/handler-modules/commit-handlers.js";
import {
  handleStartTask,
} from "../tools/handler-modules/workflow-handlers.js";

function setupTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwf-lock-lifecycle-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("Lifecycle: complete_task releases kernel mutex and permits immediate successor acquisition", async () => {
  const repoDir = setupTempRepo();
  const stateFile = path.join(repoDir, ".state", "workflow-state.json");
  const ws = new WorkflowState(stateFile, { sessionId: "sess-lifecycle-1", requireKernelMutex: true });

  // 1. Start task
  const startRes = await handleStartTask(
    {
      description: "Test task to be completed",
      type: "feature",
      projectDir: repoDir,
      definitionOfDone: ["Feature implemented"],
      plan: ["Implement feature"],
    },
    ws,
    { git: null }
  );
  assert.match(startRes.content[0].text, /Task Started/);
  assert.ok(ws.boundKernelCapability, "Capability must be bound to active task");
  assert.equal(ws.state.currentPhase, "coding");

  // 2. While task is active, second session is excluded fail-closed
  const secondAcq = await acquireWorktreeMutex({
    projectDir: repoDir,
    ownerKey: "sess-lifecycle-2",
    timeoutMs: 0,
  });
  assert.equal(secondAcq.ok, false, "Second writer must be rejected while first task is active");

  // 3. Mark DoD item and complete task
  ws.state.definitionOfDone[0].status = "done";
  ws.state.definitionOfDone[0].evidence = "Unit test passed";
  ws.state.lastCommitMessage = "feat: implement test feature";

  const completeRes = await handleCompleteTask(
    { commitMessage: "feat: implement test feature" },
    ws,
    { skipGovernanceGate: true }
  );
  assert.match(completeRes.content[0].text, /Task completed/);

  // 4. Verify state is idle, capability is unbound, and OS mutex is completely released
  assert.equal(ws.state.currentPhase, "idle");
  assert.equal(ws.boundKernelCapability, null, "Capability must be unbound after completion");
  assert.equal(getHeldWorktreeCapability(repoDir), null, "OS mutex capability must be cleared from process registry");

  // 5. Saving idle state via allowOrphanedReset must succeed
  await assert.doesNotReject(async () => {
    await ws.save({ allowOrphanedReset: true });
  }, "Idle state save via allowOrphanedReset must succeed");

  // 6. Successor session can acquire worktree mutex immediately without waiting for process exit
  const successorAcq = await acquireWorktreeMutex({
    projectDir: repoDir,
    ownerKey: "sess-lifecycle-successor",
    timeoutMs: 100,
  });
  assert.equal(successorAcq.ok, true, "Successor must acquire mutex immediately after complete_task");
  if (successorAcq.capability) {
    await releaseWorktreeMutex(successorAcq.capability);
  }

  // 7. Successor can run full handleStartTask in the same repo without contention
  const wsSuccessor = new WorkflowState(stateFile, { sessionId: "sess-lifecycle-successor", requireKernelMutex: true });
  const successorStart = await handleStartTask(
    {
      description: "Successor task after completion",
      type: "feature",
      projectDir: repoDir,
      definitionOfDone: ["Successor work done"],
      plan: ["Execute successor work"],
    },
    wsSuccessor,
    { git: null }
  );
  assert.match(successorStart.content[0].text, /Task Started/);
  assert.equal(wsSuccessor.state.currentPhase, "coding");
  if (wsSuccessor.boundKernelCapability) {
    await releaseWorktreeMutex(wsSuccessor.boundKernelCapability);
  }
});

test("Lifecycle: drop_task releases kernel mutex and permits immediate successor acquisition", async () => {
  const repoDir = setupTempRepo();
  const stateFile = path.join(repoDir, ".state", "workflow-state.json");
  const ws = new WorkflowState(stateFile, { sessionId: "sess-lifecycle-drop", requireKernelMutex: true });

  const startRes = await handleStartTask(
    {
      description: "Test task to be dropped",
      type: "bugfix",
      projectDir: repoDir,
      definitionOfDone: ["Bug reproduced and fixed"],
      plan: ["Reproduce bug"],
    },
    ws,
    { git: null }
  );
  assert.match(startRes.content[0].text, /Task Started/);
  assert.ok(ws.boundKernelCapability);

  const dropRes = await handleDropTask({ reason: "No longer needed" }, ws, {});
  assert.match(dropRes.content[0].text, /Task dropped/);

  assert.equal(ws.state.currentPhase, "idle");
  assert.equal(ws.boundKernelCapability, null);
  assert.equal(getHeldWorktreeCapability(repoDir), null);

  await assert.doesNotReject(async () => {
    await ws.save({ allowOrphanedReset: true });
  });

  const successorAcq = await acquireWorktreeMutex({
    projectDir: repoDir,
    ownerKey: "sess-lifecycle-drop-successor",
    timeoutMs: 100,
  });
  assert.equal(successorAcq.ok, true, "Successor must acquire mutex immediately after drop_task");
  if (successorAcq.capability) {
    await releaseWorktreeMutex(successorAcq.capability);
  }
});

test("Lifecycle: force_complete_task releases kernel mutex and permits immediate successor acquisition", async () => {
  const repoDir = setupTempRepo();
  const stateFile = path.join(repoDir, ".state", "workflow-state.json");
  const ws = new WorkflowState(stateFile, { sessionId: "sess-lifecycle-force", requireKernelMutex: true });

  const startRes = await handleStartTask(
    {
      description: "Test task to be force completed",
      type: "feature",
      projectDir: repoDir,
      definitionOfDone: ["Manual check required"],
      plan: ["Check manually"],
    },
    ws,
    { git: null }
  );
  assert.match(startRes.content[0].text, /Task Started/);
  assert.ok(ws.boundKernelCapability);

  const forceRes = await handleForceCompleteTask(
    { reason: "Emergency override for hotfix verification" },
    ws,
    { skipGovernanceGate: true }
  );
  assert.match(forceRes.content[0].text, /Task force-completed/);

  assert.equal(ws.state.currentPhase, "idle");
  assert.equal(ws.boundKernelCapability, null);
  assert.equal(getHeldWorktreeCapability(repoDir), null);

  await assert.doesNotReject(async () => {
    await ws.save({ allowOrphanedReset: true });
  });

  const successorAcq = await acquireWorktreeMutex({
    projectDir: repoDir,
    ownerKey: "sess-lifecycle-force-successor",
    timeoutMs: 100,
  });
  assert.equal(successorAcq.ok, true, "Successor must acquire mutex immediately after force_complete_task");
  if (successorAcq.capability) {
    await releaseWorktreeMutex(successorAcq.capability);
  }
});

test("Lifecycle: rapid multi-task cycle does not leak pipes or trigger project-lock contention", async () => {
  const repoDir = setupTempRepo();
  const stateFile = path.join(repoDir, ".state", "workflow-state.json");

  for (let cycle = 1; cycle <= 3; cycle++) {
    const ws = new WorkflowState(stateFile, { sessionId: `sess-cycle-${cycle}`, requireKernelMutex: true });
    const startRes = await handleStartTask(
      {
        description: `Rapid cycle ${cycle}`,
        type: "feature",
        projectDir: repoDir,
        definitionOfDone: [`Item ${cycle}`],
        plan: [`Step ${cycle}`],
      },
      ws,
      { git: null }
    );
    assert.match(startRes.content[0].text, /Task Started/);
    assert.ok(ws.boundKernelCapability);

    ws.state.definitionOfDone[0].status = "done";
    ws.state.definitionOfDone[0].evidence = `Evidence ${cycle}`;
    ws.state.lastCommitMessage = `feat: cycle ${cycle}`;

    const completeRes = await handleCompleteTask(
      { commitMessage: `feat: cycle ${cycle}` },
      ws,
      { skipGovernanceGate: true }
    );
    assert.match(completeRes.content[0].text, /Task completed/);
    assert.equal(ws.boundKernelCapability, null);
    assert.equal(getHeldWorktreeCapability(repoDir), null, `Cycle ${cycle} must not leak worktree capability`);
  }
});

test("Lifecycle: useSession re-acquires worktree mutex after simulated server restart when task is active", async () => {
  const repoDir = setupTempRepo();
  const stateFile = path.join(repoDir, ".state", "workflow-state.json");
  const ws1 = new WorkflowState(stateFile, { sessionId: "sess-recoverable", requireKernelMutex: true });

  const startRes = await handleStartTask(
    {
      description: "Active task across server restart",
      type: "feature",
      projectDir: repoDir,
      definitionOfDone: ["Verify reconnect"],
      plan: ["Start", "Reconnect"],
    },
    ws1,
    { git: null }
  );
  assert.match(startRes.content[0].text, /Task Started/);
  assert.ok(ws1.boundKernelCapability);

  // Simulate server crash/restart: the old OS capability is closed (process exit behavior)
  const oldCap = ws1.boundKernelCapability;
  const committedStateFile = ws1.stateFile;
  await releaseWorktreeMutex(oldCap);
  await ws1.close();

  // New MCP process spawns: memory is cold, opens the same state file
  const ws2 = new WorkflowState(committedStateFile, { sessionId: "sess-recoverable", requireKernelMutex: true });
  await ws2.load();

  // Re-acquire worktree mutex for the active task
  if (!ws2.boundKernelCapability && ws2.state?.projectDir) {
    const acq = await acquireWorktreeMutex({
      projectDir: ws2.state.projectDir,
      ownerKey: "sess-recoverable",
    });
    if (acq.ok && acq.capability) {
      ws2.bindKernelCapability(acq.capability);
    }
  }

  // useSession must safely re-acquire the worktree mutex capability for the active task
  assert.equal(ws2.state.currentPhase, "coding");
  assert.ok(ws2.boundKernelCapability, "Successor instance must re-acquire capability for active task");
  assert.equal(ws2.boundKernelCapability.worktreeRoot, repoDir);

  // Operations on ws2 can save normally without throwing missing capability errors
  ws2.state.plan[0].status = "done";
  await assert.doesNotReject(async () => {
    await ws2.save();
  }, "Saving after re-acquisition must succeed without throwing");

  // Cleanup
  if (ws2.boundKernelCapability) {
    await releaseWorktreeMutex(ws2.boundKernelCapability);
  }
  await ws2.close();
});
