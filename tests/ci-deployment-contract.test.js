import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

/**
 * CI must verify, never deploy.
 *
 * A push to main used to call `scripts/deploy-monitor.sh`, a private script that
 * was removed from this repository. The job stayed green only because no main
 * push had touched `monitor-server/` since the removal; the next one would have
 * failed. These tests pin the contract that replaced it.
 */

function workflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({
      name,
      text: readFileSync(path.join(WORKFLOW_DIR, name), "utf8"),
    }));
}

/** Drop comment-only lines so documentation may still name the removed script. */
function executableLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

test("no workflow executes the removed deploy script", () => {
  for (const workflow of workflows()) {
    const body = executableLines(workflow.text);
    assert.equal(
      body.includes("deploy-monitor.sh"),
      false,
      `${workflow.name} still references the removed deploy script`,
    );
  }
});

test("every script referenced by a workflow exists", () => {
  const missing = [];
  for (const workflow of workflows()) {
    const body = executableLines(workflow.text);
    for (const match of body.matchAll(/scripts\/[A-Za-z0-9._-]+/g)) {
      const relative = match[0];
      if (!existsSync(path.join(ROOT, relative))) missing.push(`${workflow.name}: ${relative}`);
    }
  }
  assert.deepEqual(missing, [], `workflows reference missing files: ${missing.join(", ")}`);
});

test("no workflow mutates production", () => {
  const forbidden = [
    /\bsystemctl\b/,
    /\bssh\s/,
    /\bscp\s/,
    /\bpsql\b/,
    /\bpg_dump\b/,
    /\bgit\s+push\b/,
    /\bansible-playbook\b/,
  ];
  for (const workflow of workflows()) {
    const body = executableLines(workflow.text);
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(body),
        false,
        `${workflow.name} contains a production mutation: ${pattern}`,
      );
    }
  }
});

test("CI still runs tests, lint and build", () => {
  const ci = readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8");
  assert.match(ci, /test-command:\s*npm run ci:test/);
  assert.match(ci, /lint-command:\s*npm run lint/);
  assert.match(ci, /build-command:\s*npm run ci:build/);
  assert.match(ci, /web-build-command:\s*npm run build/);
});

test("CI reports that deployment is a separate authorized action", () => {
  const ci = readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8");
  assert.match(ci, /deployment-notice:/);
  assert.match(ci, /docs\/operations\/monitor-deployment\.md/);
  assert.match(ci, /CI did not deploy it/);
  assert.match(ci, /not deployment approval/);
});

test("the deployment notice does not run on pull requests", () => {
  const ci = readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8");
  const notice = ci.slice(ci.indexOf("deployment-notice:"));
  assert.match(notice, /github\.event_name == 'push'/);
  assert.match(notice, /refs\/heads\/main/);
});

test("the deployment procedure exists and names the real entrypoint", () => {
  const doc = readFileSync(path.join(ROOT, "docs", "operations", "monitor-deployment.md"), "utf8");
  assert.match(doc, /monitor\.cjs/);
  assert.match(doc, /dashboard\.cjs/);
  assert.match(doc, /devwf-monitor\.service/);
  assert.match(doc, /005-reaper-owner\.sql/);
  assert.match(doc, /DEVWF_REAPER_SECRETS/);
  assert.match(doc, /Rollback/);
  assert.match(doc, /never runs from CI/);
});
