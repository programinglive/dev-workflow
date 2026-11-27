/**
 * @zettly-code DWF-CLAIM-COORD-TEST-001
 * @purpose Verify open-source-safe active AI session claim & monitor coordination across monitor.js, claim-view.js, start_task, Sentry issue reads, preemption, and Zettly Todo auto-claiming.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractClaimIdentifiers,
  collectActiveSessionClaims,
  findMatchingActiveClaim,
  formatDuplicateClaimRefusal,
} from "../claim-view.js";
import { buildSnapshot } from "../monitor.js";
import {
  handleIntegrationTool,
  checkSentryPreemption,
  resetSentryPreemptionCache,
} from "../tools/handler-modules/integration-handlers.js";
import { handleToolCall } from "../tools/handlers.js";
import { syncZettlyTask, assignWorkflowIdentity } from "../zettly-workflow.js";
import { withWorkflowState, testUtils, createRequest, createGitMock } from "./test-helpers.js";

const text = (res) => res?.content?.map((c) => c.text || "").join(" ") || "";

test("buildSnapshot includes open-source-safe activeClaim metadata for active and idle tasks", () => {
  const activeSnap = buildSnapshot({
    sessionKey: "ses_live_1",
    projectPath: "/repo/erp",
    state: {
      currentPhase: "coding",
      workflowTaskId: "task-uuid-1",
      taskDescription: "Fix ERP-8B stock usage N+1 query",
      taskOrigin: { system: "sentry", id: "7869873339", label: "ERP-8B" },
      zettly: {
        todoId: 1239,
        externalLinks: {
          sentry: { issueId: "7869873339", shortId: "ERP-8B" },
        },
      },
    },
    env: { DEVWF_MACHINE: "HELLOWORLD" },
  });

  assert.ok(activeSnap.activeClaim, "activeClaim must be present on snapshot");
  assert.equal(activeSnap.activeClaim.claimed, true);
  assert.equal(activeSnap.activeClaim.status, "in_progress");
  assert.equal(activeSnap.activeClaim.taskId, "task-uuid-1");
  assert.equal(activeSnap.activeClaim.todoId, 1239);
  assert.equal(activeSnap.activeClaim.sentryIssueId, "7869873339");
  assert.equal(activeSnap.activeClaim.sentryShortId, "ERP-8B");
  assert.deepEqual(activeSnap.activeClaim.source, {
    system: "sentry",
    id: "7869873339",
    label: "ERP-8B",
  });

  const idleSnap = buildSnapshot({
    sessionKey: "ses_idle_1",
    projectPath: "/repo/erp",
    state: { currentPhase: "idle", taskDescription: "" },
  });
  assert.equal(idleSnap.activeClaim.claimed, false);
  assert.equal(idleSnap.activeClaim.status, "idle");
});

test("extractClaimIdentifiers normalizes monitor sessions and local disk states without requiring Zettly", () => {
  const monitorRow = {
    session_key: "ses_remote_mac",
    machine: "Mac",
    agent_tool: "opencode",
    project_name: "erp.beautyworld.co.id",
    phase: "testing",
    task: "Release the ERP-8B N+1 fix as ERP patch tag v2.41.77",
    workflow_task_id: "wf-mac-001",
    updated_at: new Date().toISOString(),
    task_origin_json: { system: "sentry", id: "7869873339", label: "ERP-8B" },
    task_relations_json: [
      { system: "zettly", id: "1240", relation: "tracks", label: "Zettly #1240" },
      { system: "sentry", id: "7869873339", relation: "source_issue", label: "ERP-8B" },
    ],
  };

  const extracted = extractClaimIdentifiers(monitorRow);
  assert.equal(extracted.sessionKey, "ses_remote_mac");
  assert.equal(extracted.machine, "Mac");
  assert.equal(extracted.agentTool, "opencode");
  assert.equal(extracted.phase, "testing");
  assert.ok(extracted.workflowTaskIds.includes("wf-mac-001"));
  assert.ok(extracted.sentryIssueIds.includes("7869873339"));
  assert.ok(extracted.sentryShortIds.includes("ERP-8B"));
  assert.ok(extracted.zettlyTodoIds.includes(1240));
  assert.ok(extracted.sources.includes("sentry:7869873339"));
});

test("collectActiveSessionClaims works completely offline (no DEVWF_MONITOR_URL, no Zettly) using local state files", async () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dwf-local-claim-"));
  try {
    const projectBucket = path.join(tmpRoot, "projects", "proj-a", "users", "default");
    const foreignStateFile = path.join(projectBucket, "workflow-state.ses_local_peer.json");
    const ownStateFile = path.join(projectBucket, "workflow-state.ses_self.json");
    await import("node:fs/promises").then((fs) => fs.mkdir(projectBucket, { recursive: true }));

    writeFileSync(
      foreignStateFile,
      JSON.stringify({
        currentPhase: "coding",
        workflowTaskId: "local-task-77",
        taskDescription: "Fix issue APP-99 locally",
        projectDir: "/repo/app",
        taskOrigin: { system: "sentry", id: "990011", label: "APP-99" },
        owner: { pid: process.pid, updatedAt: Date.now() },
      }),
      "utf8",
    );

    const claims = await collectActiveSessionClaims({
      ownSessionKey: "ses_self",
      stateFile: ownStateFile,
      env: {}, // No DEVWF_MONITOR_URL, no Zettly
    });

    assert.equal(claims.length, 1);
    assert.equal(claims[0].sessionKey, "ses_local_peer");
    assert.ok(claims[0].sentryIssueIds.includes("990011"));
    assert.ok(claims[0].sentryShortIds.includes("APP-99"));

    const match = findMatchingActiveClaim(
      { source: { system: "sentry", id: "990011" } },
      claims,
      { ownSessionKey: "ses_self" },
    );
    assert.ok(match, "should match local peer session claiming sentry:990011");
    assert.equal(match.claim.sessionKey, "ses_local_peer");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("list_sentry_issues and get_sentry_issue annotate issues with activeClaim from live monitor sessions", async () => {
  const issueClaimed = {
    id: "7869873339",
    shortId: "ERP-8B",
    title: "N+1 Query on stock-usage",
    permalink: "https://example.sentry.io/issues/7869873339/",
    project: { slug: "erp" },
  };
  const issueFree = {
    id: "7869879999",
    shortId: "ERP-9C",
    title: "Unclaimed error",
    permalink: "https://example.sentry.io/issues/7869879999/",
    project: { slug: "erp" },
  };

  const mockMonitorFetch = async () => ({
    ok: true,
    json: async () => ({
      sessions: [
        {
          session_key: "ses_worker_mmch",
          machine: "MMCH",
          agent_tool: "opencode",
          project_name: "erp.beautyworld.co.id",
          phase: "coding",
          state: "live",
          task: "Fix ERP-8B stock usage N+1",
          workflow_task_id: "wf-erp-8b",
          updated_at: new Date().toISOString(),
          task_origin_json: { system: "sentry", id: "7869873339", label: "ERP-8B" },
          task_relations_json: [
            { system: "zettly", id: "1233", relation: "tracks" },
            { system: "sentry", id: "7869873339", relation: "source_issue", label: "ERP-8B" },
          ],
        },
      ],
    }),
  });

  const options = {
    env: { DEVWF_MONITOR_URL: "http://127.0.0.1:3100" },
    fetchImpl: mockMonitorFetch,
    sentry: {
      organization: "example",
      async listIssues() {
        return [issueClaimed, issueFree];
      },
      async getIssue(id) {
        return id === "7869873339" ? issueClaimed : issueFree;
      },
    },
  };

  const workflowState = {
    sessionId: "ses_caller",
    state: { currentPhase: "idle" },
  };

  const listRes = await handleIntegrationTool("list_sentry_issues", {}, workflowState, options);
  assert.ok(!listRes.isError, text(listRes));
  const listData = JSON.parse(text(listRes));
  const rows = Array.isArray(listData) ? listData : listData.issues;
  assert.equal(rows.length, 2);

  const row8b = rows.find((r) => r.id === "7869873339");
  const row9c = rows.find((r) => r.id === "7869879999");

  assert.ok(row8b.activeClaim, "claimed issue must carry activeClaim metadata");
  assert.equal(row8b.activeClaim.claimed, true);
  assert.equal(row8b.activeClaim.sessionKey, "ses_worker_mmch");
  assert.equal(row8b.activeClaim.machine, "MMCH");
  assert.equal(row8b.activeClaim.agentTool, "opencode");
  assert.equal(row8b.activeClaim.phase, "coding");
  assert.equal(row8b.activeClaim.todoId, 1233);
  assert.equal(row9c.activeClaim, null);

  const singleRes = await handleIntegrationTool(
    "get_sentry_issue",
    { issueId: "7869873339" },
    workflowState,
    options,
  );
  const singleData = JSON.parse(text(singleRes));
  assert.ok(singleData.activeClaim);
  assert.equal(singleData.activeClaim.sessionKey, "ses_worker_mmch");
});

test("checkSentryPreemption skips unresolved Sentry issues that are already claimed by a live AI session", async () => {
  resetSentryPreemptionCache();
  const env = {
    DEVWF_PREEMPTION_ENABLED: "1",
    DEVWF_PREEMPTION_SENTRY_PROJECT: "erp",
    DEVWF_PREEMPTION_QUERY: "is:unresolved project:erp",
    DEVWF_PREEMPTION_PROJECT_DIR_MARKERS: "/code/erp.beautyworld.co.id",
    DEVWF_MONITOR_URL: "http://127.0.0.1:3100",
  };
  const claimedIssue = {
    id: "7869873339",
    shortId: "ERP-8B",
    title: "N+1 Query on stock-usage",
    project: { slug: "erp" },
  };

  const mockMonitorFetch = async () => ({
    ok: true,
    json: async () => ({
      sessions: [
        {
          session_key: "ses_erp_worker",
          machine: "MMCH",
          agent_tool: "opencode",
          project_name: "erp.beautyworld.co.id",
          phase: "testing",
          state: "live",
          task: "Release the ERP-8B N+1 fix",
          updated_at: new Date().toISOString(),
          task_origin_json: { system: "sentry", id: "7869873339", label: "ERP-8B" },
          task_relations_json: [],
        },
      ],
    }),
  });

  const result = await checkSentryPreemption({
    projectDir: "D:\\code\\clinic",
    mode: "start_task",
    options: {
      env,
      fetchImpl: mockMonitorFetch,
      sentry: {
        organization: "example",
        async listIssues() {
          return [claimedIssue];
        },
      },
    },
  });

  assert.equal(
    result.preempted,
    false,
    "An issue already claimed by a live AI session must not preempt other sessions",
  );
  assert.equal(result.response, null);
});

test("start_task refuses when the requested source issue or Todo is already claimed by another live AI session unless forceClaim is true", async () => {
  const tempRepoDir = mkdtempSync(path.join(os.tmpdir(), "dwf-claim-repo-"));
  execFileSync("git", ["init"], { cwd: tempRepoDir, stdio: "ignore" });
  writeFileSync(path.join(tempRepoDir, "README.md"), "# Test Repo\n", "utf8");
  try {
    await withWorkflowState(async (workflowState) => {
      workflowState.sessionId = "ses_new_caller";
      const mockMonitorFetch = async () => ({
        ok: true,
        json: async () => ({
          sessions: [
            {
              session_key: "ses_existing_owner",
              machine: "Mac",
              agent_tool: "opencode",
              project_name: "clinic",
              phase: "coding",
              state: "live",
              task: "Fix Sentry issue 123 (APP-1)",
              workflow_task_id: "wf-123",
              updated_at: new Date().toISOString(),
              task_origin_json: { system: "sentry", id: "123", label: "APP-1" },
              task_relations_json: [{ system: "zettly", id: "166", relation: "tracks" }],
            },
          ],
        }),
      });

      const integrationOptions = {
        env: { DEVWF_MONITOR_URL: "http://127.0.0.1:3100" },
        fetchImpl: mockMonitorFetch,
        sentry: {
          organization: "example",
          async getIssue(id) {
            return {
              id,
              shortId: "APP-1",
              title: "Example issue",
              permalink: `https://example.sentry.io/issues/${id}/`,
            };
          },
        },
      };

      const refused = await handleToolCall({
        request: createRequest("start_task", {
          description: "Fix Sentry issue 123",
          type: "bugfix",
          projectDir: tempRepoDir,
          source: { system: "sentry", id: "123" },
          definitionOfDone: ["Regression test passes"],
          plan: ["Write failing test", "Apply fix"],
        }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: createGitMock(),
        utils: testUtils,
        integrationOptions,
        zettlyOptions: {
          env: { DEVWF_ZETTLY_SYNC: "0", DEVWF_MONITOR_URL: "http://127.0.0.1:3100" },
          fetchImpl: mockMonitorFetch,
        },
      });

      assert.match(text(refused), /already claimed/i);
      assert.match(text(refused), /ses_existing_owner/);
      assert.match(text(refused), /Mac/);
      assert.equal(workflowState.state.currentPhase, "idle");

      const forced = await handleToolCall({
        request: createRequest("start_task", {
          description: "Fix Sentry issue 123 with explicit override",
          type: "bugfix",
          projectDir: tempRepoDir,
          source: { system: "sentry", id: "123" },
          forceClaim: true,
          definitionOfDone: ["Regression test passes"],
          plan: ["Write failing test", "Apply fix"],
        }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: createGitMock(),
        utils: testUtils,
        integrationOptions,
        zettlyOptions: {
          env: { DEVWF_ZETTLY_SYNC: "0", DEVWF_MONITOR_URL: "http://127.0.0.1:3100" },
          fetchImpl: mockMonitorFetch,
        },
      });

      assert.match(text(forced), /Task Started/);
      assert.equal(workflowState.state.currentPhase, "coding");
    });
  } finally {
    rmSync(tempRepoDir, { recursive: true, force: true });
  }
});

test("zettly-workflow claims and updates an existing open Zettly Todo matching Sentry issue ID or shortId instead of creating a duplicate Todo", async () => {
  const tasks = new Map();
  tasks.set(1239, {
    id: 1239,
    type: "todo",
    title: "[P0 · ERP-8B] Fix erp.beautyworld.co.id: N+1 Query",
    description:
      "Auto-ingested P0 production issue from Sentry.\nSentry Issue ID: 7869873339\nSentry Short ID: ERP-8B",
    is_completed: false,
  });

  const calls = [];
  const client = {
    async request(method, route, body) {
      calls.push({ method, route, body });
      if (route === "/todos" && method === "GET") return { data: [...tasks.values()] };
      if (route === "/todos" && method === "POST") {
        const created = { ...body, id: 9999, is_completed: false };
        tasks.set(created.id, created);
        return { data: created };
      }
      if (route.startsWith("/todos/")) {
        const id = Number(route.split("/")[2]);
        const existing = tasks.get(id);
        if (method === "PATCH") Object.assign(existing, body);
        return { data: structuredClone(existing) };
      }
      return { data: {} };
    },
  };

  const wf = {
    state: {
      taskDescription: "Fix ERP-8B N+1 Query on stock-usage",
      taskType: "bugfix",
      projectDir: "/repo/erp",
      taskStartedAt: "2026-11-27T02:00:00Z",
      currentPhase: "coding",
      definitionOfDone: [{ id: "dod-1", text: "Fix verified", status: "open" }],
      plan: [{ id: "plan-1", text: "Batch insert", status: "open" }],
      zettlyOutbox: [],
    },
    async save() {
      return { verified: true };
    },
  };

  assignWorkflowIdentity(wf.state, null, {
    source: { system: "sentry", id: "7869873339", label: "ERP-8B" },
    verifiedSourceIssue: {
      issueId: "7869873339",
      shortId: "ERP-8B",
      url: "https://programinglive.sentry.io/issues/7869873339/",
      organization: "programinglive",
    },
  });

  const res = await syncZettlyTask(wf, {
    env: { DEVWF_ZETTLY_SYNC: "1" },
    client,
  });

  assert.equal(res.ok, true);
  assert.equal(
    wf.state.zettly.todoId,
    1239,
    "Must claim existing open Todo #1239 instead of creating a new one",
  );
  assert.equal(tasks.size, 1, "No duplicate Todo should be created");
  assert.equal(calls.filter((c) => c.method === "POST" && c.route === "/todos").length, 0);
  assert.match(tasks.get(1239).description, /Status: coding/);
  assert.match(tasks.get(1239).description, /Auto-ingested P0 production issue/);
});
