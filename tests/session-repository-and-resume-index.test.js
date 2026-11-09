import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { buildSnapshot } from "../monitor.js";
import { parseRepositoryOutput, captureRepository } from "../repository.js";
import { recordAiSession, renderAiSessions, isResumableSessionKey } from "../ai-sessions.js";

const require = createRequire(import.meta.url);
const { buildSessionUpsert } = require("../monitor-server/session-upsert.cjs");
const { renderTaskMetadata } = require("../monitor-server/task-metadata.cjs");

/**
 * Two gaps measured on 7 November 2026:
 *
 * 1. A closed AI session could not be found again. The Zettly Todo listed the
 *    plan and the commit, but never the session that did the work, so the owner
 *    had no way back to the conversation.
 * 2. A task card never said where the project lives. The local path was stored
 *    but only shown in the detail modal, and the git remote was never captured.
 */

const baseState = {
  taskDescription: "Record session and repository",
  taskType: "feature",
  currentPhase: "coding",
  plan: [{ id: "plan-1", text: "write tests", status: "open" }],
  definitionOfDone: [{ id: "dod-1", text: "tests pass", status: "open", revision: 0 }],
  repository: { path: "D:\\code\\clinic", remote: "https://github.com/programinglive/clinic.git" },
  aiSessions: [
    {
      key: "ses_abc123",
      agent: "opencode",
      machine: "HELLOWORLD",
      title: "Fix POS deploy",
      source: "request-metadata",
      startedAt: "2026-11-07T06:00:00.000Z",
      lastSeenAt: "2026-11-07T06:30:00.000Z",
      phase: "coding",
    },
  ],
};

test("buildSnapshot reports the repository path and remote", () => {
  const snapshot = buildSnapshot({
    state: baseState,
    sessionKey: "ses_abc123",
    projectPath: "D:\\code\\clinic",
    env: {},
  });
  assert.equal(snapshot.repositoryPath, "D:\\code\\clinic");
  assert.equal(snapshot.repositoryRemote, "https://github.com/programinglive/clinic.git");
});

test("buildSnapshot omits repository fields when the task has no repository", () => {
  const snapshot = buildSnapshot({ state: { taskDescription: "x" }, sessionKey: "ses_x", env: {} });
  assert.equal(snapshot.repositoryPath, "");
  assert.equal(snapshot.repositoryRemote, "");
});

test("parseRepositoryOutput trims git output and ignores failures", () => {
  assert.deepEqual(
    parseRepositoryOutput({ toplevel: "D:/code/clinic\n", remote: "git@github.com:org/clinic.git\n" }),
    { path: "D:/code/clinic", remote: "git@github.com:org/clinic.git" },
  );
  assert.deepEqual(parseRepositoryOutput({}), { path: "", remote: "" });
});

test("captureRepository never throws when git is unavailable", async () => {
  const result = await captureRepository({
    dir: "D:\\code\\not-a-repo",
    execImpl: async () => {
      throw new Error("not a git repository");
    },
  });
  assert.deepEqual(result, { path: "", remote: "" });
});

test("captureRepository reads toplevel and origin from git", async () => {
  const calls = [];
  const result = await captureRepository({
    dir: "D:\\code\\clinic",
    execImpl: async (command) => {
      calls.push(command);
      if (command.includes("--show-toplevel")) return { stdout: "D:/code/clinic\n", stderr: "" };
      return { stdout: "https://github.com/programinglive/clinic.git\n", stderr: "" };
    },
  });
  assert.deepEqual(result, { path: "D:/code/clinic", remote: "https://github.com/programinglive/clinic.git" });
  assert.ok(calls.some((line) => line.includes("rev-parse --show-toplevel")));
  assert.ok(calls.some((line) => line.includes("remote get-url origin")));
});

test("only OpenCode session keys are resumable", () => {
  assert.equal(isResumableSessionKey("ses_e4b3f3805ffeiua93K1Cq0VIgc"), true);
  assert.equal(isResumableSessionKey("proc-67a1a335-10f3-48e8-a4db-4bae83769825"), false);
  assert.equal(isResumableSessionKey(""), false);
});

test("recordAiSession dedupes by key, caps the list, and keeps the newest report", () => {
  const state = {};
  for (let index = 0; index < 12; index += 1) {
    recordAiSession(state, {
      key: `ses_${index}`,
      agent: "opencode",
      machine: "HELLOWORLD",
      title: `Task ${index}`,
      source: "request-metadata",
      now: 1000 + index,
    });
  }
  assert.equal(state.aiSessions.length, 10);
  assert.equal(state.aiSessions[0].key, "ses_11");

  recordAiSession(state, {
    key: "ses_11",
    agent: "opencode",
    machine: "HELLOWORLD",
    title: "Task 11 renamed",
    source: "request-metadata",
    now: 2000,
  });
  assert.equal(state.aiSessions.length, 10);
  assert.equal(state.aiSessions[0].title, "Task 11 renamed");
  assert.equal(state.aiSessions[0].lastSeenAt, new Date(2000).toISOString());
});

test("renderAiSessions marks resumable and process-only sessions honestly", () => {
  const lines = renderAiSessions({
    aiSessions: [
      { key: "ses_abc123", agent: "opencode", machine: "HELLOWORLD", title: "Fix POS deploy", source: "request-metadata" },
      { key: "proc-xyz", agent: "codex", machine: "MMCH", title: "Handover", source: "process-random" },
    ],
  });
  assert.match(lines[0], /ses_abc123/);
  assert.match(lines[0], /resumable/i);
  assert.match(lines[1], /proc-xyz/);
  assert.match(lines[1], /tidak bisa di-resume/i);
});

test("session upsert stores repository columns and never erases them with empty reports", () => {
  const { sql, params } = buildSessionUpsert({
    sessionKey: "ses_abc123",
    repositoryPath: "D:\\code\\clinic",
    repositoryRemote: "https://github.com/programinglive/clinic.git",
  });
  assert.match(sql, /repo_path/);
  assert.match(sql, /repo_remote/);
  assert.match(sql, /repo_path=COALESCE\(NULLIF\(EXCLUDED\.repo_path, ''\), sessions\.repo_path\)/);
  assert.match(sql, /repo_remote=COALESCE\(NULLIF\(EXCLUDED\.repo_remote, ''\), sessions\.repo_remote\)/);
  assert.ok(params.includes("D:\\code\\clinic"));
  assert.ok(params.includes("https://github.com/programinglive/clinic.git"));
});

test("task card shows the repository only when the task has one", () => {
  const withRepo = renderTaskMetadata({
    task: "Ship it",
    workflow_task_id: "wf-1",
    repo_path: "D:\\code\\clinic",
    repo_remote: "https://github.com/programinglive/clinic.git",
    task_relations_json: [{ system: "zettly_draw", id: "66", url: "https://zettly.programinglive.com/draw/66", label: "Draw #66", relation: "visual_plan" }],
  });
  assert.match(withRepo, /D:\\code\\clinic/);
  // The remote is the clickable chip rendered next to this block (repoLinkHtml,
  // covered by tests/repo-link.test.js). Printing it here as well showed the
  // same address twice on one card, so the metadata line carries the path only.
  assert.doesNotMatch(withRepo, /github\.com\/programinglive\/clinic/);

  const withoutRepo = renderTaskMetadata({ task: "Ship it", task_relations_json: [] });
  assert.doesNotMatch(withoutRepo, /📁/);
});

test("task card warns when a running task has no Mermaid flow yet", () => {
  const html = renderTaskMetadata({
    task: "Ship it",
    workflow_task_id: "wf-1",
    task_relations_json: [{ system: "zettly", id: "340", url: "https://zettly.programinglive.com/todos/340", label: "Zettly #340", relation: "tracks" }],
  });
  assert.match(html, /Flow belum ada/i);
  assert.match(html, /create_feature_flow/);
});

test("task card does not warn about a missing flow when the task has one", () => {
  const html = renderTaskMetadata({
    task: "Ship it",
    workflow_task_id: "wf-1",
    task_relations_json: [{ system: "zettly_draw", id: "66", url: "https://zettly.programinglive.com/draw/66", label: "Draw #66", relation: "visual_plan" }],
  });
  assert.doesNotMatch(html, /Flow belum ada/i);
});
