import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeBuildState, summarizeTestCases } = require("../monitor-server/build-monitor.cjs");

/**
 * Motivation (owner request, 10 November 2026): "I want output about test cases
 * on the dev-workflow monitor, so we know tests are running and how far they
 * have got." Until now a card could show `npm test (100%)` with no idea which
 * case was running, so a long suite looked frozen.
 */

/** A test case as an agent would report it. */
function testCase(overrides = {}) {
  return { name: "revert record refuses a pushed commit", status: "passed", durationMs: 12, ...overrides };
}

test("test cases are normalised and kept on the build state", () => {
  const state = normalizeBuildState({
    status: "testing",
    target: "unit suite",
    testCases: [testCase(), testCase({ name: "second case", status: "running", durationMs: 0 })],
  });
  assert.equal(state.testCases.length, 2);
  assert.equal(state.testCases[0].name, "revert record refuses a pushed commit");
  assert.equal(state.testCases[1].status, "running");
});

test("an unknown case status is recorded as unknown, never guessed", () => {
  const state = normalizeBuildState({
    status: "testing",
    target: "unit suite",
    testCases: [testCase({ status: "exploded" })],
  });
  assert.equal(state.testCases[0].status, "unknown");
});

test("a huge suite is bounded so the payload cannot flood the monitor", () => {
  const many = Array.from({ length: 500 }, (_, i) => testCase({ name: `case ${i}` }));
  const state = normalizeBuildState({ status: "testing", target: "big suite", testCases: many });
  assert.ok(state.testCases.length <= 100, `expected <= 100 cases, got ${state.testCases.length}`);
});

test("a long case name is truncated instead of breaking the card layout", () => {
  const state = normalizeBuildState({
    status: "testing",
    target: "unit suite",
    testCases: [testCase({ name: "x".repeat(500) })],
  });
  assert.ok(state.testCases[0].name.length <= 160);
});

test("counts are computed from the cases, including failures", () => {
  const state = normalizeBuildState({
    status: "testing",
    target: "unit suite",
    testCases: [
      testCase({ status: "passed" }),
      testCase({ status: "passed" }),
      testCase({ status: "failed" }),
      testCase({ status: "running" }),
    ],
  });
  const summary = summarizeTestCases(state.testCases);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.running, 1);
  assert.equal(summary.total, 4);
});

test("a previous case list survives a progress-only update", () => {
  const first = normalizeBuildState({
    status: "testing",
    target: "unit suite",
    testCases: [testCase({ status: "passed" })],
  });
  const second = normalizeBuildState({ status: "testing", target: "unit suite", stage: "more" }, first);
  assert.equal(second.testCases.length, 1);
  assert.equal(second.testCases[0].status, "passed");
});

test("an empty case list clears the previous one instead of resurrecting it", () => {
  const first = normalizeBuildState({
    status: "testing",
    target: "unit suite",
    testCases: [testCase()],
  });
  const second = normalizeBuildState({ status: "succeeded", target: "unit suite", testCases: [] }, first);
  assert.deepEqual(second.testCases, []);
});

test("the summary of no cases is zeroes, not null", () => {
  const summary = summarizeTestCases(normalizeBuildState({ status: "idle", target: "x" }).testCases);
  assert.deepEqual(
    { total: summary.total, passed: summary.passed, failed: summary.failed, running: summary.running },
    { total: 0, passed: 0, failed: 0, running: 0 }
  );
});

test("the progress percentage follows the cases when none is given", () => {
  const state = normalizeBuildState({
    status: "testing",
    target: "unit suite",
    testCases: [
      testCase({ status: "passed" }),
      testCase({ status: "passed" }),
      testCase({ status: "running" }),
      testCase({ status: "running" }),
    ],
  });
  assert.equal(state.progress, 50);
});
