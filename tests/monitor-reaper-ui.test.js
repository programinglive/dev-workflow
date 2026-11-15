import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");

/**
 * The Monitor UI must be driven by the verified backend state, not by a renamed
 * "possibly stuck" label, and it must render exactly the controls the backend
 * authorizes. These tests read the shipped source so a regression cannot hide
 * behind a passing unit test of some other module.
 */

test("the card renders every authorized reaper control", () => {
  for (const label of [
    "Verify now",
    "Graceful stop",
    "Recover orphan",
    "View checkpoint",
    "View cleanup evidence",
  ]) {
    assert.ok(dash.includes(label), `the card must offer "${label}"`);
  }
});

test("the UI renders the backend action list instead of its own state checks", () => {
  assert.match(dash, /s\.reaper_actions/);
  assert.match(dash, /authorizedActions\(reaper\.state\)/);
  // The old behaviour: a label renamed in place, with the state decided in the
  // template. The new behaviour reads reaper_actions from the payload.
  assert.match(dash, /reaper_actions: reaper \? authorizedActions/);
});

test("the card shows the verified state and reason", () => {
  assert.match(dash, /reaper: <b>' \+ esc\(reaperState\)/);
  assert.match(dash, /s\.reaper_reason/);
});

test("the privileged fields never reach the browser", () => {
  for (const field of [
    "owner_pid",
    "owner_started_at",
    "owner_executable",
    "lease_owner",
    "lease_generation",
    "lease_fencing_token",
  ]) {
    assert.equal(dash.includes(field), false, `${field} must not appear in the browser bundle`);
  }
});

test("the reaper secret is read from the environment only", () => {
  const hits = dash.match(/DEVWF_REAPER_SECRET\b/g) || [];
  assert.equal(hits.length, 1, "the single-machine secret must be read once, server-side");
  assert.match(dash, /secret: process\.env\.DEVWF_REAPER_SECRET \|\| ''/);
  assert.match(dash, /secrets: parseReaperSecrets\(process\.env\.DEVWF_REAPER_SECRETS\)/);
  assert.equal(/DEVWF_REAPER_SECRET[^\n]*\+/.test(dash), false, "the secret must not be concatenated into HTML");
});

test("the reaper buttons post to the authorized action endpoint", () => {
  assert.match(dash, /fetch\('\/api\/reaper\/action'/);
  assert.match(dash, /function tombolReaper\(action, sessionKey, tombol\)/);
  assert.match(dash, /data-reaper="' \+ esc\(a\)/);
});

test("a click on a reaper control does not open the detail modal", () => {
  const listener = dash.slice(dash.indexOf("document.getElementById('list').addEventListener('click'"));
  const reaperAt = listener.indexOf("closest('[data-reaper]')");
  const cardAt = listener.indexOf("closest('[data-session-key]')", reaperAt);
  assert.ok(reaperAt > -1, "the list must handle reaper clicks");
  assert.ok(cardAt > reaperAt, "the reaper branch must return before the card modal opens");
});
