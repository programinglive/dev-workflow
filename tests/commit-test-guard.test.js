import test from "node:test";
import assert from "node:assert/strict";
import { hasTestEvidenceForCommit } from "../tools/handler-modules/commit-handlers.js";

test("hasTestEvidenceForCommit passes when testsSkipped is true", async () => {
  const ok = await hasTestEvidenceForCommit({
    testsSkipped: true,
    statusOutput: " M src/app.js",
  });
  assert.equal(ok, true);
});

test("hasTestEvidenceForCommit passes when statusOutput contains a test file", async () => {
  const ok = await hasTestEvidenceForCommit({
    testsSkipped: false,
    statusOutput: " M tests/sample.test.js\n M src/app.js",
  });
  assert.equal(ok, true);
});

test("hasTestEvidenceForCommit passes when test file was already committed on HEAD", async () => {
  const ok = await hasTestEvidenceForCommit({
    testsSkipped: false,
    statusOutput: "?? pb_data/",
    execFn: async () => ({ stdout: "tools/pipeline-guard.js\ntests/pipeline-guard.test.js\n" }),
  });
  assert.equal(ok, true);
});

test("hasTestEvidenceForCommit fails when neither statusOutput nor recent commits contain tests", async () => {
  const ok = await hasTestEvidenceForCommit({
    testsSkipped: false,
    statusOutput: " M src/app.js",
    execFn: async () => ({ stdout: "src/app.js\nREADME.md\n" }),
  });
  assert.equal(ok, false);
});
