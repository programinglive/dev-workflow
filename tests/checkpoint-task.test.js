import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowState } from "../workflow-state.js";
import { handleCheckpointTask } from "../tools/handler-modules/checkpoint-handlers.js";

const saved = { stateFile: process.env.DEV_WORKFLOW_STATE_FILE, monitor: process.env.DEVWF_MONITOR_URL };

async function withState(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwf-ckpt-"));
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

/** A Zettly stub that stores the description we PATCH and returns it on GET. */
function fakeZettly({ dropElement = false } = {}) {
  let description = "";
  return {
    calls: [],
    async request(method, route, body) {
      this.calls.push({ method, route });
      if (method === "GET" && /^\/todos\/\d+$/.test(route)) {
        const stored = dropElement
          ? description.replace(/<script[\s\S]*?<\/script>/gi, "")
          : description;
        return { success: true, data: { id: 447, description: stored } };
      }
      if (method === "PATCH" || method === "PUT") {
        if (body && typeof body.description === "string") description = body.description;
        return { success: true, data: { id: 447, description } };
      }
      if (method === "POST") {
        if (body && typeof body.description === "string") description = body.description;
        return { success: true, data: { id: 447, description } };
      }
      return { success: true, data: { id: 447, description } };
    },
  };
}

function taskState(ws) {
  ws.state.currentPhase = "coding";
  ws.state.taskDescription = "checkpoint the runner work";
  ws.state.projectDir = "";
  ws.state.workflowTaskId = "wf-1";
  ws.state.zettly = { todoId: 447 };
  ws.state.machine = "Mac";
  ws.state.checkpoint = { checkpointedAt: null, summary: "", baseSha: null, commits: [], handover: null };
  return ws;
}

test("checkpoint_task refuses when no task was started", async () => {
  await withState(async (ws) => {
    const result = await handleCheckpointTask({ summary: "x" }, { workflowState: ws, client: fakeZettly() });
    assert.equal(result.ok, false);
    assert.match(result.note, /no task/i);
  });
});

test("checkpoint_task reports confirmed only after reading the element back", async () => {
  await withState(async (ws) => {
    const result = await handleCheckpointTask(
      { summary: "half done" },
      { workflowState: taskState(ws), client: fakeZettly() }
    );
    assert.equal(result.confirmed, true);
    assert.equal(result.ok, true);
  });
});

test("checkpoint_task reports unconfirmed when the element is not readable back", async () => {
  await withState(async (ws) => {
    const result = await handleCheckpointTask(
      { summary: "half done" },
      { workflowState: taskState(ws), client: fakeZettly({ dropElement: true }) }
    );
    assert.equal(result.confirmed, false);
    assert.match(result.note, /not confirmed/i);
  });
});

test("showRevertPlan appends a read-only revert record to the checkpoint note", async () => {
  await withState(async (ws) => {
    const wst = taskState(ws);
    // No real repo: the git adapter yields no candidates and no refusals, so
    // the note must still say the record was produced and nothing was executed.
    const result = await handleCheckpointTask(
      { summary: "half done", showRevertPlan: true },
      { workflowState: wst, client: fakeZettly() }
    );
    assert.equal(result.ok, true);
    assert.match(result.note, /Revert candidates/i);
    assert.match(result.note, /recorded only; nothing is executed/i);
  });
});
