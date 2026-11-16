import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Wiring test for the fleet parity view.
 *
 * fleet-parity.test.js proves the arithmetic. This file proves the dashboard
 * actually feeds it real machine rows, sends the result to the page, and that
 * the page shows it. A correct calculation nobody displays answers nothing.
 */

const DASHBOARD = readFileSync(new URL("../monitor-server/dashboard.cjs", import.meta.url), "utf8");
const MACHINES_QUERY = readFileSync(new URL("../monitor-server/machines-query.cjs", import.meta.url), "utf8");

test("the machines query carries the parity inputs from the newest row", () => {
  assert.match(MACHINES_QUERY, /release_version/);
  assert.match(MACHINES_QUERY, /release_revision/);
  assert.match(MACHINES_QUERY, /toolchain_json/);
  // Newest row wins, same as the phase and project already do.
  assert.match(MACHINES_QUERY, /\(array_agg\(NULLIF\(release_version, ''\) ORDER BY updated_at DESC\)\)\[1\]/);
});

test("the dashboard computes parity from the rows it displays", () => {
  assert.match(DASHBOARD, /require\('\.\/fleet-parity\.cjs'\)/);
  assert.match(DASHBOARD, /require\('\.\/approved-release\.cjs'\)/);
  assert.match(DASHBOARD, /const fleet = buildFleetParity\(machines, \{/);
  // The target must come from the approved release and the pinned manifest when
  // the monitor can read them; a bare majority is only the fallback.
  assert.match(DASHBOARD, /approvedRelease: loadApprovedRelease\(\)/);
  assert.match(DASHBOARD, /fleetManifest: loadFleetManifestSnapshot\(\)/);
});

test("the payload sent to the page carries the parity result", () => {
  assert.match(DASHBOARD, /events: events\.rows, health, machines, fleet,/);
});

test("the Mesin panel names the parity state and lists each tool", () => {
  assert.match(DASHBOARD, /Kesamaan Armada/);
  assert.match(DASHBOARD, /menyimpang/);
  assert.match(DASHBOARD, /belum melapor lengkap/);
  // Version parity and tool parity are shown separately; one must never stand
  // in for the other.
  assert.match(DASHBOARD, /versi sama/);
  assert.match(DASHBOARD, /alat belum dilapor/);
  assert.match(DASHBOARD, /function toolChip\(name, actual\)/);
});

test("the page keeps the template-literal rule: no unescaped backtick", () => {
  const lines = DASHBOARD.split("\n");
  const start = lines.findIndex((line) => line.trim() === "<script>");
  const end = lines.findIndex((line) => line.trim().startsWith("</script>"));
  assert.ok(start > 0 && end > start, "the page script must exist");

  const script = lines.slice(start + 1, end).join("\n");
  // The page is one template literal, so a bare backtick would end it early.
  // Interpolation is expected here (server helpers are injected), but the
  // parity block itself must not need it.
  const loneBackticks = script.split("\n").filter((line) => /(^|[^\\])`/.test(line));
  assert.deepEqual(loneBackticks, [], "a bare backtick would end the page template");

  const parityStart = script.indexOf("// Kesamaan armada.");
  const parityEnd = script.indexOf("belum ada mesin terhubung");
  assert.ok(parityStart > 0 && parityEnd > parityStart, "the parity block must exist");
  assert.equal(script.slice(parityStart, parityEnd).includes("${"), false,
    "the parity block must be plain concatenation, not interpolation");
});
