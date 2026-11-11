import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");

/**
 * OWNER REPORT (11 November 2026): "kenapa buildnya tidak tampil di card".
 *
 * The tablet card showed no build at all while the web dashboard card drew the
 * same `active_build` payload. The data was never the problem: /api/sessions
 * carries `active_build`, the Build tab counted the builds, and the detail
 * modal rendered one. Only `Kartu` had no build markup, so a reported build
 * could not appear on the card no matter what the server sent.
 *
 * These tests pin the card itself, not the modal and not the Build tab.
 */

/** The card component only: everything between `function Kartu` and the modal. */
function kartuSource() {
  const start = app.indexOf("function Kartu(");
  const end = app.indexOf("function DetailSesi(");
  assert.ok(start !== -1, "Kartu component must exist");
  assert.ok(end > start, "DetailSesi must follow Kartu");
  return app.slice(start, end);
}

test("the card renders the reported build, guarded by active_build.target", () => {
  const kartu = kartuSource();
  assert.match(kartu, /s\.active_build\?\.target/, "card must guard on active_build.target");
  assert.match(kartu, /buildStatusLabel\(s\.active_build\.status\)/, "card must show the build status");
});

test("the card shows where the build runs and what stage it is in", () => {
  const kartu = kartuSource();
  assert.match(kartu, /buildLocation\(s\.active_build, s\.machine\)/, "card must show the build host");
  assert.match(kartu, /s\.active_build\.stage/, "card must show the current stage");
  assert.match(kartu, /s\.active_build\??\.progress/, "card must show the progress percentage");
});

test("the build age on the card uses the server clock", () => {
  const kartu = kartuSource();
  const buildAge = kartu.match(/ago\(s\.active_build[^)]*\)/g) || [];
  assert.ok(buildAge.length > 0, "card must show how old the build report is");
  for (const call of buildAge) {
    assert.ok(call.includes("jamServer"), `${call} must use the server clock`);
  }
});

test("the build section sits above the flow diagram so it is visible without scrolling", () => {
  const kartu = kartuSource();
  const buildAt = kartu.indexOf("s.active_build?.target");
  const flowAt = kartu.indexOf("relasiFlow(s)");
  assert.ok(buildAt !== -1 && flowAt !== -1, "both sections must exist");
  assert.ok(buildAt < flowAt, "build status must come before the flow diagram");
});
