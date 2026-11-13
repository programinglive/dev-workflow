import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the README documents checkpoint_task and fetch_task", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.ok(readme.includes("checkpoint_task"));
  assert.ok(readme.includes("fetch_task"));
});

test("the README documents the handoff rules for the next agent", () => {
  const readme = readFileSync("README.md", "utf8");
  // A handoff requires a reason; the returning machine is refused; reverts are
  // recorded, never executed.
  assert.match(readme, /handoff_task/i);
  assert.match(readme, /acknowledge_handover/i);
  assert.match(readme, /reason/i);
  assert.match(readme, /never (run|execute|executed|automatic)/i);
});
