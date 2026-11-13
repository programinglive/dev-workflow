import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildForCard, cardKey } = require("../monitor-server/card-chain.cjs");

/**
 * A live build box must never leak into the next card of the same session.
 * The build map used to be keyed by session only, so a task started while the
 * previous one was building inherited its box on the dashboard.
 */

test("a build box belongs to exactly one card", () => {
  const entry = { taskId: "task-a", build: { stage: "test" } };
  assert.deepEqual(buildForCard(entry, { task_id: "task-a" }), { stage: "test" });
  assert.equal(buildForCard(entry, { task_id: "task-b" }), null);
  assert.equal(buildForCard(null, { task_id: "task-a" }), null);
});

test("a card without an id only matches a build entry without one", () => {
  assert.equal(buildForCard({ taskId: "", build: { stage: "build" } }, { task_id: "task-b" }), null);
  assert.deepEqual(buildForCard({ taskId: "", build: { stage: "build" } }, { task_id: "" }), { stage: "build" });
});

test("two cards of one session get different build keys", () => {
  assert.notEqual(cardKey("ses_1", "task-a"), cardKey("ses_1", "task-b"));
  assert.equal(cardKey("ses_1", "task-a"), cardKey("ses_1", "task-a"));
});
