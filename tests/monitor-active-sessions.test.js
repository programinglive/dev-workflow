import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchActiveSessions, localMonitorUrl } from "../monitor.js";
import { handleListActiveSessions } from "../tools/handler-modules/status-handlers.js";
import { getToolList } from "../tools/definitions.js";

const SAMPLE_SESSIONS = [
  {
    session_key: "ses_1",
    machine: "HELLOWORLD",
    project_name: "dev-workflow-mcp-server",
    task: "Implement feature",
    phase: "coding",
    state: "live",
    state_label: "aktif",
    plan_done: 1,
    plan_total: 3,
    dod_done: 2,
    dod_total: 4,
    updated_at: "2026-11-03T02:15:00.000Z",
  },
  {
    session_key: "ses_2",
    machine: "Mac",
    project_name: "clinic",
    task: "Fix bug",
    phase: "ready",
    state: "ended",
    state_label: "berakhir",
    plan_done: 2,
    plan_total: 2,
    dod_done: 3,
    dod_total: 3,
    updated_at: "2026-11-03T01:00:00.000Z",
  },
];

test("fetchActiveSessions returns error when DEVWF_MONITOR_URL is not configured", async () => {
  const res = await fetchActiveSessions({ env: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /DEVWF_MONITOR_URL/i);
});

test("fetchActiveSessions swallows network failure gracefully", async () => {
  const res = await fetchActiveSessions({
    env: { DEVWF_MONITOR_URL: "http://100.107.65.21:3100" },
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNREFUSED/);
});

test("fetchActiveSessions fetches GET /api/sessions and returns data", async () => {
  let requestedUrl = "";
  let requestedOpts = {};
  const res = await fetchActiveSessions({
    env: { DEVWF_MONITOR_URL: "http://100.107.65.21:3100" },
    limit: 10,
    fetchImpl: async (url, opts) => {
      requestedUrl = url;
      requestedOpts = opts;
      return {
        ok: true,
        json: async () => ({ sessions: SAMPLE_SESSIONS }),
      };
    },
  });

  assert.equal(res.ok, true);
  assert.match(requestedUrl, /\/api\/sessions\?limit=10/);
  assert.equal(requestedOpts.method, "GET");
  assert.equal(res.sessions.length, 2);
});

test("handleListActiveSessions formats session list into markdown", async () => {
  const output = await handleListActiveSessions(
    { all: true },
    {
      env: { DEVWF_MONITOR_URL: "http://100.107.65.21:3100" },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ sessions: SAMPLE_SESSIONS }),
      }),
    }
  );

  assert.ok(output.content && output.content[0]);
  const text = output.content[0].text;
  assert.match(text, /🔗 Dashboard: http:\/\/100\.107\.65\.21:3100/);
  assert.match(text, /HELLOWORLD/);
  assert.match(text, /dev-workflow-mcp-server/);
  assert.match(text, /Implement feature/);
  assert.match(text, /Mac/);
});

test("handleListActiveSessions filters only active sessions by default (all: false)", async () => {
  const output = await handleListActiveSessions(
    { all: false },
    {
      env: { DEVWF_MONITOR_URL: "http://100.107.65.21:3100" },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ sessions: SAMPLE_SESSIONS }),
      }),
    }
  );

  const text = output.content[0].text;
  assert.match(text, /HELLOWORLD/);
  assert.doesNotMatch(text, /Mac/);
});

test("list_active_sessions is registered in getToolList", () => {
  const tools = getToolList();
  const tool = tools.find((t) => t.name === "list_active_sessions");
  assert.ok(tool, "tool list_active_sessions must be defined");
  assert.equal(typeof tool.description, "string");
  assert.ok(tool.inputSchema);
});

test("localMonitorUrl returns DEVWF_LOCAL_URL from env", () => {
  assert.equal(localMonitorUrl({ DEVWF_LOCAL_URL: "http://localhost:3100" }), "http://localhost:3100");
});

test("localMonitorUrl returns empty string when DEVWF_LOCAL_URL is not set", () => {
  assert.equal(localMonitorUrl({}), "");
});

test("handleListActiveSessions shows local browser URL when DEVWF_LOCAL_URL is set", async () => {
  const output = await handleListActiveSessions(
    { all: true },
    {
      env: {
        DEVWF_MONITOR_URL: "http://100.107.65.21:3100",
        DEVWF_LOCAL_URL: "http://localhost:3100",
      },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ sessions: SAMPLE_SESSIONS }),
      }),
    }
  );

  const text = output.content[0].text;
  assert.match(text, /🖥️.*Buka di browser.*localhost:3100/);
});

test("handleListActiveSessions does NOT show local URL when DEVWF_LOCAL_URL equals DEVWF_MONITOR_URL", async () => {
  const output = await handleListActiveSessions(
    { all: true },
    {
      env: {
        DEVWF_MONITOR_URL: "http://100.107.65.21:3100",
        DEVWF_LOCAL_URL: "http://100.107.65.21:3100",
      },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ sessions: SAMPLE_SESSIONS }),
      }),
    }
  );

  const text = output.content[0].text;
  assert.doesNotMatch(text, /Buka di browser/);
});
