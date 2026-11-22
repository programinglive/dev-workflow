import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { acquireWorktreeMutex, releaseWorktreeMutex, clearHeldLeasesForTests } from "../process-lock.js";
import { WorkflowState } from "../workflow-state.js";
import {
  handleCompleteTask,
  handleForceCompleteTask,
  handleDropTask,
} from "../tools/handler-modules/commit-handlers.js";
import { parseStatusEntries } from "../git-helpers.js";

function gitInit(dir) {
  const res = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git init failed: ${res.stderr}`);
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

async function withLockedState(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "dwf-lock-release-"));
  try {
    const repo = await createRepo(base, "repo");
    const stateFile = path.join(base, "state.json");
    const acq = await acquireWorktreeMutex({ projectDir: repo, ownerKey: stateFile });
    assert.equal(acq.ok, true, "test setup must acquire the worktree mutex");

    const state = new WorkflowState(stateFile);
    state.bindKernelCapability(acq.capability);
    await state.load();
    state.state.currentPhase = "ready_to_complete";
    state.state.taskDescription = "lock lifecycle task";
    state.state.taskType = "bugfix";
    state.state.projectDir = repo;
    state.state.definitionOfDone = [
      { id: "dod-1", text: "verified", status: "waived", waivedReason: "test", revision: 0 },
    ];
    await state.save({ allowReplaceRunningTask: true });

    const ctx = {
      git: {
        getStatusOutput: async () => "",
        parseStatusEntries,
        inspectCommitDiff: async () => ({ paths: [], todos: [] }),
        getToplevel: async () => repo,
      },
    };
    return await fn({ base, repo, state, ctx });
  } finally {
    clearHeldLeasesForTests();
    await rm(base, { recursive: true, force: true });
  }
}

async function canOtherSessionAcquire(repo) {
  const other = await acquireWorktreeMutex({
    projectDir: repo,
    ownerKey: `other-session-${Date.now()}`,
  });
  if (other.ok) await releaseWorktreeMutex(other.capability);
  return other.ok;
}

test("complete_task releases the worktree mutex for the next session", async () => {
  await withLockedState(async ({ repo, state, ctx }) => {
    const response = await handleCompleteTask({ commitMessage: "fix: lock release" }, state, ctx);
    assert.match(response.content[0].text, /^✅/);
    assert.equal(await canOtherSessionAcquire(repo), true, "mutex must be free after complete_task");
    await state.close();
  });
});

test("drop_task releases the worktree mutex for the next session", async () => {
  await withLockedState(async ({ repo, state, ctx }) => {
    const response = await handleDropTask({ reason: "superseded" }, state, ctx);
    assert.match(response.content[0].text, /Task dropped/);
    assert.equal(await canOtherSessionAcquire(repo), true, "mutex must be free after drop_task");
    await state.close();
  });
});

test("force_complete_task releases the worktree mutex for the next session", async () => {
  await withLockedState(async ({ repo, state, ctx }) => {
    const response = await handleForceCompleteTask({ reason: "stale" }, state, ctx);
    assert.match(response.content[0].text, /force-completed/);
    assert.equal(await canOtherSessionAcquire(repo), true, "mutex must be free after force_complete_task");
    await state.close();
  });
});
