import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { testUtils } from "./test-helpers.js";
import { acquireReleaseLock, releaseReleaseLock, readReleaseLock } from "../tools/release-lock.js";

/**
 * Two AI sessions on one clone must not run the release script at the same
 * time. Two release commits and two tags is how one session's work gets
 * clobbered. The lock makes the holder a fact.
 */

async function repoWithGit() {
  const dir = await mkdtemp(path.join(tmpdir(), "release-lock-"));
  await mkdir(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function call(name, args, workflowState, overrides = {}) {
  return handleToolCall({
    request: { params: { name, arguments: args } },
    normalizeRequestArgs,
    workflowState,
    exec: async () => ({ stdout: "" }),
    git: {
      hasWorkingChanges: async () => false,
      hasStagedChanges: async () => false,
      getCurrentBranch: async () => "main",
      getPrimaryBranch: async () => "main",
      getHeadSha: async () => "a".repeat(40),
      getRemoteBranchSha: async () => "a".repeat(40),
      getLastCommitMessage: async () => "",
      getStatusOutput: async () => "",
    },
    utils: testUtils,
    ...overrides,
  });
}

test("sesi pertama memegang lock, sesi kedua ditolak", async () => {
  const dir = await repoWithGit();
  try {
    const first = acquireReleaseLock({ projectDir: dir, tag: "v5.1.3", sessionId: "ses_A" });
    assert.equal(first.ok, true);

    const second = acquireReleaseLock({ projectDir: dir, tag: "v5.1.3", sessionId: "ses_B" });
    assert.equal(second.ok, false);
    assert.match(second.error, /sesi lain/i);
    assert.equal(second.holder.sessionId, "ses_A");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock yang sama boleh diambil ulang oleh pemegangnya", async () => {
  const dir = await repoWithGit();
  try {
    acquireReleaseLock({ projectDir: dir, tag: "v5.1.3", sessionId: "ses_A" });
    const again = acquireReleaseLock({ projectDir: dir, tag: "v5.1.3", sessionId: "ses_A" });
    assert.equal(again.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sesi lain tidak bisa melepas lock tanpa force", async () => {
  const dir = await repoWithGit();
  try {
    acquireReleaseLock({ projectDir: dir, tag: "v5.1.3", sessionId: "ses_A" });

    const denied = releaseReleaseLock({ projectDir: dir, sessionId: "ses_B" });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /sesi lain/i);

    const forced = releaseReleaseLock({ projectDir: dir, sessionId: "ses_B", force: true });
    assert.equal(forced.ok, true);
    assert.equal(readReleaseLock(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock yang kedaluwarsa diabaikan", async () => {
  const dir = await repoWithGit();
  try {
    await writeFile(
      path.join(dir, ".git", "devwf-release.lock.json"),
      JSON.stringify({
        sessionId: "ses_A",
        tag: "v5.1.3",
        acquiredAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    );

    assert.equal(readReleaseLock(dir), null);
    const taken = acquireReleaseLock({ projectDir: dir, tag: "v5.1.4", sessionId: "ses_B" });
    assert.equal(taken.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("perform_release menolak saat lock dipegang sesi lain", async () => {
  const dir = await repoWithGit();
  try {
    acquireReleaseLock({ projectDir: dir, tag: "v5.1.3", sessionId: "ses_A" });

    const stateFile = path.join(dir, "state.json");
    const state = new WorkflowState(stateFile);
    await state.load();
    state.state.currentPhase = "release";
    state.state.projectDir = dir;
    state.sessionId = "ses_B";

    const response = await call("perform_release", { command: "npm run release:patch" }, state);
    const text = response.content[0].text;

    assert.match(text, /dipegang sesi lain/i);
    assert.match(text, /ses_A/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
