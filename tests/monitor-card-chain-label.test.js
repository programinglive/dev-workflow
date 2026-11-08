import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chainLabels } = require("../monitor-server/card-chain.cjs");

/**
 * Two directions of a Zettelkasten link must come from the same data: the
 * child knows its parent id, and the parent finds its child among the rows the
 * dashboard already has. No second query and no guessing.
 */

const child = {
  session_key: "ses_1",
  task_id: "task-b",
  task: "second topic",
  parent_task_id: "task-a",
  parent_task_title: "first topic",
};

const parent = { session_key: "ses_1", task_id: "task-a", task: "first topic" };
const unrelated = { session_key: "ses_1", task_id: "task-z", task: "other topic" };

test("the child card points back at the card it continued", () => {
  const { from, to } = chainLabels(child, [parent, child, unrelated]);
  assert.equal(from, "first topic");
  assert.equal(to, "");
});

test("the parent card points forward at the card that continued it", () => {
  const { from, to } = chainLabels(parent, [parent, child, unrelated]);
  assert.equal(from, "");
  assert.equal(to, "second topic");
});

test("an unlinked card has neither label", () => {
  assert.deepEqual(chainLabels(unrelated, [parent, child, unrelated]), { from: "", to: "" });
});

test("a missing parent title is recovered from the sibling row", () => {
  const nameless = { ...child, parent_task_title: "" };
  assert.equal(chainLabels(nameless, [parent, nameless]).from, "first topic");
});

test("a child from another session never links", () => {
  const foreign = { ...child, session_key: "ses_2" };
  assert.equal(chainLabels(parent, [parent, foreign]).to, "");
});
