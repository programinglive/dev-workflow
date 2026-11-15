import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { testUtils } from "./test-helpers.js";

/**
 * A Mermaid string is not a visible flow.
 *
 * `start_task` can record the Mermaid code while the Zettly drawing never gets
 * created, and then the monitor shows a session with no canvas. The agent must
 * be told immediately, on the start_task reply and on every later reply, so it
 * calls create_feature_flow instead of working through the task blind.
 */

async function withState(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "flow-gate-"));
  const state = new WorkflowState(path.join(dir, "state.json"));
  await state.load();
  try {
    const repo = path.join(dir, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "ignore" });
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

test("start_task tanpa drawing memberi tahu bahwa flow belum terlihat", async () => {
  await withState(async (state, repo) => {
    const response = await call(
      "start_task",
      {
        description: "Flow gate probe",
        type: "bugfix",
        projectDir: repo,
        definitionOfDone: ["kondisi terbukti"],
        plan: ["langkah satu"],
      },
      state,
    );

    const text = response.content[0].text;
    assert.match(text, /FLOW NOT YET VISIBLE IN THE MONITOR/i);
    assert.match(text, /create_feature_flow/i);
  });
});

test("setiap balasan mengingatkan saat drawing belum ada", async () => {
  await withState(async (state, repo) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Flow gate probe";
    state.state.projectDir = repo;
    state.state.zettly = { todoId: 900, externalLinks: {} };

    const response = await call("mark_bug_fixed", { summary: "fixed" }, state);
    const text = response.content[0].text;

    assert.match(text, /FLOW BELUM ADA DI MONITOR/i);
    assert.match(text, /create_feature_flow/i);
  });
});

test("status menyebut drawing yang belum ada", async () => {
  await withState(async (state, repo) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Flow gate probe";
    state.state.projectDir = repo;
    state.state.featureFlowCreated = true;
    state.state.mermaidCode = "graph TD\n  A --> B";
    state.state.zettly = { todoId: 900, externalLinks: {} };

    const response = await call("get_workflow_status", {}, state);
    const text = response.content[0].text;

    assert.match(text, /drawing Zettly belum ada/i);
    assert.match(text, /create_feature_flow/i);
  });
});

test("tidak ada pengingat saat drawing sudah ada", async () => {
  await withState(async (state, repo) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Flow gate probe";
    state.state.projectDir = repo;
    state.state.featureFlowCreated = true;
    state.state.zettly = {
      todoId: 900,
      externalLinks: { drawing: { id: 901, url: "https://zettly.programinglive.com/draw/901" } },
    };

    const response = await call("mark_bug_fixed", { summary: "fixed" }, state);
    const text = response.content[0].text;

    assert.doesNotMatch(text, /FLOW BELUM ADA DI MONITOR/i);
  });
});
