import { test } from "node:test";
import assert from "node:assert";

import {
  handleListFactoryTasks,
  handleClaimFactoryTask,
  handleSyncTaskStatus,
} from "../tools/handler-modules/factory-handlers.js";

function setEnv() {
  process.env.FACTORY_PB_URL = "https://pb.example.com";
  process.env.FACTORY_PB_IDENTITY = "agent@example.com";
  process.env.FACTORY_PB_PASSWORD = "secret";
}

function clearEnv() {
  delete process.env.FACTORY_PB_URL;
  delete process.env.FACTORY_PB_IDENTITY;
  delete process.env.FACTORY_PB_PASSWORD;
  delete process.env.FACTORY_MACHINE_ID;
}

function text(response) {
  return response?.content?.[0]?.text ?? "";
}

// ---------------------------------------------------------------------------

test("list tool explains how to configure Factory instead of failing", async () => {
  clearEnv();
  const out = text(await handleListFactoryTasks({}));

  assert.match(out, /not configured/i);
  assert.match(out, /FACTORY_PB_URL/);
  assert.match(out, /FACTORY_PB_PASSWORD/);
  assert.doesNotMatch(out, /secret/i);
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
    // Either the local validation or the remote error path is acceptable,
    // but it must not report success.
    assert.doesNotMatch(out, /Updated/);
  } finally {
    clearEnv();
  }
});

test("sync tool requires a reason when blocking", async () => {
  setEnv();
  try {
    const out = text(await handleSyncTaskStatus({ recordId: "r1", status: "blocked" }));
    assert.doesNotMatch(out, /Updated/);
    assert.match(out, /reason|blocked/i);
  } finally {
    clearEnv();
  }
});

// ---------------------------------------------------------------------------
// Handler wiring: the claim handler must start a local workflow
// ---------------------------------------------------------------------------

test("claim handler resets local workflow state to the claimed task", async () => {
  setEnv();
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (String(url).includes("auth-with-password")) {
      return new Response(JSON.stringify({ token: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/records?") || String(url).includes("/records?")) {
      return new Response(JSON.stringify({ items: [{
        id: "rec1", task_key: "ACT-1", title: "Do the thing", project: "repo",
        status: "open", next_action: "Start here", priority: "high",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/records/rec1") && (options.method || "") === "PATCH") {
      return new Response(JSON.stringify({
        id: "rec1", task_key: "ACT-1", title: "Do the thing", project: "repo",
        status: "in_progress", next_action: "Start here", priority: "high",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };

  const saved = [];
  const workflowState = {
    state: { currentPhase: "idle", taskDescription: "", taskType: "" },
    reset() { this.state = { currentPhase: "idle", taskDescription: "", taskType: "" }; },
    async save() { saved.push({ ...this.state }); },
  };

  try {
    const out = text(await handleClaimFactoryTask({ recordId: "rec1" }, { workflowState }));

    assert.match(out, /Claimed ACT-1/);
    assert.strictEqual(workflowState.state.currentPhase, "coding");
    assert.match(workflowState.state.taskDescription, /ACT-1: Do the thing/);
    assert.strictEqual(saved.length, 1);

    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "a PATCH should be sent to mark the task in_progress");
  } finally {
    globalThis.fetch = originalFetch;
    clearEnv();
  }
});
