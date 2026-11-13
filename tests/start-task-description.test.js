import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { testUtils } from "./test-helpers.js";

/**
 * `start_task` kehilangan deskripsi ketika agen mengirim `task` alih-alih
 * `description`. Task kosong berarti Tidak ada Todo, jadi Tidak ada drawing, dan
 * monitor menampilkan sesi tanpa flow. Kesalahan yang tidak bersuara seperti itu
 * harus ditolak, bukan diterima.
 */

async function withState(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "start-task-desc-"));
  const state = new WorkflowState(path.join(dir, "state.json"));
  await state.load();
  try {
    // start_task refuses a projectDir that is not a git repository, so the test
    // provides one instead of skipping that guard.
    const repo = path.join(dir, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await callback(state, repo);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function call(name, args, workflowState) {
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
  });
}

const dod = ["kondisi terbukti"];
const plan = ["langkah satu", "langkah dua"];

test("start_task menolak description kosong alih-alih membuat task kosong", async () => {
  await withState(async (state, dir) => {
    const response = await call(
      "start_task",
      { task: "Restore the flow", type: "bugfix", projectDir: dir, definitionOfDone: dod, plan },
      state,
    );

    // Either the alias is honoured or the task is refused; what must never
    // happen is an empty taskDescription.
    if (state.state.taskDescription === "") {
      assert.match(response.content[0].text, /description.*required|not started/i);
    } else {
      assert.equal(state.state.taskDescription, "Restore the flow");
    }
  });
});

test("start_task memakai task sebagai alias description", async () => {
  await withState(async (state, dir) => {
    const response = await call(
      "start_task",
      { task: "Alias task description", type: "bugfix", projectDir: dir, definitionOfDone: dod, plan },
      state,
    );

    assert.equal(
      state.state.taskDescription,
      "Alias task description",
      "an unknown 'task' key must not silently produce an empty task",
    );
    assert.match(response.content[0].text, /Task Started: Alias task description/);
  });
});

test("start_task tanpa description ditolak tanpa mengubah workflow", async () => {
  await withState(async (state, dir) => {
    const response = await call(
      "start_task",
      { type: "bugfix", projectDir: dir, definitionOfDone: dod, plan },
      state,
    );

    assert.match(response.content[0].text, /description/i);
    assert.equal(state.state.currentPhase, "idle");
  });
});
