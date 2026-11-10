import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildHistoryQuery } = require("../monitor-server/history-query.cjs");
const { buildProjectSummaryQuery } = require("../monitor-server/project-summary.cjs");
const { buildSessionUpsert } = require("../monitor-server/session-upsert.cjs");
const { emptySessionPredicate } = require("../monitor-server/empty-session.cjs");

/**
 * Owner instruction, 10 November 2026: "still showing tanpa task and in the recap
 * tab still showing tanpa project — that is wrong; without a task it cannot be
 * reported as a report, and without a project we must make this MCP know that is
 * not allowed."
 *
 * The rule: a session is worth reporting ONLY when it has BOTH a non-empty task
 * AND a non-empty project_name. A session missing either task or project is not
 * a valid task report: it must not be created as a card, must not appear in
 * active, recap or history, and existing incomplete rows must be removable.
 */

test("the shared empty-session predicate matches rows missing task OR project_name", () => {
  const sql = emptySessionPredicate();
  assert.match(sql, /task/);
  assert.match(sql, /project_name/);
  assert.match(sql, /BTRIM/);
  assert.match(sql, /\bOR\b/i);
});

test("worthReportingPredicate requires BOTH non-empty task AND non-empty project_name", () => {
  const { worthReportingPredicate } = require("../monitor-server/empty-session.cjs");
  const sql = worthReportingPredicate().toLowerCase();
  assert.match(sql, /nullif\(btrim\(task\),\s*''\)\s+is not null/);
  assert.match(sql, /nullif\(btrim\(project_name\),\s*''\)\s+is not null/);
  assert.match(sql, /\band\b/);
  assert.ok(!sql.includes("or nullif(btrim(session_title)"), "session_title alone must never qualify a session without a task");
});

test("history excludes sessions missing task or project_name", () => {
  const { sql } = buildHistoryQuery({ historyDays: 7 });
  const lower = sql.toLowerCase();
  assert.match(lower, /nullif\(btrim\(task\),\s*''\)\s+is not null/);
  assert.match(lower, /nullif\(btrim\(project_name\),\s*''\)\s+is not null/);
});

test("recap excludes sessions missing task or project_name and never produces (tanpa proyek)", () => {
  const { sql } = buildProjectSummaryQuery({ days: 7 });
  const lower = sql.toLowerCase();
  assert.match(lower, /nullif\(btrim\(task\),\s*''\)\s+is not null/);
  assert.match(lower, /nullif\(btrim\(project_name\),\s*''\)\s+is not null/);
  assert.doesNotMatch(sql, /\(tanpa proyek\)/);
});

test("ingestion refuses to CREATE a report when task or project is missing", () => {
  const { shouldSkipCreate } = require("../monitor-server/empty-session.cjs");
  assert.equal(shouldSkipCreate({ task: "", sessionTitle: "", projectName: "", projectPath: "" }, false), true);
  assert.equal(shouldSkipCreate({ task: "", sessionTitle: "Watching the build", projectName: "clinic" }, false), true);
  assert.equal(shouldSkipCreate({ task: "Fix the recap", sessionTitle: "", projectName: "", projectPath: "" }, false), true);
  assert.equal(shouldSkipCreate({ task: "Fix the recap", sessionTitle: "", projectName: "dev-workflow-mcp-server" }, false), false);
});

test("a sparse report for an existing row is still accepted", () => {
  // Closing a task sends an empty task on purpose to keep identity and
  // relations. That must never be skipped when updating an existing row.
  const { shouldSkipCreate } = require("../monitor-server/empty-session.cjs");
  assert.equal(shouldSkipCreate({ task: "", sessionTitle: "" }, true), false);
});

test("the SQL builder preserves existing task text when closing sends empty task", () => {
  const { sql } = buildSessionUpsert({ sessionKey: "ses_close", task: "", sessionTitle: "" });
  assert.ok(sql.includes("INSERT INTO sessions"));
  assert.match(sql, /task=COALESCE\(NULLIF\(EXCLUDED\.task, ''\), sessions\.task\)/);
});

test("the cleanup deletes rows missing task or project_name and is bounded", () => {
  const { buildEmptySessionCleanup } = require("../monitor-server/empty-session.cjs");
  const { sql, params } = buildEmptySessionCleanup({ limit: 250, olderThanMinutes: 60 });
  const lower = sql.toLowerCase();
  assert.match(lower, /delete from sessions/);
  assert.match(lower, /btrim\(task\)/);
  assert.match(lower, /btrim\(project_name\)/);
  assert.equal(params[1], 250);
  assert.equal(params[0], "60");
});

test("the cleanup limit cannot be unbounded", () => {
  const { buildEmptySessionCleanup } = require("../monitor-server/empty-session.cjs");
  const huge = buildEmptySessionCleanup({ limit: 999999 });
  assert.ok(Number(huge.params[1]) <= 5000);
});

test("the README states that a session without task or project is not recorded", () => {
  const { readFileSync } = require("node:fs");
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /Junk sessions are not recorded/i);
  assert.match(readme, /cleanup-empty-sessions\.cjs/);
  assert.match(readme, /both\*\* a task \*\*and\*\* a project/i);
});
