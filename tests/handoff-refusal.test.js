import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowState } from "../workflow-state.js";
import { handleHandoffTask, handoffGuard } from "../tools/handler-modules/checkpoint-handlers.js";
import { handleStartTask } from "../tools/handler-modules/workflow-handlers.js";

const saved = { stateFile: process.env.DEV_WORKFLOW_STATE_FILE, monitor: process.env.DEVWF_MONITOR_URL };

async function withState(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwf-handoff-"));
  process.env.DEV_WORKFLOW_STATE_FILE = path.join(dir, "state.json");
  process.env.DEVWF_MONITOR_URL = "http://127.0.0.1:9";
  let ws;
  try {
    ws = new WorkflowState();
    await ws.load();
    ws.state.currentPhase = "idle";
    ws.state.taskDescription = "";
    await ws.save();
    return await fn(ws);
  } finally {
    if (ws?.dbAdapter && typeof ws.dbAdapter.close === "function") await ws.dbAdapter.close();
    else if (ws?.dbAdapter?.db && typeof ws.dbAdapter.db.close === "function") ws.dbAdapter.db.close();
    rmSync(dir, { recursive: true, force: true });
    if (saved.stateFile === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = saved.stateFile;
    if (saved.monitor === undefined) delete process.env.DEVWF_MONITOR_URL;
    else process.env.DEVWF_MONITOR_URL = saved.monitor;
  }
}

/** A Zettly stub that stores and returns descriptions so read-back can succeed. */
function fakeZettly() {
  let description = "";
  return {
    async request(method, route, body) {
      if ((method === "PATCH" || method === "PUT" || method === "POST") && body?.description) {
        description = body.description;
      }
      if (method === "GET" && /^\/todos\/\d+$/.test(route)) {
        return { success: true, data: { id: 447, description } };
      }
      return { success: true, data: { id: 447, description } };
    },
  };
}

function taskState(ws) {
  ws.state.currentPhase = "coding";
  ws.state.taskDescription = "the handed task";
  ws.state.projectDir = "";
  ws.state.workflowTaskId = "wf-4";
  ws.state.zettly = { todoId: 447 };
  ws.state.machine = "Mac";
  ws.state.checkpoint = { checkpointedAt: null, summary: "", baseSha: null, commits: [], handover: null };
  return ws;
}

test("a handoff without a reason is refused", async () => {
  await withState(async (ws) => {
    const result = await handleHandoffTask({ to: "MMCH", reason: "" }, { workflowState: taskState(ws), client: fakeZettly() });
    assert.equal(result.ok, false);
    assert.match(result.note, /reason/i);
  });
});

test("a handoff to the same machine is refused", async () => {
  await withState(async (ws) => {
    const result = await handleHandoffTask({ to: "Mac", reason: "why not" }, { workflowState: taskState(ws), client: fakeZettly() });
    assert.equal(result.ok, false);
    assert.match(result.note, /same machine/i);
  });
});

test("a handoff records the marker and confirms the checkpoint", async () => {
  await withState(async (ws) => {
    const result = await handleHandoffTask({ to: "MMCH", reason: "laptop left behind" }, { workflowState: taskState(ws), client: fakeZettly() });
    assert.equal(result.ok, true);
    assert.equal(result.confirmed, true);
    assert.equal(ws.state.checkpoint.handover.to, "MMCH");
    assert.equal(ws.state.checkpoint.handover.from, "Mac");
    assert.equal(ws.state.checkpoint.handover.reason, "laptop left behind");
  });
});

test("handoffGuard reports a recorded handover", async () => {
  await withState(async (ws) => {
    const state = taskState(ws).state;
    assert.equal(handoffGuard(state).handedOver, false);
    state.checkpoint.handover = { from: "Mac", to: "MMCH", reason: "gone", at: "2026-11-09T10:00:00.000Z", sessionKey: "ses_x" };
    const guard = handoffGuard(state);
    assert.equal(guard.handedOver, true);
    assert.equal(guard.to, "MMCH");
  });
});

test("a marker whose target is this machine does not block the target", async () => {
  await withState(async (ws) => {
    const state = taskState(ws).state;
    // This machine is MMCH and the marker says the task was handed to MMCH:
    // MMCH is the one allowed to continue; only the source (Mac) is refused.
    state.machine = "MMCH";
    state.checkpoint.handover = { from: "Mac", to: "MMCH", reason: "laptop left behind", at: "2026-11-09T10:00:00.000Z", sessionKey: "ses_x" };
    assert.equal(handoffGuard(state).handedOver, false);
  });
});

test("a session whose task was handed over refuses to continue", async () => {
  await withState(async (ws) => {
    const workflowState = taskState(ws);
    workflowState.state.checkpoint.handover = { from: "Mac", to: "MMCH", reason: "laptop left behind", at: "2026-11-09T10:00:00.000Z", sessionKey: "ses_x" };
    const result = await handleStartTask(
      { description: "continue the work", type: "feature", definitionOfDone: ["the work is done"], plan: ["do the thing"] },
      workflowState,
      null
    );
    assert.match(result.content[0].text, /handed over to MMCH/);
  });
});
