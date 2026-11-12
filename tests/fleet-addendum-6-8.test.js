import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../cli/args.js";
import { runCommand } from "../cli/commands.js";

const require = createRequire(import.meta.url);
const {
  TEST_OUTCOME_STATUSES,
  UPGRADE_PERMISSIONS,
  authorizeFleetOperation,
  createLocalTransportProvider,
  createSSHTransportProvider,
  createAgentLifecycleAdapter,
  createFleetInventory,
  createFleetOrchestrator,
} = require("../managed/fleet-providers.cjs");

const {
  createReleaseManifest,
} = require("../managed/fleet-update-manager.cjs");

const REV_1 = "1".repeat(40);
const REV_2 = "2".repeat(40);
const SHA_1 = "a".repeat(64);
const SHA_2 = "b".repeat(64);
const TOOLS_1 = "sha256:" + "c".repeat(64);
const TOOLS_2 = "sha256:" + "d".repeat(64);

function manifest1() {
  return createReleaseManifest({
    releaseId: "rel-1.30.0",
    version: "1.30.0",
    revision: REV_1,
    sha256: SHA_1,
    size: 1024,
    toolCatalogDigest: TOOLS_1,
  });
}

function manifest2() {
  return createReleaseManifest({
    releaseId: "rel-1.31.0",
    version: "1.31.0",
    revision: REV_2,
    sha256: SHA_2,
    size: 2048,
    toolCatalogDigest: TOOLS_2,
  });
}

test("Consolidated Architectural Addendum #6–#8 — Universal Providers, Session Resume & One-Trigger Fleet Upgrade", async (t) => {
  await t.test("Section 13 & 15: 6-Tier Upgrade Authorization strictly separates check, stage, activate, interrupt, force_restart, and publish from agent task permissions", () => {
    assert.deepEqual(Object.values(UPGRADE_PERMISSIONS).sort(), [
      "fleet:activate",
      "fleet:check",
      "fleet:force_restart",
      "fleet:interrupt",
      "fleet:publish",
      "fleet:stage",
    ]);

    // Ordinary coding agent only has task:execute and fleet:check
    const codingAgentActor = { role: "coding_agent", permissions: ["task:execute", "fleet:check"] };
    assert.equal(authorizeFleetOperation(codingAgentActor, UPGRADE_PERMISSIONS.CHECK).allowed, true);
    assert.equal(authorizeFleetOperation(codingAgentActor, UPGRADE_PERMISSIONS.STAGE).allowed, false);
    assert.equal(authorizeFleetOperation(codingAgentActor, UPGRADE_PERMISSIONS.ACTIVATE).allowed, false);
    assert.equal(authorizeFleetOperation(codingAgentActor, UPGRADE_PERMISSIONS.INTERRUPT).allowed, false);
    assert.equal(authorizeFleetOperation(codingAgentActor, UPGRADE_PERMISSIONS.FORCE_RESTART).allowed, false);
    assert.equal(authorizeFleetOperation(codingAgentActor, UPGRADE_PERMISSIONS.PUBLISH).allowed, false);

    // Operator with stage + activate still cannot force_restart without explicit fleet:force_restart
    const stageOperator = {
      role: "operator",
      permissions: [UPGRADE_PERMISSIONS.CHECK, UPGRADE_PERMISSIONS.STAGE, UPGRADE_PERMISSIONS.ACTIVATE],
    };
    assert.equal(authorizeFleetOperation(stageOperator, UPGRADE_PERMISSIONS.ACTIVATE).allowed, true);
    assert.equal(authorizeFleetOperation(stageOperator, UPGRADE_PERMISSIONS.FORCE_RESTART).allowed, false);
  });

  await t.test("Section 13: Local-only installation, missing optional providers, and public installation without Tailscale, Zettly, or PocketBase", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-a68-local-"));
    try {
      const inventory = createFleetInventory({
        env: {}, // Zero Tailscale, zero Zettly, zero PocketBase, zero SSH hosts
        cacheRoot: root,
      });
      assert.equal(inventory.mode, "PUBLIC_LOCAL_FIRST");
      assert.equal(inventory.machines.length, 1);
      assert.equal(inventory.machines[0].transport, "local");
      assert.equal(inventory.optionalProviders.ssh.enabled, false);
      assert.equal(inventory.optionalProviders.tailscale.enabled, false);
      assert.equal(inventory.optionalProviders.docker.status, TEST_OUTCOME_STATUSES.NOT_SUPPORTED);

      const localProvider = createLocalTransportProvider({ platform: process.platform });
      const res = await localProvider.execute({
        command: "echo local-ok",
        runner: async () => ({ exitCode: 0, stdout: "local-ok" }),
      });
      assert.equal(res.ok, true);
      assert.equal(res.outcomeStatus, TEST_OUTCOME_STATUSES.PASS);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Section 13: Windows PowerShell remote execution, macOS terminal remote execution, SSH connectivity failure, and SSH host identity mismatch", async () => {
    const calls = [];
    const sshWin = createSSHTransportProvider({
      host: "workstation-win",
      platform: "win32",
      runner: async (cmd, args) => {
        calls.push({ cmd, args });
        return { exitCode: 0, stdout: "WIN_PS_OK" };
      },
    });
    const winRes = await sshWin.executeRemote("Write-Output 'WIN_PS_OK'");
    assert.equal(winRes.ok, true);
    assert.ok(calls[0].args.includes("-EncodedCommand"), "Windows remote execution must use PowerShell -EncodedCommand");
    assert.ok(calls[0].args.includes("StrictHostKeyChecking=yes"), "SSH provider must enforce StrictHostKeyChecking=yes");

    const sshMac = createSSHTransportProvider({
      host: "workstation-mac",
      platform: "darwin",
      runner: async (cmd, args) => {
        calls.push({ cmd, args });
        return { exitCode: 0, stdout: "MAC_SH_OK" };
      },
    });
    const macRes = await sshMac.executeRemote("echo MAC_SH_OK");
    assert.equal(macRes.ok, true);
    assert.match(calls[1].args.at(-1), /base64 -d \| sh/, "macOS remote execution must use base64 POSIX shell pipeline");

    // SSH connectivity failure
    const sshDown = createSSHTransportProvider({
      host: "offline-node",
      platform: "linux",
      runner: async () => {
        const err = new Error("ssh: connect to host offline-node port 22: Operation timed out");
        throw err;
      },
    });
    const downRes = await sshDown.executeRemote("echo ping");
    assert.equal(downRes.ok, false);
    assert.equal(downRes.failureCode, "SSH_CONNECTIVITY_FAILURE");

    // SSH host identity mismatch
    const sshMitm = createSSHTransportProvider({
      host: "compromised-node",
      platform: "linux",
      runner: async () => {
        throw new Error("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Host key verification failed.");
      },
    });
    const mitmRes = await sshMitm.executeRemote("echo ping");
    assert.equal(mitmRes.ok, false);
    assert.equal(mitmRes.failureCode, "SSH_HOST_IDENTITY_MISMATCH");
  });

  await t.test("Section 13: Active AI session checkpointing, session identity mismatch, stale worktree lease, OpenCode resume, Codex resume, and Antigravity capability detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-a68-lifecycle-"));
    try {
      const adapter = createAgentLifecycleAdapter({ cacheRoot: root });

      // 1. Check capabilities for OpenCode, Codex, and Antigravity
      const caps = adapter.getCapabilities();
      assert.equal(caps.opencode.automaticSessionResume, TEST_OUTCOME_STATUSES.PASS);
      assert.equal(caps.codex.automaticSessionResume, TEST_OUTCOME_STATUSES.PASS);
      assert.equal(caps.antigravity.automaticSessionResume, TEST_OUTCOME_STATUSES.NOT_SUPPORTED);

      // 2. Persist durable checkpoint for active OpenCode and Codex sessions
      const cpOpenCode = await adapter.createSessionCheckpoint({
        sessionKey: "ses_opencode_1",
        agent: "opencode",
        taskId: "656",
        projectDir: "/workspace/repo-a",
        worktreeLease: { ownerPid: 1001, expiresAt: Date.now() + 60_000 },
        preUpgradeRevision: REV_1,
        targetRevision: REV_2,
      });
      assert.equal(cpOpenCode.ok, true);
      assert.match(cpOpenCode.checkpoint.checkpointDigest, /^sha256:[a-f0-9]{64}$/);

      // 3. Session identity mismatch is rejected during resume
      await assert.rejects(
        () =>
          adapter.resumeSession({
            checkpointId: cpOpenCode.checkpoint.checkpointId,
            expectedSessionKey: "ses_wrong_identity",
          }),
        /Session identity mismatch/i
      );

      // 4. Stale worktree lease is detected and refused before resuming into a dirty/expired worktree
      const cpStaleLease = await adapter.createSessionCheckpoint({
        sessionKey: "ses_codex_stale",
        agent: "codex",
        taskId: "657",
        projectDir: "/workspace/repo-b",
        worktreeLease: { ownerPid: 1002, expiresAt: Date.now() - 10_000 }, // expired!
        preUpgradeRevision: REV_1,
        targetRevision: REV_2,
      });
      const staleResume = await adapter.resumeSession({
        checkpointId: cpStaleLease.checkpoint.checkpointId,
        expectedSessionKey: "ses_codex_stale",
      });
      assert.equal(staleResume.ok, false);
      assert.equal(staleResume.failureCode, "STALE_WORKTREE_LEASE");

      // 5. OpenCode & Codex valid session resume succeed and verify recovery
      const openCodeResumed = await adapter.resumeSession({
        checkpointId: cpOpenCode.checkpoint.checkpointId,
        expectedSessionKey: "ses_opencode_1",
      });
      assert.equal(openCodeResumed.ok, true);
      assert.equal(openCodeResumed.outcomeStatus, TEST_OUTCOME_STATUSES.PASS);
      assert.equal(openCodeResumed.recoveryVerified, true);

      const cpCodex = await adapter.createSessionCheckpoint({
        sessionKey: "ses_codex_1",
        agent: "codex",
        taskId: "658",
        projectDir: "/workspace/repo-c",
        worktreeLease: { ownerPid: 1003, expiresAt: Date.now() + 60_000 },
        preUpgradeRevision: REV_1,
        targetRevision: REV_2,
      });
      const codexResumed = await adapter.resumeSession({
        checkpointId: cpCodex.checkpoint.checkpointId,
        expectedSessionKey: "ses_codex_1",
      });
      assert.equal(codexResumed.ok, true);
      assert.equal(codexResumed.outcomeStatus, TEST_OUTCOME_STATUSES.PASS);

      // 6. Antigravity capability detection accurately reports NOT_SUPPORTED for forced automatic IDE restart, providing manual fallback
      const cpAgy = await adapter.createSessionCheckpoint({
        sessionKey: "ses_agy_1",
        agent: "antigravity",
        taskId: "659",
        projectDir: "/workspace/repo-d",
        worktreeLease: { ownerPid: 1004, expiresAt: Date.now() + 60_000 },
        preUpgradeRevision: REV_1,
        targetRevision: REV_2,
      });
      const agyResumed = await adapter.resumeSession({
        checkpointId: cpAgy.checkpoint.checkpointId,
        expectedSessionKey: "ses_agy_1",
      });
      assert.equal(agyResumed.ok, true);
      assert.equal(agyResumed.outcomeStatus, TEST_OUTCOME_STATUSES.NOT_SUPPORTED);
      assert.equal(agyResumed.manualResumeRequired, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Section 13 & 14 (F4): Unified 'devwf fleet upgrade --all --resume' handles concurrent lock protection, partial fleet outage, controller recovery, and unauthorized force restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "devwf-a68-orch-"));
    try {
      const m1 = manifest1();
      const m2 = manifest2();

      const orchestrator = createFleetOrchestrator({
        cacheRoot: root,
        targetManifest: m2,
        machines: [
          { label: "node-alpha", platform: "win32", transport: "local" },
          { label: "node-beta", platform: "darwin", transport: "ssh", reachable: true },
          { label: "node-gamma", platform: "win32", transport: "ssh", reachable: false }, // partial outage!
        ],
      });

      // 1. Unauthorized forced restart is rejected
      await assert.rejects(
        () =>
          orchestrator.runFleetUpgrade({
            all: true,
            resume: true,
            force: true,
            actor: { role: "operator", permissions: [UPGRADE_PERMISSIONS.CHECK, UPGRADE_PERMISSIONS.STAGE, UPGRADE_PERMISSIONS.ACTIVATE] },
          }),
        /fleet:force_restart permission is required/i
      );

      // 2. Concurrent fleet upgrade attempt while lock is held is rejected cleanly
      const releaseLock = orchestrator.acquireUpgradeLock("lock-owner-1");
      await assert.rejects(
        () =>
          orchestrator.runFleetUpgrade({
            all: true,
            resume: true,
            actor: { role: "admin", permissions: Object.values(UPGRADE_PERMISSIONS) },
          }),
        /CONCURRENT_UPGRADE_LOCKED/i
      );
      releaseLock();

      // 3. Execute unified upgrade across fleet with 1 unreachable node (partial outage isolation)
      const upgradeReport = await orchestrator.runFleetUpgrade({
        all: true,
        resume: true,
        actor: { role: "admin", permissions: Object.values(UPGRADE_PERMISSIONS) },
      });
      assert.equal(upgradeReport.partialOutageIsolated, true);
      assert.equal(upgradeReport.summary.PASS, 2);
      assert.equal(upgradeReport.summary.FAIL, 1);

      // 4. Recovery following controller failure restores persisted upgrade journal
      const recovered = orchestrator.recoverFromControllerFailure();
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.lastTargetRevision, REV_2);

      // 5. Verify CLI 'devwf fleet upgrade --all --resume --dry-run --json'
      const parsed = parseArgs(["fleet", "upgrade", "--all", "--resume", "--dry-run", "--json"]);
      assert.equal(parsed.command, "fleet");
      assert.equal(parsed.fleetVerb, "upgrade");
      assert.equal(parsed.all, true);
      assert.equal(parsed.resume, true);
      assert.equal(parsed.dryRun, true);
      assert.equal(parsed.json, true);

      const cliOut = [];
      const cliRes = await runCommand({
        args: parsed,
        env: { ...process.env, DEVWF_FLEET_LOCAL_ONLY: "1" },
        out: { write: (l) => cliOut.push(l) },
      });
      assert.equal(cliRes.ok, true);
      const parsedJson = JSON.parse(cliOut.join("\n"));
      assert.equal(parsedJson.verb, "upgrade");
      assert.equal(parsedJson.all, true);
      assert.equal(parsedJson.resume, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Section 17: All 14 required architecture, operations, opensource, and release documentation files exist and contain zero private IPs or personal paths", async () => {
    const requiredDocs = [
      "docs/architecture/fleet-update-architecture.md",
      "docs/architecture/fleet-provider-contracts.md",
      "docs/architecture/runtime-lifecycle.md",
      "docs/architecture/agent-session-resume.md",
      "docs/architecture/mcp-tool-synchronization.md",
      "docs/operations/fleet-configuration.md",
      "docs/operations/fleet-upgrade.md",
      "docs/operations/fleet-rollback.md",
      "docs/operations/session-recovery.md",
      "docs/operations/troubleshooting.md",
      "docs/opensource/local-first-fleet.md",
      "docs/opensource/ssh-provider.md",
      "docs/opensource/agent-compatibility.md",
      "docs/releases/fleet-update-verification.md",
    ];

    for (const relPath of requiredDocs) {
      const fullPath = join(process.cwd(), relPath);
      await access(fullPath);
      const text = await readFile(fullPath, "utf8");
      assert.ok(text.length > 200, `${relPath} must have substantive documentation`);
      // Public/architecture/operations/opensource docs must not leak internal Tailscale IPs or personal workstation paths
      assert.ok(!text.includes("100.77.138.14"), `${relPath} must not contain private Tailscale IP 100.77.138.14`);
      assert.ok(!text.includes("C:\\Users\\DHIKA"), `${relPath} must not contain personal path C:\\Users\\DHIKA`);
      assert.ok(!text.includes("/Users/mahardhika"), `${relPath} must not contain personal path /Users/mahardhika`);
    }
  });
});
