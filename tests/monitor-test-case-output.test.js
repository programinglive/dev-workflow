import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeBuildState, summarizeTestCases, formatBuildStatusBlock } = require(
  "../monitor-server/build-monitor.cjs"
);

/**
 * Owner request, 10 November 2026: show test case output on the monitor card so
 * it is visible that tests are running and how far they have got, instead of a
 * bare percentage that looks frozen.
 */

const CASES = [
  { name: "revert record refuses a pushed commit", status: "passed", durationMs: 12 },
  { name: "handoff blocks the source machine", status: "passed", durationMs: 30 },
  { name: "checkpoint reads back", status: "failed", durationMs: 8 },
  { name: "monitor renders the running case", status: "running", durationMs: 0 },
];

test("a testing report keeps the cases on the build state", () => {
  const state = normalizeBuildState({ status: "testing", target: "unit suite", testCases: CASES });
  assert.equal(state.testCases.length, 4);
});

test("the summary separates passed, failed and running", () => {
  const state = normalizeBuildState({ status: "testing", target: "unit suite", testCases: CASES });
  const summary = summarizeTestCases(state.testCases);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.running, 1);
  assert.equal(summary.total, 4);
});

test("the agent-facing block names the running case", () => {
  const state = normalizeBuildState({ status: "testing", target: "unit suite", testCases: CASES });
  const block = formatBuildStatusBlock(state, []);
  assert.match(block, /Test Cases/);
  assert.match(block, /2 passed/);
  assert.match(block, /1 failed/);
  assert.match(block, /Running now/);
  assert.match(block, /monitor renders the running case/);
});

test("the card renders the test case block inside the page template", () => {
  // The renderer lives inside the page template, so it is browser code. This
  // asserts the wiring exists and that the browser-safe constraints hold.
  const source = readFileSync("monitor-server/dashboard.cjs", "utf8");
  assert.match(source, /function renderTestCases\(/);
  assert.match(source, /renderTestCases\(ab\.testCases\)/);
  assert.match(source, /Test cases: /);
});

test("the page renderer contains no template interpolation", () => {
  const source = readFileSync("monitor-server/dashboard.cjs", "utf8");
  const start = source.indexOf("function renderTestCases(");
  assert.ok(start > 0, "renderTestCases must exist");
  // The function body ends at the first closing brace in column zero.
  const rest = source.slice(start);
  const end = rest.search(/\n\}\n/);
  assert.ok(end > 0, "renderTestCases must have a body");
  const body = rest.slice(0, end);
  // Browser code inside the page template: a backtick or ${ would end the
  // template and break the whole dashboard, not just this widget.
  assert.doesNotMatch(body, /`/);
  assert.doesNotMatch(body, /\$\{/);
});

test("an explicit empty case list clears the block instead of keeping stale rows", () => {
  const first = normalizeBuildState({ status: "testing", target: "unit suite", testCases: CASES });
  const done = normalizeBuildState({ status: "succeeded", target: "unit suite", testCases: [] }, first);
  assert.deepEqual(done.testCases, []);
  assert.doesNotMatch(formatBuildStatusBlock(done, []), /Test Cases/);
});
