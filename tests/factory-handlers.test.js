import { test } from "node:test";
import assert from "node:assert";

import {
  handleListFactoryTasks,
  handleClaimFactoryTask,
  handleSyncTaskStatus,
} from "../tools/handler-modules/factory-handlers.js";
import { clearTokenCache } from "../factory-client.js";

const TASK_ID = "33333333-3333-4333-8333-333333333333";
const BACKLOG_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const WORKSPACE = {
  projects: [{ id: "p1", name: "programinglive/dev-workflow-mcp-server" }],
  tasks: [
    {
      id: TASK_ID,
      projectId: "p1",
      title: "Sambungkan MCP ke Factory",
      description: "",
      acceptance: "npm test hijau",
      priority: "high",
      status: "running",
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
      work: {
        id: "sess-1",
        state: "active",
        activityStatus: "active",
        step: "Menulis klien",
        summary: "",
        device: { id: DEVICE_ID, name: "HELLOWORLD" },
        startedAt: "2026-10-26T01:00:00.000Z",
      },
    },
    {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "p1",
      title: "Task backlog",      description: "",
      acceptance: "selesai",
      priority: "normal",
      status: "backlog",
      createdAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      work: null,
    },
  ],
  events: [],
};

function setEnv() {
  process.env.FACTORY_URL = "https://factory.test";
  process.env.FACTORY_TOKEN = "tok";
  process.env.FACTORY_DEVICE_ID = DEVICE_ID;
  process.env.FACTORY_MACHINE_ID = "HELLOWORLD";
  clearTokenCache();
}

function clearEnv() {
  for (const key of [
    "FACTORY_URL",
    "FACTORY_TOKEN",
    "FACTORY_DEVICE_ID",
    "FACTORY_MACHINE_ID",
    "FACTORY_EMAIL",
    "FACTORY_PASSWORD",
  ]) {
    delete process.env[key];
  }
  clearTokenCache();
}

function text(response) {
  return response?.content?.[0]?.text ?? "";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------

test("list tool explains how to configure Factory instead of failing", async () => {
  clearEnv();
  const out = text(await handleListFactoryTasks({}));

  assert.match(out, /not configured/i);
  assert.match(out, /FACTORY_URL/);
  assert.match(out, /FACTORY_TOKEN/);
  assert.doesNotMatch(out, /secret/i);
});

test("list tool renders the real board", async () => {
  setEnv();
  const stub = stubFetch((call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : json({}, 500)));
  try {
    const out = text(await handleListFactoryTasks({}));

    assert.match(out, /Sambungkan MCP ke Factory/);
    assert.match(out, /running/);
    assert.match(out, /dev-workflow-mcp-server/);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("list tool includes backlog by default", async () => {
  setEnv();
  const stub = stubFetch((call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : json({}, 500)));
  try {
    const out = text(await handleListFactoryTasks({}));
    assert.match(out, /Task backlog/);
    assert.match(out, /backlog/);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("claim tool refuses without a recordId", async () => {
  setEnv();
  try {
    const out = text(await handleClaimFactoryTask({}, { workflowState: null }));
    assert.match(out, /recordId/i);
  } finally {
    clearEnv();
  }
});

test("sync tool refuses an unknown status", async () => {
  setEnv();
  try {
    const out = text(await handleSyncTaskStatus({ recordId: "r1", status: "shipped" }));
    assert.doesNotMatch(out, /Updated/);
    assert.match(out, /Unknown status/);
  } finally {
    clearEnv();
  }
});

test("sync tool explains that running comes from claiming", async () => {
  setEnv();
  try {
    const out = text(await handleSyncTaskStatus({ recordId: "r1", status: "running" }));
    assert.match(out, /claim_factory_task/);
  } finally {
    clearEnv();
  }
});

test("sync tool refuses done because a human decides it", async () => {
  setEnv();
  try {
    const out = text(await handleSyncTaskStatus({ recordId: "r1", status: "done" }));
    assert.match(out, /human/i);
  } finally {
    clearEnv();
  }
});

test("sync tool requires a reason when blocking", async () => {
  setEnv();
  try {
    const out = text(await handleSyncTaskStatus({ recordId: "r1", status: "blocked" }));
    assert.doesNotMatch(out, /Updated/);
    assert.match(out, /reason/i);
  } finally {
    clearEnv();
  }
});

// ---------------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------------

test("claim handler opens a work session and starts the local workflow", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) return json({ session: { id: "sess-new", state: "active" } });
    return json({}, 500);
  });

  const saved = [];
  const workflowState = {
    state: { currentPhase: "idle", taskDescription: "", taskType: "" },
    reset() { this.state = { currentPhase: "idle", taskDescription: "", taskType: "" }; },
    async save() { saved.push({ ...this.state }); },
  };

  try {
    const out = text(await handleClaimFactoryTask({ recordId: BACKLOG_ID, step: "Mulai kerja" }, { workflowState }));

    assert.match(out, /Claimed/);
    assert.match(out, /running/);
    assert.strictEqual(workflowState.state.currentPhase, "coding");
    assert.match(workflowState.state.taskDescription, /Sambungkan MCP ke Factory|Task backlog/);
    assert.strictEqual(saved.length, 1);

    const start = stub.calls.find((call) => call.url.endsWith("/api/work"));
    assert.ok(start, "a POST /api/work should be sent");
    assert.strictEqual(start.body.action, "start");
    assert.strictEqual(start.body.step, "Mulai kerja");
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("claim handler refuses a task that already has an active session", async () => {
  setEnv();
  const stub = stubFetch((call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : json({}, 500)));
  try {
    const out = text(await handleClaimFactoryTask({ recordId: TASK_ID }, { workflowState: null }));
    assert.match(out, /already has an active work session/);
    assert.strictEqual(stub.calls.filter((call) => call.url.endsWith("/api/work")).length, 0);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("sync handler finishes the session for review", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) {
      return json({ session: { id: "sess-1", state: "review", summary: "Selesai, minta review." } });
    }
    return json({}, 500);
  });

  try {
    const out = text(await handleSyncTaskStatus({ recordId: TASK_ID, status: "review", reason: "Selesai, minta review." }));

    assert.match(out, /Updated/);
    assert.match(out, /review/);
    const finish = stub.calls.find((call) => call.url.endsWith("/api/work"));
    assert.strictEqual(finish.body.action, "finish");
    assert.strictEqual(finish.body.deviceId, DEVICE_ID);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("sync handler reports a Factory error instead of claiming success", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) return json({ error: "Sesi dimiliki perangkat lain." }, 409);
    return json({}, 500);
  });

  try {
    const out = text(await handleSyncTaskStatus({ recordId: TASK_ID, status: "review", reason: "Selesai." }));
    assert.doesNotMatch(out, /Updated/);
    assert.match(out, /perangkat lain|Could not update/);
  } finally {
    stub.restore();
    clearEnv();
  }
});
