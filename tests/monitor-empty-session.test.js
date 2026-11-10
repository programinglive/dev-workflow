import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildHistoryQuery } = require("../monitor-server/history-query.cjs");
const { buildProjectSummaryQuery } = require("../monitor-server/project-summary.cjs");
const { buildSessionUpsert } = require("../monitor-server/session-upsert.cjs");
const { emptySessionPredicate } = require("../monitor-server/empty-session.cjs");

/**
 * Owner instruction, 10 November 2026: "A session without a title does not need
 * to be recorded because it cannot be used in a report; treat it as junk, clean
 * it, and make sure it does not happen again."
 *
 * The rule: a session with NO task AND NO title carries no information. It must
 * not be stored, must not appear in recap or history, and existing rows must be
 * removable. A session with EITHER a task or a title is real work and stays.
 */

test("the shared predicate requires both task and title to be empty", () => {
  const sql = emptySessionPredicate();
  assert.match(sql, /task/);
  assert.match(sql, /session_title/);
  assert.match(sql, /BTRIM/);
});

test("history excludes sessions that have neither task nor title", () => {
  const { sql } = buildHistoryQuery({ historyDays: 7 });
  const lower = sql.toLowerCase();
  assert.ok(
    lower.includes("btrim(task)") || lower.includes("nullif(btrim(task)"),
    "history must test the task column for emptiness"
  );
  assert.ok(
    lower.includes("session_title"),
    "history must test the session title for emptiness"
  );
  assert.ok(lower.includes("is not null"), "history must require at least one of them");
});

test("recap excludes sessions that have neither task nor title", () => {
  const { sql } = buildProjectSummaryQuery({ days: 7 });
  const lower = sql.toLowerCase();
  assert.ok(lower.includes("session_title"), "recap must test the session title");
  assert.ok(lower.includes("is not null"), "recap must require at least one of them");
});

test("recap still counts a session that has only a title", () => {
  const { sql } = buildProjectSummaryQuery({ days: 7 });
  // The filter must be an OR of both fields, never an AND.
  const filter = sql.toLowerCase();
  const orBetween = /\(\s*nullif\(btrim\(task\)[^)]*\)\s+is not null\s+or\s+nullif\(btrim\(session_title\)[^)]*\)\s+is not null\s*\)/.test(filter)
    || (filter.includes(" or ") && filter.includes("session_title"));
  assert.ok(orBetween, "the filter must keep a row that has only one of the two fields");
});

test("ingestion refuses to CREATE a report with no task, no title and no project", () => {
  const { shouldSkipCreate } = require("../monitor-server/empty-session.cjs");
  assert.equal(shouldSkipCreate({ task: "", sessionTitle: "", projectName: "", projectPath: "" }, false), true);
});

test("a sparse report for an existing row is still accepted", () => {
  // Closing a task sends an empty task on purpose to keep identity and
  // relations. That must never be skipped.
  const { shouldSkipCreate } = require("../monitor-server/empty-session.cjs");
  assert.equal(shouldSkipCreate({ task: "", sessionTitle: "" }, true), false);
});

test("the SQL builder still accepts a sparse report so a task can be closed", () => {
  const { sql } = buildSessionUpsert({ sessionKey: "ses_close", task: "", sessionTitle: "" });
  assert.ok(sql.includes("INSERT INTO sessions"));
});

test("a first report with a project but no task is still recorded", () => {
  const { shouldSkipCreate } = require("../monitor-server/empty-session.cjs");
  assert.equal(shouldSkipCreate({ task: "", sessionTitle: "", projectName: "dev-workflow-mcp-server" }, false), false);
});

test("a first report with only a title is recorded", () => {
  const { shouldSkipCreate } = require("../monitor-server/empty-session.cjs");
  assert.equal(shouldSkipCreate({ task: "", sessionTitle: "Watching the build" }, false), false);
});

test("a first report with only a task is recorded", () => {
  const { shouldSkipCreate } = require("../monitor-server/empty-session.cjs");
  assert.equal(shouldSkipCreate({ task: "Fix the recap", sessionTitle: "" }, false), false);
});

test("the cleanup deletes only junk rows and is bounded", () => {
  const { buildEmptySessionCleanup } = require("../monitor-server/empty-session.cjs");
  const { sql, params } = buildEmptySessionCleanup({ limit: 250, olderThanMinutes: 60 });
  const lower = sql.toLowerCase();
  assert.match(lower, /delete from sessions/);
  // The junk predicate must be present, so a real card is never matched.
  assert.match(lower, /btrim\(session_title\)/);
  // A card keeps its task_id even when the task text was cleared on close.
  assert.match(lower, /coalesce\(task_id, ''\) = ''/);
  assert.equal(params[1], 250);
  assert.equal(params[0], "60");
});

test("the cleanup limit cannot be unbounded", () => {
  const { buildEmptySessionCleanup } = require("../monitor-server/empty-session.cjs");
  const huge = buildEmptySessionCleanup({ limit: 999999 });
  assert.ok(Number(huge.params[1]) <= 5000);
});

test("the cleanup refuses to touch a row that carries a task id", () => {
  const { buildEmptySessionCleanup } = require("../monitor-server/empty-session.cjs");
  const { sql } = buildEmptySessionCleanup();
  // A closed task keeps task_id and its relations; deleting it would erase a
  // real card from recap and history.
  assert.match(sql.toLowerCase(), /coalesce\(task_id, ''\) = ''/);
});

test("the README states that a session with no task and no title is junk", () => {
  const { readFileSync } = require("node:fs");
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /Junk sessions are not recorded/i);
  assert.match(readme, /cleanup-empty-sessions\.cjs/);
  assert.match(readme, /either\*\* a task \*\*or\*\* a title/i);
});
test("a project path alone is not enough to make a card", () => {
  // The defect behind "(tanpa task)": a client reported a projectPath with no
  // task and no title, the row was created, and the card had nothing to show.
  const { shouldSkipCreate } = require("../monitor-server/empty-session.cjs");
  assert.equal(
    shouldSkipCreate({ projectPath: "D:\\code\\zettly", task: "", sessionTitle: "" }, false),
    true,
    "a path is not a report title"
  );
});