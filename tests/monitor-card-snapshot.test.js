import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSnapshot } from "../monitor.js";

/**
 * The monitor can only keep one card per task if the snapshot says which task
 * it belongs to. Without `taskId` the server has nothing to key a card on, and
 * without `parentTask` it cannot draw either direction of the chain.
 */

test("buildSnapshot carries the task id of the current card", () => {
  const snapshot = buildSnapshot({
    state: { taskDescription: "second topic", workflowTaskId: "task-b", owner: {} },
    sessionKey: "ses_X",
    env: {},
  });

  assert.equal(snapshot.taskId, "task-b");
});

test("buildSnapshot carries the parent card of a chained task", () => {
  const parentTask = { taskId: "task-a", title: "first topic", startedAt: "2026-11-08T00:00:00.000Z" };
  const snapshot = buildSnapshot({
    state: { taskDescription: "second topic", workflowTaskId: "task-b", parentTask, owner: {} },
    env: {},
  });

  assert.deepEqual(snapshot.parentTask, parentTask);
});

test("buildSnapshot reports no parent for the first card of a session", () => {
  const snapshot = buildSnapshot({
    state: { taskDescription: "first topic", workflowTaskId: "task-a", parentTask: null, owner: {} },
    env: {},
  });

  assert.equal(snapshot.parentTask, null);
});

test("buildSnapshot ignores a parent without an id", () => {
  const snapshot = buildSnapshot({
    state: { taskDescription: "second topic", workflowTaskId: "task-b", parentTask: { title: "" }, owner: {} },
    env: {},
  });

  assert.equal(snapshot.parentTask, null);
});

test("buildSnapshot never leaks a build box into a card without one", () => {
  const snapshot = buildSnapshot({
    state: { taskDescription: "second topic", workflowTaskId: "task-b", activeBuild: null, owner: {} },
    env: {},
  });

  assert.equal(snapshot.activeBuild, null);
});
