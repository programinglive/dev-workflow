import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../cli/args.js";
import { runCommand } from "../cli/commands.js";

const require = createRequire(import.meta.url);
const {
  TEST_OUTCOME_STATUSES,
  CONVERGENCE_LAYERS,
  CLIENT_VERIFICATION_STATUSES,
  evaluateSevenLayerConvergence,
  UPGRADE_PERMISSIONS,
  createAgentLifecycleAdapter,
  createFleetInventory,
  createFleetOrchestrator,
} = require("../managed/fleet-providers.cjs");

const { createReleaseManifest } = require("../managed/fleet-update-manager.cjs");

const V131_REV = "c30d24fb90c096fe89bd3766ea7d569aa1d409d3";
const V132_SIM_REV = "e320000000000000000000000000000000000001";
const V131_DIGEST = "sha256:40250da52d9cee0a9ae20543bcf3eba499db039a46798ee5bdd022947b66ccd9";
const V132_SIM_DIGEST = "sha256:9999999999999999999999999999999999999999999999999999999999999999";

test("Post-Release v1.31.0 Validation — 7-Layer Convergence, No-Op Idempotency, Synthetic Upgrade & OSS Mode", async (t) => {
  await t.test("1. 7-layer convergence model evaluates all 7 layers independently without collapsing statuses", () => {
    assert.deepEqual([...CONVERGENCE_LAYERS], [
      "RELEASE_ARTIFACT_AVAILABLE",
      "RUNTIME_INSTALLED",
      "RUNTIME_PROCESS_ACTIVE",
      "MCP_CLIENT_CONNECTED",
      "TOOL_CATALOG_DISCOVERED",
      "TOOL_INVOCATION_SUCCESSFUL",
      "AI_SESSION_RECOVERY_VERIFIED",
    ]);

    // Fully verified OpenCode cell
    const opencodeCell = evaluateSevenLayerConvergence({
      machine: "HELLOWORLD",
      client: "opencode",
      layers: {
        RELEASE_ARTIFACT_AVAILABLE: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        RUNTIME_INSTALLED: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        RUNTIME_PROCESS_ACTIVE: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        MCP_CLIENT_CONNECTED: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        TOOL_CATALOG_DISCOVERED: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        TOOL_INVOCATION_SUCCESSFUL: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        AI_SESSION_RECOVERY_VERIFIED: CLIENT_VERIFICATION_STATUSES.VERIFIED,
      },
    });
    assert.equal(opencodeCell.overallStatus, CLIENT_VERIFICATION_STATUSES.VERIFIED);
    assert.equal(opencodeCell.counts.VERIFIED, 7);

    // Antigravity active window requiring manual reload for in-session cutover
    const agyCell = evaluateSevenLayerConvergence({
      machine: "HELLOWORLD",
      client: "antigravity",
      layers: {
        RELEASE_ARTIFACT_AVAILABLE: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        RUNTIME_INSTALLED: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        RUNTIME_PROCESS_ACTIVE: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        MCP_CLIENT_CONNECTED: CLIENT_VERIFICATION_STATUSES.MANUAL_VERIFICATION_REQUIRED,
        TOOL_CATALOG_DISCOVERED: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        TOOL_INVOCATION_SUCCESSFUL: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        AI_SESSION_RECOVERY_VERIFIED: CLIENT_VERIFICATION_STATUSES.NOT_SUPPORTED,
      },
    });
    assert.equal(agyCell.overallStatus, CLIENT_VERIFICATION_STATUSES.MANUAL_VERIFICATION_REQUIRED);
    assert.equal(agyCell.counts.NOT_SUPPORTED, 1);

    // Failed layer propagates FAILED without masking other verified layers
    const failedCell = evaluateSevenLayerConvergence({
      machine: "node-x",
      client: "codex",
      layers: {
        RELEASE_ARTIFACT_AVAILABLE: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        RUNTIME_INSTALLED: CLIENT_VERIFICATION_STATUSES.VERIFIED,
        RUNTIME_PROCESS_ACTIVE: CLIENT_VERIFICATION_STATUSES.FAILED,
        MCP_CLIENT_CONNECTED: CLIENT_VERIFICATION_STATUSES.NOT_TESTED,
        TOOL_CATALOG_DISCOVERED: CLIENT_VERIFICATION_STATUSES.NOT_VERIFIABLE,
      },
    });
    assert.equal(failedCell.overallStatus, CLIENT_VERIFICATION_STATUSES.FAILED);
    assert.equal(failedCell.counts.NOT_TESTED, 3);
    assert.equal(failedCell.counts.NOT_VERIFIABLE, 1);
  });

  await t.test("2. Safe idempotent no-op upgrade when already converged on v1.31.0 (zero downloads, zero restarts, zero duplicate checkpoints)", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-v131-noop-"));
    try {
      const targetManifest = createReleaseManifest({
        releaseId: "rel-1.31.0",
        version: "1.31.0",
        revision: V131_REV,
        sha256: "661d04541a0c02c3d63e7d78318070e874442d82db27f9df7102ac493a5310f1",
        size: 4635585,
        toolCatalogDigest: V131_DIGEST,
      });

      const convergedMachines = [
        { label: "HELLOWORLD", transport: "local", installedRevision: V131_REV, runningRevision: V131_REV, toolCatalogDigest: V131_DIGEST },
        { label: "MMCH", transport: "ssh", installedRevision: V131_REV, runningRevision: V131_REV, toolCatalogDigest: V131_DIGEST },
        { label: "Mac", transport: "ssh", installedRevision: V131_REV, runningRevision: V131_REV, toolCatalogDigest: V131_DIGEST },
      ];

      const orchestrator = createFleetOrchestrator({
        cacheRoot: root,
        targetManifest,
        machines: convergedMachines,
      });

      const firstRun = await orchestrator.runFleetUpgrade({
        all: true,
        resume: true,
        actor: { role: "admin", permissions: Object.values(UPGRADE_PERMISSIONS) },
      });

      assert.equal(firstRun.noOp, true);
      assert.equal(firstRun.summary.PASS, 3);
      assert.equal(firstRun.summary.FAIL, 0);
      assert.equal(firstRun.metrics.downloads, 0);
      assert.equal(firstRun.metrics.restarts, 0);
      assert.equal(firstRun.metrics.checkpointsCreated, 0);
      assert.equal(firstRun.metrics.noOpCount, 3);
      for (const r of firstRun.results) {
        assert.equal(r.noOp, true);
        assert.equal(r.alreadyConverged, true);
        assert.equal(r.restarted, false);
        assert.equal(r.checkpointCreated, false);
      }

      // Repeated invocation remains idempotent
      const secondRun = await orchestrator.runFleetUpgrade({
        all: true,
        resume: true,
        actor: { role: "admin", permissions: Object.values(UPGRADE_PERMISSIONS) },
      });
      assert.equal(secondRun.noOp, true);
      assert.equal(secondRun.metrics.noOpCount, 3);
      assert.equal(secondRun.metrics.downloads, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("3. Multi-node CLI dry-run inventory reports all enrolled machines via DEVWF_FLEET_NODES_JSON", async () => {
    const parsed = parseArgs(["fleet", "upgrade", "--all", "--resume", "--dry-run", "--json"]);
    const cliOut = [];
    const nodes = [
      { label: "HELLOWORLD", host: "helloworld", platform: "win32", transport: "local" },
      { label: "MMCH", host: "mmch", platform: "win32", transport: "ssh" },
      { label: "Mac", host: "mac", platform: "darwin", transport: "ssh" },
    ];
    const res = await runCommand({
      args: parsed,
      env: {
        ...process.env,
        DEVWF_FLEET_LOCAL_ONLY: "1",
        DEVWF_FLEET_NODES_JSON: JSON.stringify(nodes),
      },
      out: { write: (l) => cliOut.push(l) },
    });
    assert.equal(res.ok, true);
    const payload = JSON.parse(cliOut.join("\n"));
    assert.equal(payload.mode, "ENROLLED_FLEET");
    assert.equal(payload.upgradeReport.summary.PASS, 3);
    assert.deepEqual(
      payload.upgradeReport.results.map((r) => r.machine),
      ["HELLOWORLD", "MMCH", "Mac"]
    );
  });

  await t.test("4. Realistic synthetic upgrade simulation (v1.31.0 -> v1.32.0-sim): active sessions, stale catalog, offline node, rollback & resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-v132-sim-"));
    try {
      const v132SimManifest = createReleaseManifest({
        releaseId: "rel-1.32.0-sim",
        version: "1.32.0",
        revision: V132_SIM_REV,
        sha256: "e".repeat(64),
        size: 4700000,
        toolCatalogDigest: V132_SIM_DIGEST,
      });

      const orchestrator = createFleetOrchestrator({
        cacheRoot: root,
        targetManifest: v132SimManifest,
        machines: [
          // Active OpenCode/Codex session upgrades & checkpoints
          {
            label: "sim-node-active",
            transport: "local",
            installedRevision: V131_REV,
            runningRevision: V131_REV,
            toolCatalogDigest: V131_DIGEST,
            hasActiveSession: true,
          },
          // Stale tool catalog even when revision matches triggers refresh
          {
            label: "sim-node-stale-catalog",
            transport: "ssh",
            installedRevision: V132_SIM_REV,
            runningRevision: V132_SIM_REV,
            toolCatalogDigest: V131_DIGEST,
            staleToolCatalog: true,
          },
          // Offline machine is isolated without aborting other nodes
          {
            label: "sim-node-offline",
            transport: "ssh",
            reachable: false,
            installedRevision: V131_REV,
            runningRevision: V131_REV,
          },
          // Activation failure triggers automatic rollback to v1.31.0
          {
            label: "sim-node-rollback",
            transport: "ssh",
            installedRevision: V131_REV,
            runningRevision: V131_REV,
            simulateActivationFailure: true,
          },
        ],
      });

      const simReport = await orchestrator.runFleetUpgrade({
        all: true,
        resume: true,
        actor: { role: "admin", permissions: Object.values(UPGRADE_PERMISSIONS) },
      });

      assert.equal(simReport.noOp, false);
      assert.equal(simReport.partialOutageIsolated, true);
      assert.equal(simReport.summary.PASS, 2);
      assert.equal(simReport.summary.FAIL, 2);
      assert.equal(simReport.metrics.downloads, 1);
      assert.equal(simReport.metrics.checkpointsCreated, 1);
      assert.equal(simReport.metrics.restarts, 2);
      assert.equal(simReport.metrics.rollbacks, 1);

      const rollbackRes = simReport.results.find((r) => r.machine === "sim-node-rollback");
      assert.equal(rollbackRes.failureCode, "ACTIVATION_FAILED_ROLLED_BACK");
      assert.equal(rollbackRes.rolledBack, true);
      assert.equal(rollbackRes.activeRevision, V131_REV);

      // Session resume & capability checks on disposable adapter
      const adapter = createAgentLifecycleAdapter({ cacheRoot: root });
      const cpOpenCode = await adapter.createSessionCheckpoint({
        sessionKey: "sim_opencode_1",
        agent: "opencode",
        projectDir: root,
        worktreeLease: { ownerPid: 9999, expiresAt: Date.now() + 60_000 },
        preUpgradeRevision: V131_REV,
        targetRevision: V132_SIM_REV,
      });
      const resumedOpenCode = await adapter.resumeSession({
        checkpointId: cpOpenCode.checkpoint.checkpointId,
        expectedSessionKey: "sim_opencode_1",
      });
      assert.equal(resumedOpenCode.outcomeStatus, TEST_OUTCOME_STATUSES.PASS);
      assert.equal(resumedOpenCode.resumedTargetRevision, V132_SIM_REV);

      const cpAgy = await adapter.createSessionCheckpoint({
        sessionKey: "sim_agy_1",
        agent: "antigravity",
        projectDir: root,
        worktreeLease: { ownerPid: 9998, expiresAt: Date.now() + 60_000 },
        preUpgradeRevision: V131_REV,
        targetRevision: V132_SIM_REV,
      });
      const resumedAgy = await adapter.resumeSession({
        checkpointId: cpAgy.checkpoint.checkpointId,
        expectedSessionKey: "sim_agy_1",
      });
      assert.equal(resumedAgy.outcomeStatus, TEST_OUTCOME_STATUSES.NOT_SUPPORTED);
      assert.equal(resumedAgy.manualResumeRequired, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("5. Open-source local-first compatibility works 100% offline without Tailscale, SSH, Zettly, PocketBase, or private inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-oss-local-"));
    try {
      const inv = createFleetInventory({
        env: { DEVWF_PUBLIC_LOCAL_FIRST: "1" },
        cacheRoot: root,
        discoverEnrolled: true,
      });
      assert.equal(inv.mode, "PUBLIC_LOCAL_FIRST");
      assert.equal(inv.machines.length, 1);
      assert.equal(inv.machines[0].transport, "local");
      assert.equal(inv.optionalProviders.ssh.enabled, false);
      assert.equal(inv.optionalProviders.tailscale.enabled, false);
      assert.equal(inv.optionalProviders.zettly.enabled, false);
      assert.equal(inv.optionalProviders.pocketbase.enabled, false);

      const cliOut = [];
      const parsed = parseArgs(["fleet", "upgrade", "--all", "--resume", "--dry-run", "--json"]);
      const res = await runCommand({
        args: parsed,
        env: { DEVWF_PUBLIC_LOCAL_FIRST: "1" },
        out: { write: (l) => cliOut.push(l) },
      });
      assert.equal(res.ok, true);
      const payload = JSON.parse(cliOut.join("\n"));
      assert.equal(payload.mode, "PUBLIC_LOCAL_FIRST");
      assert.equal(payload.upgradeReport.summary.PASS, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
