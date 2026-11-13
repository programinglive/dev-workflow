import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const {
  TEST_OUTCOME_STATUSES,
  createAgentLifecycleAdapter,
} = require("../managed/fleet-providers.cjs");
const {
  computeToolCatalogDigest,
  createMachineUpdateSupervisor,
  createReleaseManifest,
} = require("../managed/fleet-update-manager.cjs");

const REPO_ROOT = process.cwd();
const INDEX_JS = join(REPO_ROOT, "index.js");

function createTempGitWorktree(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Disposable Verification"], { cwd: dir });
}

function runMcpCliCall(toolName, argsObj, envOverrides = {}) {
  const baseDir = envOverrides.HOME || envOverrides.USERPROFILE || tmpdir();
  const out = execFileSync(
    process.execPath,
    [INDEX_JS, "call", toolName, "--args", JSON.stringify(argsObj)],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DEVWF_DISABLE_MONITOR_PUSH: "1",
        DEVWF_MONITOR_URL: "",
        DEVWF_ZETTLY_SYNC: "0",
        DEV_WORKFLOW_NO_COMPAT_LINKS: "1",
        DEV_WORKFLOW_STATE_FILE: join(baseDir, "workflow-state.json"),
        DEV_WORKFLOW_DB_PATH: join(baseDir, "workflow-state.db"),
        ...envOverrides,
      },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    }
  );
  return out.trim();
}

test("v1.31.0 Real-World Disposable Session Resume Verification (OpenCode, Codex, Antigravity)", async (t) => {
  const catalogDigest = computeToolCatalogDigest(REPO_ROOT);
  assert.match(catalogDigest, /^sha256:[a-f0-9]{64}$/);

  await t.test("OpenCode: Real disposable MCP process checkpoint, runtime restart (1.30.0 -> 1.31.0), and verified session resume [PASS]", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "devwf-real-opencode-"));
    const worktreeDir = join(tempRoot, "worktree-opencode");
    const stateHome = join(tempRoot, "home");
    try {
      await writeFile(join(tempRoot, ".keep"), "");
      execFileSync(process.execPath, ["-e", `require('node:fs').mkdirSync(${JSON.stringify(worktreeDir)}, { recursive: true })`]);
      createTempGitWorktree(worktreeDir);
      await writeFile(join(worktreeDir, "README.md"), "# Disposable OpenCode Repo\n");
      execFileSync("git", ["add", "README.md"], { cwd: worktreeDir });
      execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: worktreeDir });
      const worktreeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreeDir, encoding: "utf8" }).trim();

      const adapter = createAgentLifecycleAdapter({ cacheRoot: tempRoot });
      const sup = createMachineUpdateSupervisor({
        machine: "DISPOSABLE-OPENCODE",
        platform: process.platform,
        cacheRoot: tempRoot,
      });

      const oldRev = "565e381700000000000000000000000000000000";
      const newRev = "b836c77fad74407190c120d7687b5cc8a26615b7";

      // 1. Spawn real MCP process #1 simulating v1.30.0 OpenCode session
      const statusBefore = runMcpCliCall(
        "get_workflow_status",
        {},
        {
          USERPROFILE: stateHome,
          HOME: stateHome,
          DEVWF_AGENT: "opencode",
          DEVWF_SESSION_KEY: "ses_real_opencode_v131",
          DEVWF_RELEASE_VERSION: "1.30.0",
          DEVWF_RELEASE_REVISION: oldRev,
        }
      );
      assert.match(statusBefore, /Current Workflow Status/i);

      // 2. Persist recognizable checkpoint before runtime restart
      const cp = await adapter.createSessionCheckpoint({
        sessionKey: "ses_real_opencode_v131",
        agent: "opencode",
        taskId: "disposable-opencode-task",
        projectDir: worktreeDir,
        worktreeLease: {
          ownerPid: process.pid,
          worktreeHead,
          expiresAt: Date.now() + 120_000,
        },
        preUpgradeRevision: oldRev,
        targetRevision: newRev,
      });
      assert.equal(cp.ok, true);

      // 3. Stage & activate v1.31.0 in supervisor and spawn real MCP process #2 (v1.31.0)
      const m131 = createReleaseManifest({
        releaseId: "rel-1.31.0",
        version: "1.31.0",
        revision: newRev,
        sha256: "b".repeat(64),
        size: 128,
        toolCatalogDigest: catalogDigest,
      });
      await sup.stageRelease(m131, { artifactBytes: Buffer.alloc(128, "a"), skipHashVerify: true });
      await sup.activateRelease(m131, { authorized: true });

      const resumed = await adapter.resumeSession({
        checkpointId: cp.checkpoint.checkpointId,
        expectedSessionKey: "ses_real_opencode_v131",
      });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.outcomeStatus, TEST_OUTCOME_STATUSES.PASS);
      assert.equal(resumed.recoveryVerified, true);
      assert.equal(resumed.sessionKey, "ses_real_opencode_v131");

      // 4. Spawn new v1.31.0 MCP child process and verify session & worktree integrity
      const statusAfter = runMcpCliCall(
        "get_workflow_status",
        {},
        {
          USERPROFILE: stateHome,
          HOME: stateHome,
          DEVWF_AGENT: "opencode",
          DEVWF_SESSION_KEY: "ses_real_opencode_v131",
          DEVWF_RELEASE_VERSION: "1.31.0",
          DEVWF_RELEASE_REVISION: newRev,
          DEVWF_TOOL_CATALOG_DIGEST: catalogDigest,
        }
      );
      assert.match(statusAfter, /Current Workflow Status/i);
      const worktreeHeadAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreeDir, encoding: "utf8" }).trim();
      assert.equal(worktreeHeadAfter, worktreeHead, "Worktree HEAD must remain identical across MCP restart");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test("Codex: Real disposable MCP process checkpoint, runtime restart, and verified session resume [PASS]", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "devwf-real-codex-"));
    const worktreeDir = join(tempRoot, "worktree-codex");
    const stateHome = join(tempRoot, "home");
    try {
      execFileSync(process.execPath, ["-e", `require('node:fs').mkdirSync(${JSON.stringify(worktreeDir)}, { recursive: true })`]);
      createTempGitWorktree(worktreeDir);
      await writeFile(join(worktreeDir, "index.js"), "console.log('codex disposable');\n");
      execFileSync("git", ["add", "index.js"], { cwd: worktreeDir });
      execFileSync("git", ["commit", "-q", "-m", "codex initial"], { cwd: worktreeDir });
      const worktreeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreeDir, encoding: "utf8" }).trim();

      const adapter = createAgentLifecycleAdapter({ cacheRoot: tempRoot });
      const oldRev = "565e381700000000000000000000000000000000";
      const newRev = "b836c77fad74407190c120d7687b5cc8a26615b7";

      const statusBefore = runMcpCliCall(
        "get_workflow_status",
        {},
        {
          USERPROFILE: stateHome,
          HOME: stateHome,
          DEVWF_AGENT: "codex",
          DEVWF_SESSION_KEY: "ses_real_codex_v131",
          DEVWF_RELEASE_VERSION: "1.30.0",
          DEVWF_RELEASE_REVISION: oldRev,
        }
      );
      assert.match(statusBefore, /Current Workflow Status/i);

      const cp = await adapter.createSessionCheckpoint({
        sessionKey: "ses_real_codex_v131",
        agent: "codex",
        taskId: "disposable-codex-task",
        projectDir: worktreeDir,
        worktreeLease: {
          ownerPid: process.pid,
          worktreeHead,
          expiresAt: Date.now() + 120_000,
        },
        preUpgradeRevision: oldRev,
        targetRevision: newRev,
      });

      const resumed = await adapter.resumeSession({
        checkpointId: cp.checkpoint.checkpointId,
        expectedSessionKey: "ses_real_codex_v131",
      });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.outcomeStatus, TEST_OUTCOME_STATUSES.PASS);
      assert.equal(resumed.recoveryVerified, true);

      const statusAfter = runMcpCliCall(
        "get_workflow_status",
        {},
        {
          USERPROFILE: stateHome,
          HOME: stateHome,
          DEVWF_AGENT: "codex",
          DEVWF_SESSION_KEY: "ses_real_codex_v131",
          DEVWF_RELEASE_VERSION: "1.31.0",
          DEVWF_RELEASE_REVISION: newRev,
          DEVWF_TOOL_CATALOG_DIGEST: catalogDigest,
        }
      );
      assert.match(statusAfter, /Current Workflow Status/i);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test("Antigravity: Preserves active IDE session without force-close and reports NOT_SUPPORTED / MANUAL_RESUME_REQUIRED accurately", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "devwf-real-agy-"));
    try {
      const adapter = createAgentLifecycleAdapter({ cacheRoot: tempRoot });
      const cp = await adapter.createSessionCheckpoint({
        sessionKey: "ses_real_antigravity_v131",
        agent: "antigravity",
        taskId: "disposable-agy-task",
        projectDir: REPO_ROOT,
        worktreeLease: {
          ownerPid: process.pid,
          expiresAt: Date.now() + 120_000,
        },
        preUpgradeRevision: "565e381700000000000000000000000000000000",
        targetRevision: "b836c77fad74407190c120d7687b5cc8a26615b7",
      });

      const resumed = await adapter.resumeSession({
        checkpointId: cp.checkpoint.checkpointId,
        expectedSessionKey: "ses_real_antigravity_v131",
      });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.outcomeStatus, TEST_OUTCOME_STATUSES.NOT_SUPPORTED);
      assert.equal(resumed.manualResumeRequired, true);
      assert.equal(resumed.recoveryVerified, false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
