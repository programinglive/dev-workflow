import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState, resolveStateFile } from "../workflow-state.js";
import {
  NON_SESSION_SCOPED_TOOLS,
  SESSION_IDENTITY_REQUIRED_MESSAGE,
  isSessionScopedTool,
  resolveRequestSession,
} from "../session-scope.js";

const SESSION_META_KEY = "ai.opencode/sessionID";

const originalCwd = process.cwd();
const originalStateFile = process.env.DEV_WORKFLOW_STATE_FILE;
const originalUserId = process.env.DEV_WORKFLOW_USER_ID;
const originalDbPath = process.env.DEV_WORKFLOW_DB_PATH;

async function withProject(callback) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "session-attribution-"));
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "fixture" }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: projectRoot });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: projectRoot });

  if (!process.env.DEV_WORKFLOW_DB_PATH) {
    process.env.DEV_WORKFLOW_DB_PATH = path.join(tmpdir(), `session-attribution-${process.pid}.db`);
  }
  delete process.env.DEV_WORKFLOW_STATE_FILE;
  process.env.DEV_WORKFLOW_USER_ID = "user-test";
  process.chdir(projectRoot);

  try {
    await callback(projectRoot);
  } finally {
    process.chdir(originalCwd);
    for (const [name, value] of [
      ["DEV_WORKFLOW_USER_ID", originalUserId],
      ["DEV_WORKFLOW_STATE_FILE", originalStateFile],
      ["DEV_WORKFLOW_DB_PATH", originalDbPath],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function requestWith(name, args = {}, sessionId) {
  return {
    params: {
      name,
      arguments: args,
      ...(sessionId ? { _meta: { [SESSION_META_KEY]: sessionId } } : {}),
    },
  };
}

test("missing session metadata rejects session-scoped tools", () => {
  for (const tool of ["start_task", "get_workflow_status", "mark_dod_item", "commit_and_push", "complete_task"]) {
    const gate = resolveRequestSession(requestWith(tool));
    assert.equal(gate.ok, false, `${tool} must be rejected without a session`);
    assert.equal(gate.error, SESSION_IDENTITY_REQUIRED_MESSAGE);
  }
});

test("missing session metadata allows non-session tools", () => {
  for (const tool of ["get_current_focus", "list_active_sessions", "recommend_mcp_tools", "get_integration_status"]) {
    const gate = resolveRequestSession(requestWith(tool));
    assert.equal(gate.ok, true, `${tool} must be allowed without a session`);
    assert.equal(gate.sessionId, null);
  }
});

test("empty or whitespace session metadata is treated as missing", () => {
  const gate = resolveRequestSession({
    params: { name: "start_task", arguments: {}, _meta: { [SESSION_META_KEY]: "   " } },
  });
  assert.equal(gate.ok, false);
});

test("non-string session metadata is treated as missing", () => {
  const gate = resolveRequestSession({
    params: { name: "start_task", arguments: {}, _meta: { [SESSION_META_KEY]: 123 } },
  });
  assert.equal(gate.ok, false);
});

test("a verified session id is accepted", () => {
  const gate = resolveRequestSession(requestWith("start_task", {}, "ses_verified"));
  assert.equal(gate.ok, true);
  assert.equal(gate.sessionId, "ses_verified");
});

test("two session ids resolve to different state files", async () => {
  await withProject(async () => {
    const a = resolveStateFile({ sessionId: "ses_AAA" });
    const b = resolveStateFile({ sessionId: "ses_BBB" });
    assert.notEqual(a, b, "different sessions must not share a state file");
    assert.match(a, /ses_AAA/);
    assert.match(b, /ses_BBB/);
  });
});

test("alternating sessions keep separate state", async () => {
  await withProject(async () => {
    const state = new WorkflowState();
    await state.load();

    await state.useSession("ses_AAA");
    await state.load();
    state.state.taskDescription = "Task A";
    await state.save();

    await state.useSession("ses_BBB");
    await state.load();
    state.state.taskDescription = "Task B";
    await state.save();

    await state.useSession("ses_AAA");
    await state.load();
    assert.equal(state.state.taskDescription, "Task A", "session A must not see session B's task");

    await state.useSession("ses_BBB");
    await state.load();
    assert.equal(state.state.taskDescription, "Task B", "session B must not see session A's task");
  });
});

test("a rejected request does not change the state file", async () => {
  await withProject(async () => {
    const state = new WorkflowState();
    await state.load();
    const before = state.stateFile;

    const gate = resolveRequestSession(requestWith("start_task", { description: "should not run" }));
    assert.equal(gate.ok, false);
    assert.equal(state.stateFile, before, "a rejected request must not switch the state file");
  });
});

test("a valid request after a rejection still works", () => {
  const rejected = resolveRequestSession(requestWith("start_task", {}));
  assert.equal(rejected.ok, false);

  const accepted = resolveRequestSession(requestWith("start_task", {}, "ses_recovered"));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.sessionId, "ses_recovered");
});

test("the non-session allowlist is explicit and small", () => {
  assert.ok(NON_SESSION_SCOPED_TOOLS.size > 0);
  assert.equal(isSessionScopedTool("start_task"), true);
  assert.equal(isSessionScopedTool("get_current_focus"), false);
  assert.equal(isSessionScopedTool("unknown_tool"), true, "unknown tools are fail-closed");
});
