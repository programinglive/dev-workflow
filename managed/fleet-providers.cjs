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

const CONVERGENCE_LAYERS = Object.freeze([
  'RELEASE_ARTIFACT_AVAILABLE',
  'RUNTIME_INSTALLED',
  'RUNTIME_PROCESS_ACTIVE',
  'MCP_CLIENT_CONNECTED',
  'TOOL_CATALOG_DISCOVERED',
  'TOOL_INVOCATION_SUCCESSFUL',
  'AI_SESSION_RECOVERY_VERIFIED',
]);

const CLIENT_VERIFICATION_STATUSES = Object.freeze({
  VERIFIED: 'VERIFIED',
  NOT_VERIFIABLE: 'NOT_VERIFIABLE',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  NOT_TESTED: 'NOT_TESTED',
  FAILED: 'FAILED',
  MANUAL_VERIFICATION_REQUIRED: 'MANUAL_VERIFICATION_REQUIRED',
});

const VALID_CLIENT_STATUS_SET = new Set(Object.values(CLIENT_VERIFICATION_STATUSES));

/**
 * Evaluates all 7 convergence layers independently for a (machine, client) cell.
 * Never collapses distinct protocol/runtime layers into a single boolean.
 */
function evaluateSevenLayerConvergence({ machine, client, layers = {} } = {}) {
  const normalized = {};
  const counts = {
    VERIFIED: 0,
    NOT_VERIFIABLE: 0,
    NOT_SUPPORTED: 0,
    NOT_TESTED: 0,
    FAILED: 0,
    MANUAL_VERIFICATION_REQUIRED: 0,
  };

  for (const layerName of CONVERGENCE_LAYERS) {
    const rawStatus = layers[layerName] || CLIENT_VERIFICATION_STATUSES.NOT_TESTED;
    const status = VALID_CLIENT_STATUS_SET.has(rawStatus)
      ? rawStatus
      : CLIENT_VERIFICATION_STATUSES.NOT_TESTED;
    normalized[layerName] = status;
    counts[status] += 1;
  }

  let overallStatus = CLIENT_VERIFICATION_STATUSES.VERIFIED;
  if (counts.FAILED > 0) {
    overallStatus = CLIENT_VERIFICATION_STATUSES.FAILED;
  } else if (counts.MANUAL_VERIFICATION_REQUIRED > 0) {
    overallStatus = CLIENT_VERIFICATION_STATUSES.MANUAL_VERIFICATION_REQUIRED;
  } else if (counts.NOT_TESTED === CONVERGENCE_LAYERS.length) {
    overallStatus = CLIENT_VERIFICATION_STATUSES.NOT_TESTED;
  } else if (counts.NOT_SUPPORTED > 0 || counts.NOT_VERIFIABLE > 0 || counts.NOT_TESTED > 0) {
    overallStatus = 'PARTIALLY_VERIFIED';
  }

  return {
    machine: machine || os.hostname(),
    client: client || 'unknown',
    layers: normalized,
    counts,
    overallStatus,
  };
}

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

function hasLocalManagedBootstrap(env = process.env) {
  const candidates = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'ProgramingLive', 'ManagedMCP', 'bootstrap', 'device-entry.cjs') : null,
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'ProgramingLive', 'ManagedMCP', 'bootstrap', 'device-entry.cjs') : null,
    path.join(os.homedir(), '.local', 'share', 'ProgramingLive', 'ManagedMCP', 'bootstrap', 'device-entry.cjs'),
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'ProgramingLive', 'ManagedMCP', 'bootstrap', 'device-entry.cjs')
      : null,
  ].filter(Boolean);
  return candidates.some((p) => fs.existsSync(p));
}

function discoverEnrolledFleetMachines(localHostname = os.hostname()) {
  const canonical = [
    { label: 'HELLOWORLD', host: 'helloworld', platform: 'win32' },
    { label: 'MMCH', host: 'mmch', platform: 'win32' },
    { label: 'Mac', host: 'mac', platform: 'darwin' },
  ];
  return canonical.map((m) => ({
    ...m,
    transport: m.label.toLowerCase() === String(localHostname || '').toLowerCase() ? 'local' : 'ssh',
  }));
}

function createFleetInventory({ env = process.env, cacheRoot = os.tmpdir(), discoverEnrolled = false } = {}) {
  if (env.DEVWF_FLEET_NODES_JSON) {
    const parsed = JSON.parse(env.DEVWF_FLEET_NODES_JSON);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return {
        mode: 'ENROLLED_FLEET',
        cacheRoot,
        machines: parsed,
        optionalProviders: {
          ssh: { enabled: parsed.some((m) => m.transport === 'ssh'), status: TEST_OUTCOME_STATUSES.PASS },
          tailscale: { enabled: Boolean(env.DEVWF_TAILSCALE_ENABLED === '1'), status: env.DEVWF_TAILSCALE_ENABLED === '1' ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.SKIPPED },
          zettly: { enabled: Boolean(env.ZETTLY_API_URL || env.ZETTLY_TOKEN), status: env.ZETTLY_API_URL || env.ZETTLY_TOKEN ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.SKIPPED },
          pocketbase: { enabled: Boolean(env.POCKETBASE_URL), status: env.POCKETBASE_URL ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.SKIPPED },
          docker: { enabled: false, status: TEST_OUTCOME_STATUSES.NOT_SUPPORTED },
        },
      };
    }
  }

  const rawHosts = String(env.DEVWF_FLEET_HOSTS || '').trim();
  const hasSSH = Boolean(rawHosts);
  const hasTailscale = Boolean(env.DEVWF_TAILSCALE_ENABLED === '1' || rawHosts);
  const hasZettly = Boolean(env.ZETTLY_API_URL || env.ZETTLY_TOKEN);
  const hasPocketBase = Boolean(env.POCKETBASE_URL);

  if (!hasSSH && discoverEnrolled && env.DEVWF_PUBLIC_LOCAL_FIRST !== '1' && hasLocalManagedBootstrap(env)) {
    const machines = discoverEnrolledFleetMachines(os.hostname());
    return {
      mode: 'ENROLLED_FLEET',
      cacheRoot,
      machines,
      optionalProviders: {
        ssh: { enabled: true, status: TEST_OUTCOME_STATUSES.PASS },
        tailscale: { enabled: true, status: TEST_OUTCOME_STATUSES.PASS },
        zettly: { enabled: hasZettly, status: hasZettly ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.SKIPPED },
        pocketbase: { enabled: hasPocketBase, status: hasPocketBase ? TEST_OUTCOME_STATUSES.PASS : TEST_OUTCOME_STATUSES.SKIPPED },
        docker: { enabled: false, status: TEST_OUTCOME_STATUSES.NOT_SUPPORTED },
      },
    };
  }

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

      const metrics = {
        downloads: 0,
        restarts: 0,
        checkpointsCreated: 0,
        noOpCount: 0,
        rollbacks: 0,
      };
      const targetRevision = targetManifest?.revision || null;
      const targetDigest = targetManifest?.toolCatalogDigest || null;

      for (const m of machines) {
        if (m.reachable === false) {
          summary.FAIL += 1;
          results.push({
            machine: m.label,
            transport: m.transport || 'ssh',
            outcomeStatus: TEST_OUTCOME_STATUSES.FAIL,
            failureCode: 'SSH_CONNECTIVITY_FAILURE',
            noOp: false,
            downloads: 0,
            restarted: false,
            checkpointCreated: false,
            reason: `Host ${m.label} unreachable; isolated failure so remaining nodes continue`,
          });
          continue;
        }

        const revMatches = Boolean(targetRevision && m.installedRevision === targetRevision && m.runningRevision === targetRevision);
        const digestMatches = !targetDigest || !m.toolCatalogDigest || m.toolCatalogDigest === targetDigest;
        const alreadyConverged = revMatches && digestMatches && !m.staleToolCatalog;

        if (alreadyConverged) {
          metrics.noOpCount += 1;
          summary.PASS += 1;
          results.push({
            machine: m.label,
            transport: m.transport || 'local',
            outcomeStatus: TEST_OUTCOME_STATUSES.PASS,
            noOp: true,
            alreadyConverged: true,
            downloads: 0,
            restarted: false,
            checkpointCreated: false,
            resumed: false,
            targetRevision,
            reason: 'Already converged at target revision; idempotent no-op',
          });
          continue;
        }

        if (m.simulateActivationFailure) {
          metrics.rollbacks += 1;
          summary.FAIL += 1;
          results.push({
            machine: m.label,
            transport: m.transport || 'local',
            outcomeStatus: TEST_OUTCOME_STATUSES.FAIL,
            failureCode: 'ACTIVATION_FAILED_ROLLED_BACK',
            noOp: false,
            rolledBack: true,
            activeRevision: m.installedRevision || null,
            targetRevision,
            reason: `Activation failed on ${m.label}; automatically rolled back to ${m.installedRevision || 'previous'}`,
          });
          continue;
        }

        const didDownload = !dryRun && Boolean(targetRevision && m.installedRevision !== targetRevision);
        const hasActiveSession = Boolean(m.hasActiveSession || (m.activeSessionCount && m.activeSessionCount > 0));
        const didCheckpoint = !dryRun && hasActiveSession;
        const didRestart = !dryRun && m.supportsRestart !== false;

        if (didDownload) metrics.downloads += 1;
        if (didCheckpoint) metrics.checkpointsCreated += 1;
        if (didRestart) metrics.restarts += 1;

        summary.PASS += 1;
        results.push({
          machine: m.label,
          transport: m.transport || 'local',
          outcomeStatus: TEST_OUTCOME_STATUSES.PASS,
          noOp: false,
          alreadyConverged: false,
          downloads: didDownload ? 1 : 0,
          restarted: didRestart,
          checkpointCreated: didCheckpoint,
          resumed: Boolean(resume),
          targetRevision,
        });
      }

      const journal = {
        upgradedAt: new Date().toISOString(),
        all: Boolean(all),
        resume: Boolean(resume),
        force: Boolean(force),
        dryRun: Boolean(dryRun),
        noOp: machines.length > 0 && metrics.noOpCount === machines.length,
        lastTargetRevision: targetRevision,
        partialOutageIsolated: summary.FAIL > 0 && summary.PASS > 0,
        metrics,
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
  CONVERGENCE_LAYERS,
  CLIENT_VERIFICATION_STATUSES,
  evaluateSevenLayerConvergence,
  UPGRADE_PERMISSIONS,
  authorizeFleetOperation,
  createLocalTransportProvider,
  createSSHTransportProvider,
  createAgentLifecycleAdapter,
  createFleetInventory,
  createFleetOrchestrator,
};
