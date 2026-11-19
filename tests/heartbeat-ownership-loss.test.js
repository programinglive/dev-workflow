import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  acquireWorktreeMutex,
  releaseWorktreeMutex,
  projectLockDir,
  writeKernelLockMetadata,
  LOCK_FILENAME,
} from "../process-lock.js";
import { runWorktreeHeartbeatTick } from "../index.js";

/**
 * Build a disposable workspace with a real git worktree and a state file whose
 * project bucket drives projectLockDir().
 */
async function makeWorkspace() {
  const base = await mkdtemp(path.join(tmpdir(), "dwf-heartbeat-"));
  const repo = path.join(base, "repo");
  await mkdir(repo, { recursive: true });
  const init = spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  const stateFile = path.join(base, "projects", "p", "users", "u", "workflow-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  return { base, repo, stateFile };
}

function makeState(stateFile, capability) {
  return {
    stateFile,
    state: { projectDir: capability?.worktreeRoot || "" },
    boundKernelCapability: capability || null,
    _hasExplicitStateFile: true,
    bindKernelCapability(next) {
      this.boundKernelCapability = next || null;
      return this.boundKernelCapability;
    },
  };
}

async function cleanup(base, capability) {
  if (capability?.active) await releaseWorktreeMutex(capability);
  await rm(base, { recursive: true, force: true });
}

test("heartbeat recovers when the bound worktree is deleted", async () => {
  const { base, repo, stateFile } = await makeWorkspace();
  const acquired = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "heartbeat-test" });
  assert.equal(acquired.ok, true, "the test needs a real OS kernel mutex capability");
  const state = makeState(stateFile, acquired.capability);

  // Simulate an operator deleting the worktree while the MCP process keeps
  // running. The next heartbeat tick must not terminate the process.
  await rm(repo, { recursive: true, force: true });

  const result = await runWorktreeHeartbeatTick(state);

  assert.equal(result.ok, false);
  assert.equal(result.recovered, true);
  assert.equal(result.reason, "invalid_target_worktree");
  assert.equal(state.boundKernelCapability, null, "the stale capability must be unbound");
  assert.equal(acquired.capability.active, false, "the stale OS capability must be released");

  await cleanup(base, acquired.capability);
});

test("heartbeat still refreshes lock metadata for a healthy worktree", async () => {
  const { base, repo, stateFile } = await makeWorkspace();
  const acquired = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "heartbeat-test" });
  assert.equal(acquired.ok, true, "the test needs a real OS kernel mutex capability");
  const state = makeState(stateFile, acquired.capability);

  const result = await runWorktreeHeartbeatTick(state);

  assert.equal(result.ok, true, "a live worktree must keep refreshing its metadata");
  assert.equal(state.boundKernelCapability, acquired.capability, "a live capability stays bound");

  const lockFile = path.join(projectLockDir(stateFile), LOCK_FILENAME);
  assert.ok(existsSync(lockFile), "heartbeat metadata must be written");
  const payload = JSON.parse(await readFile(lockFile, "utf8"));
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.leaseId, acquired.capability.token);
  assert.equal(payload.worktreeRoot, acquired.capability.worktreeRoot);

  await cleanup(base, acquired.capability);
});

test("non-ownership metadata failures are still surfaced", async () => {
  const { base, repo, stateFile } = await makeWorkspace();
  const acquired = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "heartbeat-test" });
  assert.equal(acquired.ok, true, "the test needs a real OS kernel mutex capability");
  const state = makeState(stateFile, acquired.capability);
  const failure = Object.assign(new Error("disk unavailable"), { code: "EIO" });

  await assert.rejects(
    () =>
      runWorktreeHeartbeatTick(state, {
        writeMetadata: () => {
          throw failure;
        },
      }),
    (error) => error === failure,
    "a non-ownership failure must propagate instead of being swallowed as recovery",
  );
  assert.equal(
    state.boundKernelCapability,
    acquired.capability,
    "a non-ownership failure must not unbind a live capability",
  );

  await cleanup(base, acquired.capability);
});

test("a deleted worktree still fails ownership checks closed", async () => {
  const { base, repo, stateFile } = await makeWorkspace();
  const acquired = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "heartbeat-test" });
  assert.equal(acquired.ok, true, "the test needs a real OS kernel mutex capability");

  await rm(repo, { recursive: true, force: true });

  assert.throws(
    () =>
      writeKernelLockMetadata({
        dir: projectLockDir(stateFile),
        capability: acquired.capability,
        projectDir: acquired.capability.worktreeRoot,
      }),
    (error) =>
      error?.code === "PROJECT_OWNERSHIP_LOST" &&
      error?.details?.reason === "invalid_target_worktree",
    "the recovery must not weaken the ownership check itself",
  );

  await cleanup(base, acquired.capability);
});
