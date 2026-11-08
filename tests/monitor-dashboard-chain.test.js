import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifySession } = require("../monitor-server/status.cjs");
const { visibleTaskSessions } = require("../monitor-server/visible-task-sessions.cjs");

/**
 * Wiring test for the dashboard. The monitor dashboard is one large file with
 * an embedded page, so the readable proof is that the ingest path uses the
 * chaining helpers and the page renders both label directions.
 */

const SUMBER = readFileSync(new URL("../monitor-server/dashboard.cjs", import.meta.url), "utf8");

test("the dashboard applies the parent hand-off on ingest", () => {
  assert.match(SUMBER, /require\('\.\/session-upsert\.cjs'\)/);
  assert.match(SUMBER, /buildParentHandoff/);
  assert.match(SUMBER, /await query\(handoff\.sql, handoff\.params\)/);
});

test("live build boxes are keyed per card, not per session", () => {
  assert.match(SUMBER, /require\('\.\/card-chain\.cjs'\)/);
  assert.match(SUMBER, /cardKey\(/);
  assert.match(SUMBER, /buildForCard\(/);
});

test("cards render both directions of the chain", () => {
  assert.match(SUMBER, /chain_from/);
  assert.match(SUMBER, /chain_to/);
  assert.match(SUMBER, /lanjutan dari/);
  assert.match(SUMBER, /dilanjutkan ke/);
});

test("a handed-off card is no longer an active task", () => {
  assert.deepEqual(
    classifySession({ phase: "handed-off", updatedAt: new Date().toISOString() }).status,
    "ended",
  );
});

test("the visible-task filter hides handed-off cards", () => {
  const visible = visibleTaskSessions([
    { session_key: "s", phase: "coding", task: "live one", state: "live" },
    { session_key: "s", phase: "handed-off", task: "old one", state: "ended" },
  ]);
  assert.deepEqual(visible.map((s) => s.task), ["live one"]);
});
