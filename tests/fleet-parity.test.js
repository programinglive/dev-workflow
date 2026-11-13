import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFleetParity, majority } from "../monitor-server/fleet-parity.cjs";

/**
 * Owner request, 10 November 2026: one screen must answer "is every device the
 * same?" — same MCP release, same required tools (gh, glab, wrangler, gcloud,
 * node, npm). These tests pin the three states that question needs: in sync,
 * drift, and not reported yet.
 */

const MACHINES = ["Mac", "HELLOWORLD", "MMCH"];

function machine(name, { version = "1.28.0", revision = "ef1c952f7150", tools = null, stale = false } = {}) {
  return {
    machine: name,
    release_version: version,
    release_revision: revision,
    toolchain_json: tools === null ? { gh: "2.40.1", glab: "1.36.0", wrangler: "3.78.12", gcloud: "458.0.0" } : tools,
    stale,
  };
}

test("majority returns the value most machines actually run", () => {
  assert.equal(majority(["1.28.0", "1.28.0", "1.27.1"]), "1.28.0");
});

test("an even split has no majority, so nothing is treated as the reference", () => {
  assert.equal(majority(["1.28.0", "1.27.1"]), null);
});

test("empty and missing values never count towards a majority", () => {
  assert.equal(majority(["", null, undefined, "1.28.0"]), "1.28.0");
  assert.equal(majority([]), null);
});

test("three identical machines are all in sync", () => {
  const parity = buildFleetParity(MACHINES.map((name) => machine(name)));
  assert.equal(parity.version, "1.28.0");
  assert.deepEqual(parity.mismatched, []);
  assert.deepEqual(parity.unreported, []);
  for (const row of parity.machines) assert.equal(row.status, "in-sync", row.machine);
});

test("the one machine on a different release is flagged, not the two that agree", () => {
  const parity = buildFleetParity([
    machine("Mac"),
    machine("HELLOWORLD"),
    machine("MMCH", { version: "1.27.1" }),
  ]);
  assert.deepEqual(parity.mismatched, ["MMCH"]);
  const mmch = parity.machines.find((m) => m.machine === "MMCH");
  assert.equal(mmch.versionMismatch, true);
  assert.equal(mmch.status, "drift");
});

test("a different revision is drift even when the version string matches", () => {
  const parity = buildFleetParity([
    machine("Mac"),
    machine("HELLOWORLD"),
    machine("MMCH", { revision: "ce7a8b00e76b" }),
  ]);
  assert.deepEqual(parity.mismatched, ["MMCH"]);
  assert.equal(parity.machines.find((m) => m.machine === "MMCH").revisionMismatch, true);
});

test("a required tool that is installed but differs is drift", () => {
  const parity = buildFleetParity([
    machine("Mac"),
    machine("HELLOWORLD"),
    machine("MMCH", {
      tools: { gh: "2.40.1", glab: "1.36.0", wrangler: "4.1.0", gcloud: "458.0.0" },
    }),
  ]);
  const mmch = parity.machines.find((m) => m.machine === "MMCH");
  assert.deepEqual(mmch.driftedTools, ["wrangler"]);
  assert.equal(mmch.status, "drift");
});

test("a required tool reported as null is listed as missing, never as a version", () => {
  const parity = buildFleetParity([
    machine("Mac"),
    machine("HELLOWORLD"),
    machine("MMCH", { tools: { gh: "2.40.1", glab: null, wrangler: "3.78.12", gcloud: "458.0.0" } }),
  ]);
  const mmch = parity.machines.find((m) => m.machine === "MMCH");
  assert.deepEqual(mmch.missingTools, ["glab"]);
  assert.equal(mmch.toolchain.glab, null);
  assert.equal(mmch.status, "drift");
});

test("a machine that has not run this release yet is unreported, not drift", () => {
  const parity = buildFleetParity([
    machine("Mac"),
    machine("HELLOWORLD"),
    machine("MMCH", { version: "", revision: "", tools: {} }),
  ]);
  assert.deepEqual(parity.mismatched, []);
  assert.deepEqual(parity.unreported, ["MMCH"]);
  const mmch = parity.machines.find((m) => m.machine === "MMCH");
  assert.equal(mmch.status, "unreported");
  assert.equal(mmch.version, null);
});

test("the tool list is the union across machines, sorted, so a tool missing everywhere still shows", () => {
  const parity = buildFleetParity([
    machine("Mac", { tools: { gh: "2.40.1", gcloud: "458.0.0" } }),
    machine("HELLOWORLD", { tools: { gh: "2.40.1", glab: "1.36.0" } }),
  ]);
  assert.deepEqual(parity.tools.map((t) => t.name), ["gcloud", "gh", "glab"]);
});

test("an installed version, not a missing tool, becomes the expected value", () => {
  const parity = buildFleetParity([
    machine("Mac", { tools: { gh: "2.40.1" } }),
    machine("HELLOWORLD", { tools: { gh: "2.40.1" } }),
    machine("MMCH", { tools: { gh: null } }),
  ]);
  assert.equal(parity.tools.find((t) => t.name === "gh").expected, "2.40.1");
});

test("a stale machine is still listed, so silence cannot hide a gap", () => {
  const parity = buildFleetParity([machine("Mac"), machine("MMCH", { stale: true })]);
  const mmch = parity.machines.find((m) => m.machine === "MMCH");
  assert.equal(mmch.stale, true);
  assert.equal(parity.machines.length, 2);
});

test("a matching version with no reported tools is NOT in sync", () => {
  // The live monitor showed three devices as "in sync" while none of them had
  // reported a single tool version. Version parity and tool parity are separate
  // questions, and answering the second with the first is a false green.
  const parity = buildFleetParity(MACHINES.map((name) => machine(name, { tools: {} })));
  assert.deepEqual(parity.mismatched, []);
  assert.deepEqual(parity.unreported, MACHINES);
  for (const row of parity.machines) {
    assert.equal(row.versionStatus, "same", row.machine);
    assert.equal(row.toolsStatus, "unreported", row.machine);
    assert.equal(row.inSync, false, row.machine);
    assert.equal(row.status, "unreported", row.machine);
  }
});

test("tools reported and all equal is the only path to in-sync", () => {
  const parity = buildFleetParity(MACHINES.map((name) => machine(name)));
  for (const row of parity.machines) {
    assert.equal(row.versionStatus, "same");
    assert.equal(row.toolsStatus, "same");
    assert.equal(row.status, "in-sync");
  }
});

test("no machines at all does not throw", () => {
  const parity = buildFleetParity([]);
  assert.deepEqual(parity.machines, []);
  assert.equal(parity.version, null);
  assert.deepEqual(parity.tools, []);
});
