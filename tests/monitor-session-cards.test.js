import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSessionUpsert, buildParentHandoff, HANDOFF_PHASE } = require("../monitor-server/session-upsert.cjs");
const { buildSessionsQuery } = require("../monitor-server/sessions-query.cjs");
const { buildHistoryQuery } = require("../monitor-server/history-query.cjs");

/**
 * One card per task. Before this change the monitor had exactly one row per
 * agent session, so starting a second topic overwrote the first one and no
 * record of it survived on the board.
 */

const CARD = {
  sessionKey: "ses_uji",
  taskId: "task-b",
  machine: "HELLOWORLD",
  projectPath: "/code/dev-workflow-mcp-server",
  projectName: "dev-workflow-mcp-server",
  task: "second topic",
  taskType: "feature",
  phase: "coding",
  parentTask: { taskId: "task-a", title: "first topic", startedAt: "2026-11-08T00:00:00.000Z" },
};

test("a card conflicts on the composite session and task identity", () => {
  const { sql } = buildSessionUpsert(CARD);
  assert.match(sql, /ON CONFLICT \(session_key, task_id\) DO UPDATE/);
});

test("a card stores its task id and parent card", () => {
  const { sql, params } = buildSessionUpsert(CARD);
  assert.match(sql, /task_id/);
  assert.match(sql, /parent_task_id/);
  assert.match(sql, /parent_task_title/);
  assert.equal(params.at(-3), "task-b");
  assert.equal(params.at(-2), "task-a");
  assert.equal(params.at(-1), "first topic");
});

test("a card without a parent stores empty parent columns", () => {
  const { params } = buildSessionUpsert({ ...CARD, parentTask: null });
  assert.equal(params.at(-2), null);
  assert.equal(params.at(-1), null);
});

test("a card without a task id keeps working like the old single-card row", () => {
  const { params } = buildSessionUpsert({ ...CARD, taskId: undefined, parentTask: null });
  assert.equal(params.at(-3), "");
});

test("starting a child card hands the parent card off", () => {
  const handoff = buildParentHandoff(CARD);
  assert.ok(handoff, "a card with a parent must produce a hand-off statement");
  assert.equal(HANDOFF_PHASE, "handed-off");
  assert.match(handoff.sql, /UPDATE sessions/);
  assert.match(handoff.sql, /phase = 'handed-off'/);
  assert.match(handoff.sql, /WHERE session_key = \$1 AND task_id = \$2/);
  assert.deepEqual(handoff.params, ["ses_uji", "task-a"]);
});

test("a first card produces no hand-off statement", () => {
  assert.equal(buildParentHandoff({ ...CARD, parentTask: null }), null);
});

test("active cards expose chain identity and hide handed-off cards", () => {
  const { sql } = buildSessionsQuery({});
  assert.match(sql, /task_id/);
  assert.match(sql, /parent_task_id/);
  assert.match(sql, /parent_task_title/);
  assert.match(sql, /phase NOT IN \('closed', 'done', 'cancelled', 'handed-off'\)/);
});

test("history cards expose chain identity and their successor", () => {
  const { sql } = buildHistoryQuery({});
  assert.match(sql, /task_id/);
  assert.match(sql, /parent_task_id/);
  assert.match(sql, /parent_task_title/);
});

test("the migration adds columns before swapping the primary key", () => {
  const sql = readFileSync(new URL("../monitor-server/migrations/001-card-chaining.sql", import.meta.url), "utf8");
  const addTaskId = sql.indexOf("ADD COLUMN IF NOT EXISTS task_id");
  const addParentId = sql.indexOf("ADD COLUMN IF NOT EXISTS parent_task_id");
  const addParentTitle = sql.indexOf("ADD COLUMN IF NOT EXISTS parent_task_title");
  const dropPk = sql.indexOf("DROP CONSTRAINT");
  const addPk = sql.indexOf("ADD PRIMARY KEY (session_key, task_id)");

  assert.ok(addTaskId >= 0, "task_id column is required");
  assert.ok(addParentId >= 0, "parent_task_id column is required");
  assert.ok(addParentTitle >= 0, "parent_task_title column is required");
  assert.ok(dropPk > addTaskId, "the old primary key must be dropped after the columns exist");
  assert.ok(addPk > dropPk, "the composite primary key must be added after the drop");
  assert.match(sql, /IF EXISTS/, "the primary key drop must be safe on a migrated database");
  assert.match(sql, /current_schema\(\)/, "the primary key lookup must stay inside the current schema");
});
