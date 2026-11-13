import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleStartTask } from "../tools/handler-modules/workflow-handlers.js";

/**
 * A Zettelkasten chain must survive `start_task`. Today the second task
 * overwrites the first one in place and nothing links them, so a multi-topic
 * session reads as a single mutating card.
 */

async function withState(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-card-chain-"));
  const stateFile = path.join(dir, "workflow-state.json");
  const ws = new WorkflowState(stateFile);
  await ws.load();
  try {
    await callback(ws, stateFile);
  } finally {
    try {
      ws.db?.close?.();
      ws.store?.db?.close?.();
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Windows may keep a SQLite WAL handle open; the temp dir is disposable.
    }
  }
}

test("the first task of a session has no parent card", async () => {
  await withState(async (ws) => {
    await handleStartTask(
      { description: "first topic", type: "feature", definitionOfDone: ["build passes"], plan: ["one step"] },
      ws,
      null,
    );

    assert.equal(ws.state.parentTask, null);
  });
});

test("a second task records the previous task as its parent card", async () => {
  await withState(async (ws) => {
    await handleStartTask(
      { description: "first topic", type: "feature", definitionOfDone: ["build passes"], plan: ["one step"] },
      ws,
      null,
    );
    const firstTaskId = ws.state.workflowTaskId;
    const firstStartedAt = ws.state.taskStartedAt;
    assert.ok(firstTaskId, "first task must have an id");
    assert.ok(firstStartedAt, "first task must record its start time");

    await handleStartTask(
      { description: "second topic", type: "bugfix", definitionOfDone: ["regression test passes"], plan: ["one step"] },
      ws,
      null,
    );

    // assignWorkflowIdentity is the single writer of state.parentTask, in
    // main's shape {id, description, title, todoId}.
    assert.deepEqual(ws.state.parentTask, {
      id: firstTaskId,
      description: "first topic",
      title: "first topic",
      todoId: null,
    });
    assert.notEqual(ws.state.workflowTaskId, firstTaskId, "the new card needs its own id");
  });
});

test("a chained card starts with a clean build state", async () => {
  await withState(async (ws) => {
    await handleStartTask(
      { description: "first topic", type: "feature", definitionOfDone: ["build passes"], plan: ["one step"] },
      ws,
      null,
    );
    ws.state.activeBuild = { stage: "test", startedAt: new Date().toISOString() };
    ws.state.buildHistory = [{ stage: "test", status: "passed" }];

    await handleStartTask(
      { description: "second topic", type: "feature", definitionOfDone: ["build passes"], plan: ["one step"] },
      ws,
      null,
    );

    assert.equal(ws.state.activeBuild, null);
    assert.deepEqual(ws.state.buildHistory, []);
  });
});

test("the parent card survives a reload from disk", async () => {
  await withState(async (ws, stateFile) => {
    await handleStartTask(
      { description: "first topic", type: "feature", definitionOfDone: ["build passes"], plan: ["one step"] },
      ws,
      null,
    );
    await handleStartTask(
      { description: "second topic", type: "feature", definitionOfDone: ["build passes"], plan: ["one step"] },
      ws,
      null,
    );
    const parent = ws.state.parentTask;
    assert.ok(parent && parent.id, "the parent card must exist before the reload");

    const reloaded = new WorkflowState(stateFile);
    await reloaded.load();
    try {
      assert.deepEqual(reloaded.state.parentTask, parent);
    } finally {
      reloaded.db?.close?.();
      reloaded.store?.db?.close?.();
    }
  });
});
