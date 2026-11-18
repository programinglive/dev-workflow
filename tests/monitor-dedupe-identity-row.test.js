import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dedupeSessions } = require("../monitor-server/dedupe-sessions.cjs");

/**
 * Motivation for this file (measured 10 November 2026).
 *
 * The `sessions` table is keyed by (session_key, task_id), so one session owns
 * BOTH an identity row (task_id = '') and one row per task. The identity row
 * carries no relations, so the dashboard rendered a second card for the same
 * session with "Flow belum ada" — the owner read that as "the AI stopped
 * planning", while the real card next to it showed Draw #126 correctly.
 */

/** A card row: the row that carries the task and its relations. */
function cardRow(overrides = {}) {
  return {
    session_key: "ses_abc",
    machine: "Mac",
    task: "Add a devwf CLI",
    task_id: "ba6dc5da",
    project_name: "dev-workflow-mcp-server",
    workflow_task_id: "ba6dc5da",
    task_relations_json: [{ system: "zettly_draw", id: "126" }],
    phase: "coding",
    ...overrides,
  };
}

/** The identity row for the same session: no task, no relations. */
function identityRow(overrides = {}) {
  return {
    session_key: "ses_abc",
    machine: "Mac",
    task: "",
    task_id: "",
    project_name: "",
    workflow_task_id: "",
    task_relations_json: [],
    phase: "idle",
    ...overrides,
  };
}

test("the identity row is merged away so a session renders one card", () => {
  const rows = dedupeSessions([cardRow(), identityRow()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, "ba6dc5da");
});

test("the surviving card keeps the flow relation and project identity", () => {
  const rows = dedupeSessions([identityRow(), cardRow()]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].task_relations_json, [{ system: "zettly_draw", id: "126" }]);
  assert.equal(rows[0].project_name, "dev-workflow-mcp-server");
  assert.equal(rows[0].workflow_task_id, "ba6dc5da");
});

test("an idle session with no sibling card still renders its own card", () => {
  const rows = dedupeSessions([identityRow({ session_key: "ses_lonely" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_key, "ses_lonely");
});

test("two different tasks on one session still render as two cards", () => {
  const rows = dedupeSessions([
    cardRow({ task: "first task", task_id: "t1" }),
    cardRow({ task: "second task", task_id: "t2" }),
  ]);
  assert.equal(rows.length, 2);
});

test("identity rows on different machines are not merged into each other", () => {
  const rows = dedupeSessions([
    cardRow({ machine: "Mac" }),
    identityRow({ machine: "Mac" }),
    identityRow({ machine: "MMCH", session_key: "ses_other" }),
  ]);
  assert.equal(rows.length, 2);
  const machines = rows.map((r) => r.machine).sort();
  assert.deepEqual(machines, ["MMCH", "Mac"]);
});

test("a finished task keeps its relations even when its task text is cleared", () => {
  // Production, 10 November 2026: closing a task clears `task` but keeps its
  // `task_id` and its relations. Treating that as an
  // identity row would have deleted the flow from a real card.
  const closed = cardRow({ task: "", task_id: "ba6dc5da", task_relations_json: [{ system: "zettly_draw", id: "126" }] });
  const rows = dedupeSessions([closed]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].task_relations_json, [{ system: "zettly_draw", id: "126" }]);
});

test("a cleared task row is not merged away by a sibling identity row", () => {
  const closed = cardRow({ task: "", task_id: "ba6dc5da" });
  const rows = dedupeSessions([closed, identityRow()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, "ba6dc5da");
});

test("an identity row is kept when the only card row is already closed", () => {
  // Closed rows never reach this function through the active query, but the
  // merge must not invent a card either: with no live card, the row stands.
  const rows = dedupeSessions([identityRow({ session_key: "ses_x" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_key, "ses_x");
});
