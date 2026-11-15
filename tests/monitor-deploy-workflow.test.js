import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

/**
 * CI verifies; it does not deploy.
 *
 * The previous contract ran `scripts/deploy-monitor.sh` on a push to main. That
 * script was removed from the repository during the open-source sanitization, so
 * the job would have failed on the first main push that touched `monitor-server/`.
 * The contract is now: CI proves the commit, and production deployment is a
 * separate authorized action.
 */

test("CI has no production deployment job", () => {
  assert.equal(/deploy-monitor:/.test(workflow), false, "the deploy job must be gone");
  assert.equal(/MONITOR_DEPLOY_SSH_KEY/.test(workflow), false, "no deployment credential in CI");
  assert.equal(/deploy-monitor\.sh/.test(workflow.replace(/^#.*$/gm, "")), false);
});

test("CI reports that deployment is a separate authorized action", () => {
  assert.match(workflow, /deployment-notice:/);
  assert.match(workflow, /docs\/operations\/monitor-deployment\.md/);
  assert.match(workflow, /CI did not deploy it/);
});

test("the notice runs only on a push to main, after CI", () => {
  const notice = workflow.slice(workflow.indexOf("deployment-notice:"));
  assert.match(notice, /needs:\s*ci/);
  assert.match(notice, /github\.event_name == 'push'/);
  assert.match(notice, /refs\/heads\/main/);
});

test("the notice performs no mutation", () => {
  const notice = workflow.slice(workflow.indexOf("deployment-notice:"));
  for (const pattern of [/\bsystemctl\b/, /\bssh\s/, /\bscp\s/, /\bpsql\b/, /\bgit\s+push\b/]) {
    assert.equal(pattern.test(notice), false, `the notice must not run ${pattern}`);
  }
});

test("public monitor server exposes health and session endpoints", () => {
  const dashboard = readFileSync(path.join(root, "monitor-server", "dashboard.cjs"), "utf8");
  const machines = readFileSync(path.join(root, "monitor-server", "machines-query.cjs"), "utf8");
  assert.match(dashboard, /\/health/);
  assert.match(dashboard, /\/api\/sessions/);
  assert.ok(machines.length > 0);
});
