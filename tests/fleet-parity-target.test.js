import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFleetParity } from "../monitor-server/fleet-parity.cjs";
import { loadApprovedRelease, loadFleetManifestSnapshot } from "../monitor-server/approved-release.cjs";
import { resolveRuntimeVersion } from "../managed/mcp-client-doctor.cjs";

/**
 * WHY THE TARGET NEEDS AN OWNER (16 November 2026)
 * ------------------------------------------------
 * The fleet panel reported "ManagedMCP 1.32.1 / 1.31.0 / 1.31.0" and a target of
 * 1.31.0. The target was not a decision: it was the MAJORITY of whatever the
 * machines last reported. Two machines that had not restarted since the release
 * outvoted the one that had, so the screen recommended the stale version and
 * flagged the correct machine as the odd one out.
 *
 * The authorized release already exists on the release host and is what the
 * bootstrap downloads (current.json: version 1.32.1, revision 623880a...). The
 * panel must compare against that, and fall back to the majority only when no
 * approved release is readable - and say so, rather than pretending.
 */

function machine(name, { version = "1.31.0", revision = "c30d24fb90c0", tools = { gh: "2.102.0" }, stale = false } = {}) {
  return { machine: name, release_version: version, release_revision: revision, toolchain_json: tools, stale };
}

const APPROVED = { version: "1.32.1", revision: "623880a4d1613188ab718f31b6b5d762300635a1" };

test("the target is the approved release, not what most machines happen to run", () => {
  const parity = buildFleetParity(
    [
      machine("HELLOWORLD", { version: "1.32.1", revision: APPROVED.revision }),
      machine("MMCH"),
      machine("Mac"),
    ],
    { approvedRelease: APPROVED }
  );

  assert.equal(parity.version, "1.32.1");
  assert.equal(parity.targetSource, "approved");
  assert.deepEqual(parity.mismatched.sort(), ["MMCH", "Mac"]);
  const mmch = parity.machines.find((m) => m.machine === "MMCH");
  assert.equal(mmch.targetVersion, "1.32.1");
  assert.equal(mmch.runningVersion, "1.31.0");
  assert.equal(mmch.convergenceStatus, "CLIENT_REFRESH_REQUIRED");
});

test("an approved release makes the target known even when every machine is behind", () => {
  const parity = buildFleetParity([machine("MMCH"), machine("Mac")], { approvedRelease: APPROVED });
  assert.equal(parity.version, "1.32.1");
  for (const row of parity.machines) {
    assert.equal(row.versionMismatch, true, row.machine);
    assert.equal(row.status, "drift", row.machine);
  }
});

test("a machine that has not reported yet still shows the approved target", () => {
  const parity = buildFleetParity([machine("MMCH", { version: "", revision: "", tools: {} })], {
    approvedRelease: APPROVED,
  });
  const mmch = parity.machines[0];
  assert.equal(mmch.targetVersion, "1.32.1");
  assert.equal(mmch.version, null);
  assert.equal(mmch.status, "unreported");
});

test("without an approved release the majority is used and labelled as such", () => {
  const parity = buildFleetParity([machine("HELLOWORLD", { version: "1.32.1" }), machine("MMCH"), machine("Mac")]);
  assert.equal(parity.version, "1.31.0");
  assert.equal(parity.targetSource, "reported-majority");
});

test("a pinned manifest decides the expected tool version, not the most common one", () => {
  // Two machines still on wrangler 4.151.3 outvote the one that already runs
  // 4.156.0. Letting the majority win would flag the up-to-date machine as the
  // problem and recommend the stale version to the fleet.
  const parity = buildFleetParity(
    [
      machine("HELLOWORLD", { tools: { gh: "2.102.0", wrangler: "4.151.3" } }),
      machine("MMCH", { tools: { gh: "2.102.0", wrangler: "4.151.3" } }),
      machine("Mac", { tools: { gh: "2.103.3", wrangler: "4.156.0" } }),
    ],
    { fleetManifest: { tools: { gh: "2.103.3", wrangler: "4.156.0" } } }
  );

  const gh = parity.tools.find((t) => t.name === "gh");
  assert.equal(gh.expected, "2.103.3");
  assert.equal(gh.pinned, true);
  assert.deepEqual(parity.mismatched.sort(), ["HELLOWORLD", "MMCH"]);
  assert.deepEqual(parity.machines.find((m) => m.machine === "Mac").driftedTools, []);
});

test("without a manifest the expected tool version is still the reported majority", () => {
  const parity = buildFleetParity([
    machine("HELLOWORLD", { tools: { gh: "2.102.0" } }),
    machine("MMCH", { tools: { gh: "2.102.0" } }),
    machine("Mac", { tools: { gh: "2.103.3" } }),
  ]);
  const gh = parity.tools.find((t) => t.name === "gh");
  assert.equal(gh.expected, "2.102.0");
  assert.equal(gh.pinned, false);
  assert.deepEqual(parity.mismatched, ["Mac"]);
});

test("an approved release is read from the release server's current.json", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devwf-release-"));
  try {
    const file = path.join(dir, "current.json");
    writeFileSync(file, JSON.stringify({ ...APPROVED, channel: "stable", rolloutStatus: "available" }));
    const approved = loadApprovedRelease({ file });
    assert.deepEqual(approved, APPROVED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing, corrupt or unapproved release file yields null instead of a guess", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devwf-release-"));
  try {
    const missing = loadApprovedRelease({ file: path.join(dir, "nope.json") });
    assert.equal(missing, null);

    const corrupt = path.join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not json");
    assert.equal(loadApprovedRelease({ file: corrupt }), null);

    const draft = path.join(dir, "draft.json");
    writeFileSync(draft, JSON.stringify({ ...APPROVED, channel: "canary" }));
    assert.equal(loadApprovedRelease({ file: draft }), null);

    const incomplete = path.join(dir, "incomplete.json");
    writeFileSync(incomplete, JSON.stringify({ version: "1.32.1" }));
    assert.equal(loadApprovedRelease({ file: incomplete }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fleet manifest reader refuses a file without a tool map", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devwf-manifest-"));
  try {
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ schemaVersion: 1, tools: { gh: "2.103.3" } }));
    assert.deepEqual(loadFleetManifestSnapshot({ file: good }).tools, { gh: "2.103.3" });

    const noTools = path.join(dir, "no-tools.json");
    writeFileSync(noTools, JSON.stringify({ schemaVersion: 1 }));
    assert.equal(loadFleetManifestSnapshot({ file: noTools }), null);

    const corrupt = path.join(dir, "corrupt.json");
    writeFileSync(corrupt, "{oops");
    assert.equal(loadFleetManifestSnapshot({ file: corrupt }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the client doctor never invents a runtime version", () => {
  // The doctor used to fall back to the literal '1.31.0' when the bootstrap
  // reported a revision without a version, which reported a release nobody had
  // verified as running.
  assert.equal(resolveRuntimeVersion({ revision: "abc123" }), null);
  assert.equal(resolveRuntimeVersion({ revision: "abc123", version: "1.32.1" }), "1.32.1");
  assert.equal(resolveRuntimeVersion(null), null);
});
