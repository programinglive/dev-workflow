import test from "node:test";
import assert from "node:assert/strict";
import { handleIntegrationTool } from "../tools/handler-modules/integration-handlers.js";
import { handleCompleteTask } from "../tools/handler-modules/commit-handlers.js";
import { getAllToolDefinitions, getToolList } from "../tools/definitions.js";

const text = (r) => r?.content?.map((item) => item.text || "").join(" ") || "";

function fixture() {
  const state = {
    state: {
      workflowTaskId: "task-sentry-1",
      taskDescription: "Fix issue",
      projectDir: "/repo",
      currentPhase: "coding",
      zettly: { todoId: 166, externalLinks: { sentry: { issueId: "123", shortId: "APP-1", url: "https://example.invalid/123" } } },
      definitionOfDone: [{ id: "dod-1", text: "Fix", status: "done", evidence: "npm test -> pass", revision: 0 }],
      dodRevision: 0,
      releaseSkipped: true,
    },
    async save() { return { verified: true }; },
    addToHistory() {},
    reset() { this.state = { currentPhase: "idle" }; },
  };
  const sentry = {
    organization: "example",
    resolvedCalls: [],
    async getIssue(id) { return { id, shortId: "APP-1", permalink: "https://example.invalid/123", status: "unresolved" }; },
    async resolveIssue(id, { status }) { this.resolvedCalls.push({ id, status }); return { id, shortId: "APP-1", status }; },
    async listIssues() { return []; },
  };
  return { state, sentry };
}

test("complete_task does not mutate Sentry by default and says so explicitly", async () => {
  const f = fixture();
  const res = await handleCompleteTask({ commitMessage: "fix: issue" }, f.state, {
    integrationOptions: { env: {}, sentry: f.sentry },
    zettlyOptions: { env: { DEVWF_ZETTLY_SYNC: "0" } },
  });
  assert.deepEqual(f.sentry.resolvedCalls, []);
  assert.match(text(res), /Sentry issue APP-1 \(123\) was not modified|no issue status changed/i);
});

test("complete_task with resolveSentry or the env flag mutates and reports id, status and result", async () => {
  for (const useEnv of [false, true]) {
    const f = fixture();
    const res = await handleCompleteTask(
      { commitMessage: "fix: issue", ...(useEnv ? {} : { resolveSentry: true }) },
      f.state,
      {
        integrationOptions: { env: useEnv ? { DEVWF_SENTRY_AUTORESOLVE: "1" } : {}, sentry: f.sentry },
        zettlyOptions: { env: { DEVWF_ZETTLY_SYNC: "0" } },
      },
    );
    assert.deepEqual(f.sentry.resolvedCalls, [{ id: "123", status: "resolved" }]);
    assert.match(text(res), /Sentry issue APP-1 \(123\)/);
    assert.match(text(res), /resolved/);
  }
});

test("set_sentry_issue_status requires confirm and a written reason", async () => {
  const f = fixture();
  const rejected = await handleIntegrationTool(
    "set_sentry_issue_status",
    { issue: "123", status: "resolve", reason: "verified in release 1.2.3" },
    f.state,
    { env: {}, sentry: f.sentry },
  );
  assert.equal(rejected.isError, true);
  assert.match(text(rejected), /confirm/i);
  assert.deepEqual(f.sentry.resolvedCalls, []);

  const changed = await handleIntegrationTool(
    "set_sentry_issue_status",
    { issue: "123", status: "ignore", reason: "verified in release 1.2.3", confirm: true },
    f.state,
    { env: {}, sentry: f.sentry },
  );
  assert.notEqual(changed.isError, true);
  assert.deepEqual(f.sentry.resolvedCalls, [{ id: "123", status: "ignored" }]);
  assert.match(text(changed), /APP-1 \(123\)/);
});

test("deprecated mutation actions in link_sentry_issue still work but warn", async () => {
  const f = fixture();
  const res = await handleIntegrationTool("link_sentry_issue", { issueId: "123", action: "resolve" }, f.state, {
    env: {},
    sentry: f.sentry,
  });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /deprecated/i);
  assert.match(text(res), /set_sentry_issue_status/);
});

test("new status tool exists only in full and is rejected outside that profile", async () => {
  const names = getAllToolDefinitions().map((tool) => tool.name);
  assert.ok(names.includes("set_sentry_issue_status"));
  const core = names.filter((name) => ["start_task", "complete_task"].includes(name));
  assert.ok(core.length === 2);
  assert.equal(getToolList().length, 66);
});

test("inventory and worktree descriptions tell the truth about writes", () => {
  const all = getAllToolDefinitions();
  const inventory = all.find((tool) => tool.name === "inventory_sentry_issues");
  assert.match(inventory.description, /0600|local snapshot/i);
  const complete = all.find((tool) => tool.name === "complete_task");
  assert.match(complete.description, /Sentry|mutat/i);
  const link = all.find((tool) => tool.name === "link_sentry_issue");
  assert.match(link.description, /deprecated|set_sentry_issue_status/i);
});
