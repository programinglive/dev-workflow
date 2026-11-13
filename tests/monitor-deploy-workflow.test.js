import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

test("monitor deploy runs only after successful main branch CI", () => {
  assert.match(workflow, /deploy-monitor:/);
  assert.match(workflow, /needs:\s*ci/);
  assert.match(workflow, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /concurrency:/);
});

test("monitor deployment skips commits without monitor artifacts", () => {
  assert.match(workflow, /git diff --name-only HEAD\^ HEAD -- monitor-server\//);
  assert.match(workflow, /Monitor artifacts unchanged; skip deployment/);
});

test("monitor deploy uses a dedicated SSH secret rather than inline credentials", () => {
  assert.match(workflow, /secrets\.MONITOR_DEPLOY_SSH_KEY/);
});

test("public monitor server exposes health and session endpoints", () => {
  const dashboard = readFileSync(path.join(root, "monitor-server", "dashboard.cjs"), "utf8");
  const machines = readFileSync(path.join(root, "monitor-server", "machines-query.cjs"), "utf8");
  assert.match(dashboard, /\/health/);
  assert.match(dashboard, /\/api\/sessions/);
  assert.ok(machines.length > 0);
});
