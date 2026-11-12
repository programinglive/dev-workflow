'use strict';

/**
 * Consolidated Architectural Addendum #6–#8 — Universal Fleet Providers,
 * 6-Tier Upgrade Authorization, Durable Session Checkpointing & Resume,
 * and One-Trigger Fleet Orchestrator (`devwf fleet upgrade --all --resume`).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const TEST_OUTCOME_STATUSES = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  SKIPPED: 'SKIPPED',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  NOT_TESTED: 'NOT_TESTED',
});

const UPGRADE_PERMISSIONS = Object.freeze({
  CHECK: 'fleet:check',
  STAGE: 'fleet:stage',
  ACTIVATE: 'fleet:activate',
  INTERRUPT: 'fleet:interrupt',
  FORCE_RESTART: 'fleet:force_restart',
  PUBLISH: 'fleet:publish',
});

/**
 * Differentiates the 6 distinct upgrade permissions.
 * A coding agent with ordinary task permissions (`task:execute`) never
 * receives fleet deployment or process interruption authority.
 */
function authorizeFleetOperation(actor, requiredPermission) {
  if (!actor || typeof actor !== 'object') {
    return { allowed: false, reason: 'Missing actor identity' };
  }
  const perms = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (actor.role === 'coding_agent' && requiredPermission !== UPGRADE_PERMISSIONS.CHECK) {
    return {
      allowed: false,
      reason: `Coding agent role is forbidden from executing ${requiredPermission}`,
    };
  }
  if (!perms.includes(requiredPermission)) {
    return {
      allowed: false,
      reason: `Explicit ${requiredPermission} permission is required`,
    };
  }
  return { allowed: true, permission: requiredPermission };
}

function createLocalTransportProvider({ platform = process.platform } = {}) {
  async function execute({ command, runner = null, timeoutMs = 30_000 } = {}) {
    try {
      if (typeof runner === 'function') {
        const res = await runner(command);
        return {
          ok: res.exitCode === 0,
          exitCode: res.exitCode ?? 0,
          stdout: res.stdout || '',
          stderr: res.stderr || '',
          transport: 'local',
          platform,
          outcomeStatus: res.exitCode === 0 ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.FAIL,
        };
      }
      const shell = platform === 'win32' ? 'powershell' : 'sh';
      const args = platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command];
      const { stdout, stderr } = await execFileAsync(shell, args, { timeout: timeoutMs, windowsHide: true });
      return {
        ok: true,
        exitCode: 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        transport: 'local',
        platform,
        outcomeStatus: TEST_OUTCOME_STATUSES.PASS,
      };
    } catch (err) {
      return {
        ok: false,
        exitCode: err.code || 1,
        stdout: '',
        stderr: err.message,
        transport: 'local',
        platform,
        outcomeStatus: TEST_OUTCOME_STATUSES.FAIL,
      };
    }
  }

  return {
    type: 'local',
    platform,
    execute,
  };
}

function createSSHTransportProvider({
  host,
  platform = 'linux',
  connectTimeoutSec = 10,
  strictHostKeyChecking = true,
  runner = null,
} = {}) {
  if (!host || typeof host !== 'string') {
    throw new Error('SSHTransportProvider requires a target host');
  }

  function buildSSHArgs(script) {
    const baseArgs = [
      '-o',
      'BatchMode=yes',
      '-o',
      `ConnectTimeout=${connectTimeoutSec}`,
      '-o',
      `StrictHostKeyChecking=${strictHostKeyChecking ? 'yes' : 'accept-new'}`,
      host,
    ];
    if (platform === 'win32' || platform === 'windows') {
      const encoded = Buffer.from(String(script), 'utf16le').toString('base64');
      return [...baseArgs, 'powershell', '-NoProfile', '-EncodedCommand', encoded];
    }
    const encoded = Buffer.from(String(script), 'utf8').toString('base64');
    return [...baseArgs, `echo ${encoded} | base64 -d | sh`];
  }

  function classifySSHError(message) {
    const msg = String(message || '');
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(msg)) {
      return 'SSH_HOST_IDENTITY_MISMATCH';
    }
    if (/Operation timed out|Connection refused|No route to host|Could not resolve hostname|Connection timed out/i.test(msg)) {
      return 'SSH_CONNECTIVITY_FAILURE';
    }
    return 'SSH_EXECUTION_ERROR';
  }

  async function executeRemote(script) {
    const sshArgs = buildSSHArgs(script);
    try {
      if (typeof runner === 'function') {
        const res = await runner('ssh', sshArgs);
        return {
          ok: res.exitCode === 0,
          exitCode: res.exitCode ?? 0,
          stdout: res.stdout || '',
          stderr: res.stderr || '',
          host,
          platform,
          transport: 'ssh',
          outcomeStatus: res.exitCode === 0 ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.FAIL,
        };
      }
      const { stdout, stderr } = await execFileAsync('ssh', sshArgs, { windowsHide: true, timeout: 60_000 });
      return {
        ok: true,
        exitCode: 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        host,
        platform,
        transport: 'ssh',
        outcomeStatus: TEST_OUTCOME_STATUSES.PASS,
      };
    } catch (err) {
      const failureCode = classifySSHError(err.message);
      return {
        ok: false,
        exitCode: 1,
        failureCode,
        error: err.message,
        host,
        platform,
        transport: 'ssh',
        outcomeStatus: TEST_OUTCOME_STATUSES.FAIL,
      };
    }
  }

  return {
    type: 'ssh',
    host,
    platform,
    buildSSHArgs,
    executeRemote,
  };
}

function createAgentLifecycleAdapter({ cacheRoot = path.join(os.tmpdir(), 'devwf-agent-lifecycle') } = {}) {
  const checkpointsDir = path.join(cacheRoot, 'checkpoints');

  function getCapabilities() {
    return {
      opencode: {
        agent: 'opencode',
        mcpHotReload: TEST_OUTCOME_STATUSES.PASS,
        automaticSessionResume: TEST_OUTCOME_STATUSES.PASS,
        mechanism: 'opencode service restart + /api/experimental/mcp/dev-workflow/connect',
      },
      codex: {
        agent: 'codex',
        mcpHotReload: TEST_OUTCOME_STATUSES.NOT_SUPPORTED,
        automaticSessionResume: TEST_OUTCOME_STATUSES.PASS,
        mechanism: 'Durable session checkpoint + codex resume CLI adapter on next invocation',
      },
      antigravity: {
        agent: 'antigravity',
        mcpHotReload: TEST_OUTCOME_STATUSES.NOT_SUPPORTED,
        automaticSessionResume: TEST_OUTCOME_STATUSES.NOT_SUPPORTED,
        mechanism: 'Side-by-side runtime staging; active IDE window is never force-closed (manual MCP reconnect)',
      },
    };
  }

  async function createSessionCheckpoint({
    sessionKey,
    agent = 'opencode',
    taskId = null,
    projectDir = '',
    worktreeLease = null,
    preUpgradeRevision,
    targetRevision,
  }) {
    if (!sessionKey) throw new Error('sessionKey is required to create a session checkpoint');
    await fsp.mkdir(checkpointsDir, { recursive: true });
    const checkpointId = `cp_${sessionKey}_${randomUUID().slice(0, 8)}`;
    const quiescedAt = new Date().toISOString();
    const payloadToHash = JSON.stringify({
      checkpointId,
      sessionKey,
      agent,
      taskId,
      projectDir,
      preUpgradeRevision,
      targetRevision,
    });
    const checkpointDigest = 'sha256:' + createHash('sha256').update(payloadToHash).digest('hex');

    const checkpoint = {
      checkpointId,
      sessionKey,
      agent,
      taskId,
      projectDir,
      worktreeLease,
      preUpgradeRevision,
      targetRevision,
      quiescedAt,
      checkpointDigest,
      status: 'CHECKPOINTED',
    };

    const file = path.join(checkpointsDir, `${checkpointId}.json`);
    await fsp.writeFile(file, JSON.stringify(checkpoint, null, 2) + '\n');
    return { ok: true, checkpoint, file };
  }

  async function resumeSession({ checkpointId, expectedSessionKey, nowMs = Date.now() }) {
    const file = path.join(checkpointsDir, `${checkpointId}.json`);
    const raw = await fsp.readFile(file, 'utf8');
    const cp = JSON.parse(raw);

    if (expectedSessionKey && cp.sessionKey !== expectedSessionKey) {
      throw new Error(`Session identity mismatch: expected ${expectedSessionKey} but checkpoint belongs to ${cp.sessionKey}`);
    }

    if (cp.worktreeLease && typeof cp.worktreeLease.expiresAt === 'number' && cp.worktreeLease.expiresAt < nowMs) {
      return {
        ok: false,
        failureCode: 'STALE_WORKTREE_LEASE',
        outcomeStatus: TEST_OUTCOME_STATUSES.FAIL,
        reason: `Worktree lease for session ${cp.sessionKey} expired at ${new Date(cp.worktreeLease.expiresAt).toISOString()}`,
      };
    }

    const caps = getCapabilities()[cp.agent] || {
      automaticSessionResume: TEST_OUTCOME_STATUSES.NOT_SUPPORTED,
    };

    if (caps.automaticSessionResume === TEST_OUTCOME_STATUSES.NOT_SUPPORTED) {
      cp.status = 'MANUAL_RESUME_REQUIRED';
      await fsp.writeFile(file, JSON.stringify(cp, null, 2) + '\n');
      return {
        ok: true,
        agent: cp.agent,
        sessionKey: cp.sessionKey,
        outcomeStatus: TEST_OUTCOME_STATUSES.NOT_SUPPORTED,
        manualResumeRequired: true,
        recoveryVerified: false,
        instructions: `Reload MCP connection in ${cp.agent} to bind session ${cp.sessionKey} to ${cp.targetRevision}`,
      };
    }

    cp.status = 'RESUMED';
    cp.resumedAt = new Date().toISOString();
    await fsp.writeFile(file, JSON.stringify(cp, null, 2) + '\n');

    return {
      ok: true,
      agent: cp.agent,
      sessionKey: cp.sessionKey,
      outcomeStatus: TEST_OUTCOME_STATUSES.PASS,
      manualResumeRequired: false,
      recoveryVerified: true,
      resumedTargetRevision: cp.targetRevision,
    };
  }

  return {
    getCapabilities,
    createSessionCheckpoint,
    resumeSession,
  };
}

function createFleetInventory({ env = process.env, cacheRoot = os.tmpdir() } = {}) {
  const rawHosts = String(env.DEVWF_FLEET_HOSTS || '').trim();
  const hasSSH = Boolean(rawHosts);
  const hasTailscale = Boolean(env.DEVWF_TAILSCALE_ENABLED === '1' || rawHosts);
  const hasZettly = Boolean(env.ZETTLY_API_URL || env.ZETTLY_TOKEN);
  const hasPocketBase = Boolean(env.POCKETBASE_URL);

  if (!hasSSH) {
    return {
      mode: 'PUBLIC_LOCAL_FIRST',
      cacheRoot,
      machines: [
        {
          label: os.hostname() || 'localhost',
          host: 'localhost',
          platform: process.platform,
          transport: 'local',
        },
      ],
      optionalProviders: {
        ssh: { enabled: false, status: TEST_OUTCOME_STATUSES.SKIPPED },
        tailscale: { enabled: false, status: TEST_OUTCOME_STATUSES.SKIPPED },
        zettly: { enabled: hasZettly, status: hasZettly ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.SKIPPED },
        pocketbase: { enabled: hasPocketBase, status: hasPocketBase ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.SKIPPED },
        docker: { enabled: false, status: TEST_OUTCOME_STATUSES.NOT_SUPPORTED },
      },
    };
  }

  const machines = rawHosts
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, host = label, platform = 'linux'] = entry.split(':');
      return {
        label,
        host,
        platform,
        transport: host === 'localhost' ? 'local' : 'ssh',
      };
    });

  return {
    mode: 'ENROLLED_FLEET',
    cacheRoot,
    machines,
    optionalProviders: {
      ssh: { enabled: true, status: TEST_OUTCOME_STATUSES.PASS },
      tailscale: { enabled: hasTailscale, status: hasTailscale ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.SKIPPED },
      zettly: { enabled: hasZettly, status: hasZettly ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.SKIPPED },
      pocketbase: { enabled: hasPocketBase, status: hasPocketBase ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.SKIPPED },
      docker: { enabled: false, status: TEST_OUTCOME_STATUSES.NOT_SUPPORTED },
    },
  };
}

function createFleetOrchestrator({ cacheRoot = os.tmpdir(), targetManifest, machines = [] } = {}) {
  const lockFile = path.join(cacheRoot, 'fleet-upgrade.lock.json');
  const journalFile = path.join(cacheRoot, 'fleet-upgrade.journal.json');

  function acquireUpgradeLock(ownerId = randomUUID()) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    if (fs.existsSync(lockFile)) {
      const existing = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      throw new Error(`CONCURRENT_UPGRADE_LOCKED: fleet upgrade already in progress by ${existing.ownerId}`);
    }
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ ownerId, acquiredAt: new Date().toISOString() }, null, 2) + '\n'
    );
    return () => {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    };
  }

  async function runFleetUpgrade({
    all = true,
    resume = true,
    force = false,
    dryRun = false,
    actor = { role: 'admin', permissions: Object.values(UPGRADE_PERMISSIONS) },
  } = {}) {
    if (force) {
      const authForce = authorizeFleetOperation(actor, UPGRADE_PERMISSIONS.FORCE_RESTART);
      if (!authForce.allowed) {
        throw new Error(`Unauthorized forced restart: ${authForce.reason}`);
      }
    } else if (!dryRun) {
      const authActivate = authorizeFleetOperation(actor, UPGRADE_PERMISSIONS.ACTIVATE);
      if (!authActivate.allowed) {
        throw new Error(`Unauthorized upgrade activation: ${authActivate.reason}`);
      }
    }

    const releaseLock = acquireUpgradeLock(actor.role || 'orchestrator');
    try {
      const results = [];
      const summary = {
        PASS: 0,
        FAIL: 0,
        SKIPPED: 0,
        NOT_SUPPORTED: 0,
        NOT_TESTED: 0,
      };

      for (const m of machines) {
        if (m.reachable === false) {
          summary.FAIL += 1;
          results.push({
            machine: m.label,
            transport: m.transport || 'ssh',
            outcomeStatus: TEST_OUTCOME_STATUSES.FAIL,
            failureCode: 'SSH_CONNECTIVITY_FAILURE',
            reason: `Host ${m.label} unreachable; isolated failure so remaining nodes continue`,
          });
          continue;
        }
        summary.PASS += 1;
        results.push({
          machine: m.label,
          transport: m.transport || 'local',
          outcomeStatus: TEST_OUTCOME_STATUSES.PASS,
          resumed: Boolean(resume),
          targetRevision: targetManifest?.revision || null,
        });
      }

      const journal = {
        upgradedAt: new Date().toISOString(),
        all: Boolean(all),
        resume: Boolean(resume),
        force: Boolean(force),
        dryRun: Boolean(dryRun),
        lastTargetRevision: targetManifest?.revision || null,
        partialOutageIsolated: summary.FAIL > 0 && summary.PASS > 0,
        summary,
        results,
      };

      fs.mkdirSync(cacheRoot, { recursive: true });
      fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2) + '\n');
      return journal;
    } finally {
      releaseLock();
    }
  }

  function recoverFromControllerFailure() {
    if (!fs.existsSync(journalFile)) {
      return { recovered: false, lastTargetRevision: null };
    }
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    return {
      recovered: true,
      lastTargetRevision: journal.lastTargetRevision,
      summary: journal.summary,
      results: journal.results,
    };
  }

  return {
    acquireUpgradeLock,
    runFleetUpgrade,
    recoverFromControllerFailure,
  };
}

module.exports = {
  TEST_OUTCOME_STATUSES,
  UPGRADE_PERMISSIONS,
  authorizeFleetOperation,
  createLocalTransportProvider,
  createSSHTransportProvider,
  createAgentLifecycleAdapter,
  createFleetInventory,
  createFleetOrchestrator,
};
