import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const scriptPath = path.join(root, "scripts", "deploy-monitor.ps1");

test("monitor deploy runs only after successful main branch CI", () => {
  assert.match(workflow, /deploy-monitor:/);
  assert.match(workflow, /needs:\s*ci/);
  assert.match(workflow, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /concurrency:/);
});

test("monitor deployment skips commits without monitor artifacts", () => {
  assert.match(workflow, /git diff --name-only HEAD\^ HEAD -- monitor-server\/ scripts\/deploy-monitor\.sh/);
  assert.match(workflow, /Monitor artifacts unchanged; skip deployment/);
});

test("monitor deploy uses a dedicated secret and pinned host key", () => {
  assert.match(workflow, /secrets\.MONITOR_DEPLOY_SSH_KEY/);
  const script = readFileSync(scriptPath, "utf8");
  assert.match(script, /devwf-monitor-deploy@100\.77\.138\.14/);
  assert.match(script, /StrictHostKeyChecking=yes/);
  assert.match(script, /UserKnownHostsFile=/);
  assert.match(script, /monitor-server\/bw-tools-known-hosts/);
  const knownHosts = readFileSync(path.join(root, "monitor-server", "bw-tools-known-hosts"), "utf8");
  assert.match(knownHosts, /^100\.77\.138\.14 ssh-ed25519 AAAA/);
});

test("monitor deploy verifies both artifacts and live health", () => {
  const script = readFileSync(scriptPath, "utf8");
  assert.match(script, /monitor-server\/dashboard\.cjs/);
  assert.match(script, /monitor-server\/machines-query\.cjs/);
  assert.match(script, /Get-FileHash/);
  assert.match(script, /sha256sum/);
  assert.match(script, /node --check/);
  assert.match(script, /devwf-monitor\.service/);
  assert.match(script, /\/health/);
  assert.match(script, /\/api\/sessions/);
  assert.match(script, /monitor\.previous\.cjs/);
});
