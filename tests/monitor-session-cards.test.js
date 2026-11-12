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
  assert.equal(params.at(-4), "task-b");
  assert.equal(params.at(-3), "task-a");
  assert.equal(params.at(-2), "first topic");
  assert.equal(params.at(-1), null, "no refinement in this payload");
});

test("a card without a parent stores empty parent columns", () => {
  const { params } = buildSessionUpsert({ ...CARD, parentTask: null });
  assert.equal(params.at(-2), null);
  assert.equal(params.at(-1), null);
});

test("a card without a task id keeps working like the old single-card row", () => {
  const { params } = buildSessionUpsert({ ...CARD, taskId: undefined, parentTask: null });
  assert.equal(params.at(-4), "");
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

test("the upsert unifies the task-metadata and the card-chain models", () => {
  // The deployed monitor on bw-server-clean kept one row per session with a
  // task-metadata model (workflow_task_id, task_origin_json, task_relations_json,
  // repo_path, repo_remote). The reconciled upsert carries BOTH models: the
  // metadata describes the task a card tracks, and the chain columns describe
  // the card's place inside its session.
  const { sql, params } = buildSessionUpsert({
    ...CARD,
    workflowTaskId: "task-x",
    taskOrigin: { system: "factory", id: "45489f0d" },
    taskRelations: [{ system: "factory", id: "45489f0d", relation: "tracks", label: "Factory 45489f0d" }],
    repositoryPath: "/code/x",
    repositoryRemote: "git@github.com:x.git",
  });
  for (const expected of [
    "workflow_task_id",
    "task_origin_json",
    "task_relations_json",
    "repo_path",
    "repo_remote",
  ]) {
    assert.ok(sql.includes(expected), `${expected} must enter the upsert`);
  }
  // The f2ac45d "new task" semantics stay: a changed identity or title must
  // not inherit the old task's service links.
  assert.match(sql, /workflow_task_id=CASE WHEN \(/);
  assert.match(sql, /task_relations_json=CASE/);
  assert.match(sql, /repo_path=COALESCE\(NULLIF\(EXCLUDED\.repo_path, ''\), sessions\.repo_path\)/);
  // 17 base + 5 metadata + 2 release + 1 toolchain + 3 chain + 1 refinement = 29.
  assert.equal(params.length, 29, "the unified upsert takes 29 params");
  assert.equal(params.at(17), "task-x");
  assert.equal(params.at(18), JSON.stringify({ system: "factory", id: "45489f0d", url: "", label: "" }));
  assert.equal(params.at(20), "/code/x");
  assert.equal(params.at(21), "git@github.com:x.git");
  assert.equal(params.at(-4), "task-b");
  assert.equal(params.at(-1), null, "no refinement in this payload");
});

test("the upsert fills metadata defaults when no metadata is sent", () => {
  const { params } = buildSessionUpsert(CARD);
  assert.equal(params.at(17), "", "workflow_task_id defaults to empty");
  assert.equal(params.at(18), "{}", "task_origin_json defaults to an empty record");
  assert.equal(params.at(19), "[]", "task_relations_json defaults to an empty list");
  assert.equal(params.at(20), "", "repo_path defaults to empty");
  assert.equal(params.at(21), "", "repo_remote defaults to empty");
});

test("the upsert rejects task metadata that does not match the model", () => {
  const { params } = buildSessionUpsert({
    ...CARD,
    taskOrigin: { system: "nonsense" },
    taskRelations: [{ system: "nonsense", id: "x" }],
  });
  assert.equal(params.at(18), "{}", "an unknown origin system is dropped");
  assert.equal(params.at(19), "[]", "relations from an unknown system are dropped");
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

test("002-pk-swap performs the key swap as a standalone idempotent step", () => {
  const sql = readFileSync(new URL("../monitor-server/migrations/002-pk-swap.sql", import.meta.url), "utf8");
  const addTaskId = sql.indexOf("ADD COLUMN IF NOT EXISTS task_id");
  const dropPk = sql.indexOf("DROP CONSTRAINT");
  const addPk = sql.indexOf("ADD PRIMARY KEY (session_key, task_id)");
  assert.ok(addTaskId >= 0, "the chain columns are guaranteed even when 001 was skipped");
  assert.ok(dropPk > addTaskId, "the swap only happens after the columns exist");
  assert.ok(addPk > dropPk, "the composite key is added after the drop");
  assert.match(sql, /IS DISTINCT FROM 'PRIMARY KEY \(session_key, task_id\)'/,
    "an already-swapped database must stay untouched (second run is a no-op)");
  assert.match(sql, /current_schema\(\)/, "the key lookup must stay inside the current schema");
  assert.match(sql, /sessions_parent_task_idx/, "the parent lookup index is part of the swap");
});

test("003-task-metadata brings the f2ac45d columns into fresh installs", () => {
  const sql = readFileSync(new URL("../monitor-server/migrations/003-task-metadata.sql", import.meta.url), "utf8");
  for (const column of [
    "workflow_task_id",
    "task_origin_json",
    "task_relations_json",
    "repo_path",
    "repo_remote",
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`), `${column} is required`);
  }
  assert.ok(!/^\s*(BEGIN|COMMIT);/m.test(sql),
    "no transaction statements: the runner applies files inside one transaction of its own");
});
