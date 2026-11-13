/**
 * The monitor dashboard must show which release each session runs, and must not
 * carry a retired host in its defaults.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two problems met in the same file.
 *
 * 1. The live dashboard had drifted from the repository: it carried a test-case
 *    renderer that was never committed, while the repository carried a machine
 *    filter the live copy lacked. Deploying either one alone silently dropped
 *    the other's work.
 *
 * 2. Its default share origin still named a retired database host, one that no
 *    longer serves anything. A default that points at a dead host is worse than
 *    no default: it looks configured.
 *
 * The version pill is the visible half of the release-version work: the data
 * reached the database and the API, but nothing rendered it.
 *
 * Run: node --test tests/monitor-dashboard-version.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SUMBER = readFileSync(new URL("../monitor-server/dashboard.cjs", import.meta.url), "utf8");

test("the dashboard renders the release version on a card", () => {
  assert.match(SUMBER, /function versionPill\(/, "the page needs a version badge helper");
  assert.match(SUMBER, /versionPill\(s\)/, "the card must call it");
  assert.match(SUMBER, /release_version/, "it must read the field the API provides");
});

test("the version badge is drawn from the reported value, never invented", () => {
  // An empty value means the device does not use the managed bootstrap. Showing
  // a placeholder there would claim knowledge nobody has.
  assert.match(
    SUMBER,
    /if \(!version\) return '';/,
    "an absent version must render nothing rather than a placeholder"
  );
});

test("the version badge escapes its input", () => {
  const body = SUMBER.slice(SUMBER.indexOf("function versionPill("));
  const end = body.indexOf("\n}");
  const fn = body.slice(0, end);
  assert.match(fn, /esc\(version\)/, "the version must go through the escaper like every other value");
});

test("the default share origin does not name a retired host", () => {
  // Built from parts on purpose: another test scans the repository for this
  // address, and a literal here would trip it.
  const retired = ["100", "107", "65", "21"].join(".");
  assert.equal(SUMBER.includes(retired), false, "the retired database host must not appear in the dashboard");
  assert.match(
    SUMBER,
    /DEVWF_SHARE_ORIGINS \|\| 'http:\/\/127\.0\.0\.1:3100,http:\/\/localhost:3100'/,
    "the default must use local-first open-source origins and allow DEVWF_SHARE_ORIGINS override"
  );
});

test("the test-case renderer that existed only on the live host is preserved", () => {
  assert.match(SUMBER, /function renderTestCases\(/, "the live-only feature must survive the merge");
  assert.match(SUMBER, /renderTestCases\(ab\.testCases\)/, "and must still be called when a build is drawn");
});

test("the machine filter from the repository is preserved", () => {
  assert.match(SUMBER, /visibleMachines/, "the retired test-report machine filter must survive the merge");
  assert.match(SUMBER, /const machines = visibleMachines\(machineRows\.rows\)/, "and must be applied to the rows");
});

test("the junk-session guard from the live host is preserved", () => {
  assert.match(SUMBER, /shouldSkipCreate/, "a session with nothing in it must not be created");
});

test("the API payload still carries the machines the filter produced", () => {
  // A half-applied merge here would send machineRows.rows instead of the
  // filtered list, quietly resurrecting the retired machine.
  assert.match(SUMBER, /machines: machines,|machines,/, "the payload must use the filtered list");
  assert.doesNotMatch(SUMBER, /machines: machineRows\.rows/, "the unfiltered rows must not reach the payload");
});
