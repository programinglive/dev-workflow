import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../cli/args.js";
import { runCommand } from "../cli/commands.js";

const require = createRequire(import.meta.url);
const {
  UPDATE_STATES,
  CONVERGENCE_STATUSES,
  UPDATE_MODES,
  CLIENT_COMPATIBILITY_MATRIX,
  computeToolCatalogDigest,
  createReleaseManifest,
  validateExtendedManifest,
  createMachineUpdateSupervisor,
  evaluateFleetConvergence,
  runFleetDoctor,
} = require("../managed/fleet-update-manager.cjs");

const REV_1 = "1".repeat(40);
const REV_2 = "2".repeat(40);
const SHA_1 = "a".repeat(64);
const SHA_2 = "b".repeat(64);
const TOOLS_1 = "sha256:" + "c".repeat(64);
const TOOLS_2 = "sha256:" + "d".repeat(64);

function sampleManifest1() {
  return createReleaseManifest({
    releaseId: "rel-1.30.0",
    version: "1.30.0",
    revision: REV_1,
    sha256: SHA_1,
    size: 2048,
    channel: "stable",
    minimumCompatibleClient: "1.0.0",
    toolCatalogDigest: TOOLS_1,
    rolloutStatus: "available",
  });
}

function sampleManifest2() {
  return createReleaseManifest({
    releaseId: "rel-1.31.0",
    version: "1.31.0",
    revision: REV_2,
    sha256: SHA_2,
    size: 4096,
    channel: "stable",
    minimumCompatibleClient: "1.0.0",
    toolCatalogDigest: TOOLS_2,
    rolloutStatus: "available",
  });
}

test("Architectural Addendum #5 — Automated Fleet Update Manager & MCP Tool Sync (20 Required Scenarios)", async (t) => {
  await t.test("Scenario 1 & 2: New artifact available while old MCP process runs; active session pins previous runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-f5-s1-"));
    try {
      const sup = createMachineUpdateSupervisor({
        machine: "HELLOWORLD",
        platform: "win32",
        cacheRoot: root,
        mode: UPDATE_MODES.SAFE_AUTOMATIC,
      });

      const m1 = sampleManifest1();
      await sup.stageRelease(m1, { artifactBytes: Buffer.alloc(m1.size, "x"), skipHashVerify: true });
      await sup.activateRelease(m1, { authorized: true });

      // Register an active coding session pinned to m1
      sup.registerProcess({
        pid: 41001,
        client: "opencode",
        sessionKey: "ses_dbpinball",
        activeCriticalSession: true,
        revision: m1.revision,
        version: m1.version,
        toolCatalogDigest: m1.toolCatalogDigest,
      });

      // Now m2 becomes available and is staged
      const m2 = sampleManifest2();
      await sup.stageRelease(m2, { artifactBytes: Buffer.alloc(m2.size, "y"), skipHashVerify: true });

      // Attempting safe cutover while active session is running must NOT kill pid 41001
      const cutover = await sup.activateRelease(m2, { authorized: true });
      assert.equal(cutover.state, UPDATE_STATES.WAITING_FOR_SAFE_CUTOVER);
      assert.equal(cutover.convergenceStatus, CONVERGENCE_STATUSES.PINNED_ACTIVE_SESSION);
      assert.equal(cutover.pinnedProcesses.length, 1);
      assert.equal(cutover.pinnedProcesses[0].revision, REV_1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Scenario 3, 16 & 17: Safe cutover after session completion; new sessions use target version while existing active sessions remain uninterrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-f5-s3-"));
    try {
      const sup = createMachineUpdateSupervisor({
        machine: "HELLOWORLD",
        platform: "win32",
        cacheRoot: root,
        mode: UPDATE_MODES.SAFE_AUTOMATIC,
      });
      const m1 = sampleManifest1();
      const m2 = sampleManifest2();
      await sup.stageRelease(m1, { artifactBytes: Buffer.alloc(m1.size, "x"), skipHashVerify: true });
      await sup.activateRelease(m1, { authorized: true });

      sup.registerProcess({
        pid: 41002,
        client: "opencode",
        sessionKey: "ses_active",
        activeCriticalSession: true,
        revision: m1.revision,
        version: m1.version,
        toolCatalogDigest: m1.toolCatalogDigest,
      });

      await sup.stageRelease(m2, { artifactBytes: Buffer.alloc(m2.size, "y"), skipHashVerify: true });
      const whileActive = await sup.activateRelease(m2, { authorized: true });
      assert.equal(whileActive.state, UPDATE_STATES.WAITING_FOR_SAFE_CUTOVER);

      // Scenario 16: New session spawned while old session is still pinned uses the newly staged m2 runtime!
      const resolvedForNewSession = sup.resolveRuntimeForNewSession();
      assert.equal(resolvedForNewSession.revision, REV_2);
      assert.equal(resolvedForNewSession.version, "1.31.0");

      // Scenario 17: Existing active session on pid 41002 is still running REV_1 uninterrupted
      const running = sup.listProcesses();
      assert.equal(running[0].revision, REV_1);

      // Scenario 3: Active session completes and unregisters -> safe cutover activates m2 and converges
      sup.unregisterProcess(41002);
      const afterDrain = await sup.activateRelease(m2, { authorized: true });
      assert.equal(afterDrain.state, UPDATE_STATES.ACTIVE);
      assert.equal(afterDrain.convergenceStatus, CONVERGENCE_STATUSES.CONVERGED);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Scenario 4 & 13: Multiple clients on one machine; client unable to refresh automatically reports CLIENT_RECONNECT_REQUIRED without killing client", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-f5-s4-"));
    try {
      const sup = createMachineUpdateSupervisor({
        machine: "HELLOWORLD",
        platform: "win32",
        cacheRoot: root,
        mode: UPDATE_MODES.SAFE_AUTOMATIC,
      });
      const m1 = sampleManifest1();
      const m2 = sampleManifest2();
      await sup.stageRelease(m1, { artifactBytes: Buffer.alloc(m1.size, "x"), skipHashVerify: true });
      await sup.activateRelease(m1, { authorized: true });

      // Both OpenCode (idle) and Antigravity/Codex (stdio child) are running m1
      sup.registerProcess({
        pid: 5001,
        client: "opencode",
        sessionKey: null,
        activeCriticalSession: false,
        revision: m1.revision,
        version: m1.version,
        toolCatalogDigest: m1.toolCatalogDigest,
      });
      sup.registerProcess({
        pid: 5002,
        client: "antigravity",
        sessionKey: null,
        activeCriticalSession: false,
        revision: m1.revision,
        version: m1.version,
        toolCatalogDigest: m1.toolCatalogDigest,
      });

      assert.equal(CLIENT_COMPATIBILITY_MATRIX.opencode.supportsAutomaticRefresh, true);
      assert.equal(CLIENT_COMPATIBILITY_MATRIX.codex.supportsAutomaticRefresh, false);
      assert.equal(CLIENT_COMPATIBILITY_MATRIX.antigravity.supportsAutomaticRefresh, false);

      await sup.stageRelease(m2, { artifactBytes: Buffer.alloc(m2.size, "y"), skipHashVerify: true });
      const res = await sup.activateRelease(m2, { authorized: true });

      // OpenCode refreshes automatically, while Antigravity is marked CLIENT_RECONNECT_REQUIRED (never force-killed)
      assert.equal(res.clientRefreshResults.opencode.status, "REFRESHED");
      assert.equal(res.clientRefreshResults.antigravity.status, "CLIENT_RECONNECT_REQUIRED");
      assert.equal(res.convergenceStatus, CONVERGENCE_STATUSES.CLIENT_REFRESH_REQUIRED);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Scenario 5 & 14: Runtime activation / health verification failure triggers automatic rollback to retained candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-f5-s5-"));
    try {
      const sup = createMachineUpdateSupervisor({
        machine: "MMCH",
        platform: "win32",
        cacheRoot: root,
        mode: UPDATE_MODES.SAFE_AUTOMATIC,
      });
      const m1 = sampleManifest1();
      const m2 = sampleManifest2();
      await sup.stageRelease(m1, { artifactBytes: Buffer.alloc(m1.size, "x"), skipHashVerify: true });
      await sup.activateRelease(m1, { authorized: true });

      await sup.stageRelease(m2, { artifactBytes: Buffer.alloc(m2.size, "y"), skipHashVerify: true });

      // Simulate failed health check during activation of m2
      const failedActivation = await sup.activateRelease(m2, {
        authorized: true,
        healthCheckFn: async () => ({ ok: false, reason: "better-sqlite3 ABI load error" }),
      });

      assert.equal(failedActivation.rolledBack, true);
      assert.equal(failedActivation.activeManifest.revision, REV_1);
      assert.equal(failedActivation.state, UPDATE_STATES.ACTIVE);
      assert.match(failedActivation.lastError, /better-sqlite3 ABI load error/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Scenario 6 & 7: Interrupted download and artifact SHA-256 digest mismatch are rejected before staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-f5-s6-"));
    try {
      const sup = createMachineUpdateSupervisor({
        machine: "Mac",
        platform: "darwin",
        cacheRoot: root,
      });
      const m2 = sampleManifest2();

      // Scenario 6: Interrupted download (truncated byte length)
      await assert.rejects(
        () => sup.stageRelease(m2, { artifactBytes: Buffer.alloc(100, "z") }),
        /archive size mismatch|Interrupted download/i
      );

      // Scenario 7: Artifact digest mismatch (correct size, wrong content hash)
      await assert.rejects(
        () => sup.stageRelease(m2, { artifactBytes: Buffer.alloc(m2.size, "z") }),
        /artifact digest mismatch|SHA256 mismatch/i
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Scenario 8 & 19: Offline machine reconnect and internal services unavailable degrade gracefully to cached release", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-f5-s8-"));
    try {
      const sup = createMachineUpdateSupervisor({
        machine: "Mac",
        platform: "darwin",
        cacheRoot: root,
      });
      const m1 = sampleManifest1();
      await sup.stageRelease(m1, { artifactBytes: Buffer.alloc(m1.size, "x"), skipHashVerify: true });
      await sup.activateRelease(m1, { authorized: true });

      // Internal release controller is unreachable
      const checkOffline = await sup.checkForUpdates({
        fetchTargetManifest: async () => {
          const err = new Error("connect ETIMEDOUT 127.0.0.1:3101");
          err.network = true;
          throw err;
        },
      });
      assert.equal(checkOffline.offline, true);
      assert.equal(checkOffline.activeRevision, REV_1);

      // Machine reconnects and discovers m2
      const m2 = sampleManifest2();
      const checkOnline = await sup.checkForUpdates({
        fetchTargetManifest: async () => m2,
      });
      assert.equal(checkOnline.offline, false);
      assert.equal(checkOnline.state, UPDATE_STATES.UPDATE_AVAILABLE);
      assert.equal(checkOnline.targetManifest.revision, REV_2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Scenario 9, 10 & 11: Duplicate update request is idempotent; downgrade attempt and unauthorized activation are blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-f5-s9-"));
    try {
      const sup = createMachineUpdateSupervisor({
        machine: "MMCH",
        platform: "win32",
        cacheRoot: root,
        mode: UPDATE_MODES.MANUAL,
      });
      const m2 = sampleManifest2();
      const firstStage = await sup.stageRelease(m2, { artifactBytes: Buffer.alloc(m2.size, "y"), skipHashVerify: true });
      const secondStage = await sup.stageRelease(m2, { artifactBytes: Buffer.alloc(m2.size, "y"), skipHashVerify: true });
      assert.equal(firstStage.stagedRevision, REV_2);
      assert.equal(secondStage.idempotent, true);

      // Scenario 11: Unauthorized update activation in MANUAL mode is rejected
      await assert.rejects(
        () => sup.activateRelease(m2, { authorized: false }),
        /Explicit operator authorization is required/i
      );

      await sup.activateRelease(m2, { authorized: true });

      // Scenario 10: Downgrade attempt from 1.31.0 -> 1.30.0 without explicit rollback flag is blocked
      const m1 = sampleManifest1();
      await assert.rejects(
        () => sup.stageRelease(m1, { artifactBytes: Buffer.alloc(m1.size, "x"), skipHashVerify: true }),
        /Downgrade protection/i
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Scenario 12: Old MCP tool catalog detected via toolCatalogDigest mismatch even when version matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-f5-s12-"));
    try {
      const sup = createMachineUpdateSupervisor({
        machine: "HELLOWORLD",
        platform: "win32",
        cacheRoot: root,
      });
      const m2 = sampleManifest2();
      await sup.stageRelease(m2, { artifactBytes: Buffer.alloc(m2.size, "y"), skipHashVerify: true });
      await sup.activateRelease(m2, { authorized: true });

      // Process has right revision/version, but an old cached toolCatalogDigest
      sup.registerProcess({
        pid: 6001,
        client: "opencode",
        sessionKey: null,
        activeCriticalSession: false,
        revision: m2.revision,
        version: m2.version,
        toolCatalogDigest: TOOLS_1, // stale tool catalog!
      });

      const status = sup.getStatus();
      assert.equal(status.staleToolCatalogDetected, true);
      assert.equal(status.convergenceStatus, CONVERGENCE_STATUSES.CLIENT_REFRESH_REQUIRED);

      const doctor = runFleetDoctor([status]);
      assert.ok(doctor.findings.some((f) => f.code === "STALE_TOOL_REGISTRY"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Scenario 15, 18 & 20: Mixed Windows/macOS behavior, accurate partial convergence fleet summary, and public local-first standalone operation", async () => {
    const rootWin = await mkdtemp(join(tmpdir(), "devwf-f5-win-"));
    const rootMac = await mkdtemp(join(tmpdir(), "devwf-f5-mac-"));
    const rootLocal = await mkdtemp(join(tmpdir(), "devwf-f5-local-"));
    try {
      const m1 = sampleManifest1();
      const m2 = sampleManifest2();

      // Machine 1 (MMCH - Windows): Fully converged on m2
      const mmch = createMachineUpdateSupervisor({ machine: "MMCH", platform: "win32", cacheRoot: rootWin });
      await mmch.stageRelease(m2, { artifactBytes: Buffer.alloc(m2.size, "y"), skipHashVerify: true });
      await mmch.activateRelease(m2, { authorized: true });

      // Machine 2 (Mac - darwin): Staged m2, still running m1 in a pinned active session
      const mac = createMachineUpdateSupervisor({ machine: "Mac", platform: "darwin", cacheRoot: rootMac });
      await mac.stageRelease(m1, { artifactBytes: Buffer.alloc(m1.size, "x"), skipHashVerify: true });
      await mac.activateRelease(m1, { authorized: true });
      mac.registerProcess({
        pid: 7001,
        client: "opencode",
        sessionKey: "ses_mac_active",
        activeCriticalSession: true,
        revision: m1.revision,
        version: m1.version,
        toolCatalogDigest: m1.toolCatalogDigest,
      });
      await mac.stageRelease(m2, { artifactBytes: Buffer.alloc(m2.size, "y"), skipHashVerify: true });
      await mac.activateRelease(m2, { authorized: true });

      // Verify platform-specific process command generation
      assert.match(mmch.getPlatformProcessHints().checkCommand, /Get-CimInstance/);
      assert.match(mac.getPlatformProcessHints().checkCommand, /pgrep/);

      // Scenario 18: Fleet convergence reports partial convergence accurately
      const fleet = evaluateFleetConvergence({
        targetManifest: m2,
        machines: [mmch.getStatus(), mac.getStatus()],
      });
      assert.equal(fleet.fullyConverged, false);
      assert.equal(fleet.overallStatus, CONVERGENCE_STATUSES.PINNED_ACTIVE_SESSION);
      assert.equal(fleet.counts.CONVERGED, 1);
      assert.equal(fleet.counts.PINNED_ACTIVE_SESSION, 1);

      // Scenario 20: Public local-first standalone operation without central server
      const localSup = createMachineUpdateSupervisor({
        machine: "localhost",
        platform: process.platform,
        cacheRoot: rootLocal,
        localFirstStandalone: true,
      });
      const localStatus = localSup.getStatus();
      assert.equal(localStatus.localFirstStandalone, true);
      assert.equal(localStatus.convergenceStatus, CONVERGENCE_STATUSES.CONVERGED);
    } finally {
      await rm(rootWin, { recursive: true, force: true });
      await rm(rootMac, { recursive: true, force: true });
      await rm(rootLocal, { recursive: true, force: true });
    }
  });

  await t.test("CLI-First devwf fleet subcommands (status, check, plan, stage, activate, verify, rollback, doctor) produce structured JSON & human output", async () => {
    for (const verb of ["status", "check", "plan", "stage", "activate", "verify", "rollback", "doctor"]) {
      const parsed = parseArgs(["fleet", verb, "--json"]);
      assert.equal(parsed.command, "fleet");
      assert.equal(parsed.fleetVerb, verb);
      assert.equal(parsed.json, true);
    }

    const lines = [];
    const out = { write: (l) => lines.push(l) };
    const statusRes = await runCommand({
      args: parseArgs(["fleet", "status", "--json"]),
      env: { ...process.env, DEVWF_FLEET_LOCAL_ONLY: "1" },
      out,
    });
    assert.equal(statusRes.ok, true);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(typeof payload.overallStatus, "string");
    assert.ok(Array.isArray(payload.machines));

    const doctorLines = [];
    const doctorRes = await runCommand({
      args: parseArgs(["fleet", "doctor", "--json"]),
      env: { ...process.env, DEVWF_FLEET_LOCAL_ONLY: "1" },
      out: { write: (l) => doctorLines.push(l) },
    });
    assert.equal(doctorRes.ok, true);
    const doctorJson = JSON.parse(doctorLines.join("\n"));
    assert.ok(Array.isArray(doctorJson.findings));
    assert.equal(typeof doctorJson.recommendedNextAction, "object");
  });
});
