import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isWriteAuthorized } = require("../monitor-server/retention.cjs");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Token rotation must be possible WITHOUT disconnecting a machine that has not
 * been updated yet.
 *
 * Without a previous token that is still accepted for a while, every machine
 * that has not been switched over is rejected with 401 and its card disappears
 * silently - a failure that is only noticed days later.
 */

const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");

test("the server keeps a previous-token path during rotation", () => {
  assert.match(dash, /DEVWF_MONITOR_TOKEN_PREVIOUS/);
  assert.match(dash, /function writeAllowed\(req\)/);
  // The previous token only applies when it is set; empty means no tolerance.
  assert.match(dash, /if \(!WRITE_TOKEN_PREVIOUS\) return false;/);
});

test("all write endpoints use the same check", () => {
  const calls = (dash.match(/if \(!writeAllowed\(req\)\)/g) || []).length;
  // POST /api/session, POST /api/event, POST /api/reaper/action and
  // POST /api/fleet/restart. The reaper action can archive a card and the
  // restart endpoint can stop a process, so both must use the same write token
  // as the report endpoints instead of a separate weaker check.
  assert.equal(calls, 4, "every write endpoint must be guarded by writeAllowed");
  const restart = dash.slice(dash.indexOf("'/api/fleet/restart'"));
  assert.match(restart.slice(0, 1500), /if \(!writeAllowed\(req\)\)/, "the restart endpoint must be guarded");
});

test("the monitor env template documents the token without a real value", () => {
  const envExample = readFileSync(path.join(ROOT, "monitor-server", "devwf-monitor.env.example"), "utf8");
  assert.match(envExample, /DEVWF_MONITOR_TOKEN=REPLACE_WITH_LONG_RANDOM_TOKEN/);
  assert.match(envExample, /127\.0\.0\.1:5432/);
});

test("token rules stay the same: empty is rejected, wrong is rejected", () => {
  // The base behaviour must not change because a previous token was added.
  assert.equal(isWriteAuthorized({ header: "Bearer x", expectedToken: "" }), false);
  assert.equal(isWriteAuthorized({ header: "Bearer wrong", expectedToken: "right" }), false);
  assert.equal(isWriteAuthorized({ header: "Bearer right", expectedToken: "right" }), true);
});
