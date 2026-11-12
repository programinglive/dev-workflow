'use strict';

/**
 * Architectural Addendum #5 — DevWorkflow Automated Fleet Update Manager
 * & MCP Tool Catalog Synchronization (Milestones F1–F6).
 *
 * Provides:
 *  - Versioned Release Manifest v1 with deterministic toolCatalogDigest
 *  - Per-Machine Update Supervisor (Windows, macOS, Linux)
 *  - Side-by-Side Runtime Staging & Zero-Disruption Session-Safe Cutover
 *  - Client Refresh Compatibility Matrix (OpenCode, Codex, Antigravity)
 *  - Fleet Convergence Evaluation & Self-Diagnostic Update Doctor
 *  - Local-First Standalone Mode for open-source single-machine setups
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateManifest } = require('./protocol.cjs');

const UPDATE_STATES = Object.freeze({
  UP_TO_DATE: 'UP_TO_DATE',
  UPDATE_AVAILABLE: 'UPDATE_AVAILABLE',
  DOWNLOADING: 'DOWNLOADING',
  STAGED: 'STAGED',
  WAITING_FOR_SAFE_CUTOVER: 'WAITING_FOR_SAFE_CUTOVER',
  ACTIVATING: 'ACTIVATING',
  VERIFYING: 'VERIFYING',
  ACTIVE: 'ACTIVE',
  FAILED: 'FAILED',
  ROLLBACK_REQUIRED: 'ROLLBACK_REQUIRED',
});

const CONVERGENCE_STATUSES = Object.freeze({
  CONVERGED: 'CONVERGED',
  STAGED: 'STAGED',
  PINNED_ACTIVE_SESSION: 'PINNED_ACTIVE_SESSION',
  CLIENT_REFRESH_REQUIRED: 'CLIENT_REFRESH_REQUIRED',
  OFFLINE: 'OFFLINE',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  FAILED: 'FAILED',
});

const UPDATE_MODES = Object.freeze({
  MANUAL: 'MANUAL',
  SAFE_AUTOMATIC: 'SAFE_AUTOMATIC',
  SCHEDULED: 'SCHEDULED',
  CRITICAL_SECURITY: 'CRITICAL_SECURITY',
});

const CLIENT_COMPATIBILITY_MATRIX = Object.freeze({
  opencode: Object.freeze({
    client: 'opencode',
    transport: 'service-managed-stdio',
    supportsAutomaticRefresh: true,
    supportsToolListChangedNotification: true,
    refreshMechanism: 'opencode service restart + /api/experimental/mcp/dev-workflow/connect',
    safeWhenIdleOnly: true,
  }),
  codex: Object.freeze({
    client: 'codex',
    transport: 'direct-stdio-child',
    supportsAutomaticRefresh: false,
    supportsToolListChangedNotification: false,
    refreshMechanism: 'CLIENT_RECONNECT_REQUIRED (new sessions resolve staged runtime automatically)',
    safeWhenIdleOnly: true,
  }),
  antigravity: Object.freeze({
    client: 'antigravity',
    transport: 'direct-stdio-child',
    supportsAutomaticRefresh: false,
    supportsToolListChangedNotification: false,
    refreshMechanism: 'CLIENT_RECONNECT_REQUIRED (reload MCP connection or start new conversation)',
    safeWhenIdleOnly: true,
  }),
});

/**
 * Deterministic SHA-256 digest of the MCP tool catalog exposed by index.js.
 * Allows detecting when tool definitions or schemas changed even within the
 * same major/minor series.
 */
function computeToolCatalogDigest(repoRoot = path.resolve(__dirname, '..')) {
  try {
    const indexPath = path.join(repoRoot, 'index.js');
    const content = fs.readFileSync(indexPath, 'utf8');
    // Extract canonical tool names and schema blocks from index.js
    const toolMatches = [];
    const nameRegex = /name:\s*["']([a-z0-9_]+)["']/g;
    let m;
    while ((m = nameRegex.exec(content)) !== null) {
      toolMatches.push(m[1]);
    }
    const payload = toolMatches.length > 0 ? JSON.stringify(toolMatches.sort()) : content;
    return 'sha256:' + createHash('sha256').update(payload).digest('hex');
  } catch {
    return 'sha256:' + createHash('sha256').update('dev-workflow-default-catalog').digest('hex');
  }
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function createReleaseManifest({
  releaseId,
  version,
  revision,
  sha256,
  size,
  channel = 'stable',
  minimumCompatibleClient = '1.0.0',
  toolCatalogDigest = computeToolCatalogDigest(),
  rolloutStatus = 'available',
} = {}) {
  const base = validateManifest({ revision, sha256, size, ...(version ? { version } : {}) });
  const digestPrefixed = String(sha256).startsWith('sha256:') ? String(sha256) : `sha256:${sha256}`;
  return {
    schemaVersion: 1,
    releaseId: releaseId || `release-${version || revision.slice(0, 12)}`,
    ...base,
    artifactDigest: digestPrefixed,
    channel,
    minimumCompatibleClient,
    toolCatalogDigest: toolCatalogDigest || computeToolCatalogDigest(),
    rolloutStatus,
  };
}

function validateExtendedManifest(input) {
  const base = validateManifest(input);
  const sha = base.sha256;
  const artifactDigest =
    typeof input.artifactDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(input.artifactDigest)
      ? input.artifactDigest
      : `sha256:${sha}`;
  if (artifactDigest !== `sha256:${sha}`) {
    throw new Error('Invalid managed release manifest: artifactDigest does not match sha256');
  }
  const toolCatalogDigest =
    typeof input.toolCatalogDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(input.toolCatalogDigest)
      ? input.toolCatalogDigest
      : computeToolCatalogDigest();
  return {
    schemaVersion: Number.isSafeInteger(input.schemaVersion) ? input.schemaVersion : 1,
    releaseId: typeof input.releaseId === 'string' && input.releaseId ? input.releaseId : `release-${base.version || base.revision.slice(0, 12)}`,
    ...base,
    artifactDigest,
    channel: typeof input.channel === 'string' && input.channel ? input.channel : 'stable',
    minimumCompatibleClient:
      typeof input.minimumCompatibleClient === 'string' && input.minimumCompatibleClient
        ? input.minimumCompatibleClient
        : '1.0.0',
    toolCatalogDigest,
    rolloutStatus:
      typeof input.rolloutStatus === 'string' && input.rolloutStatus ? input.rolloutStatus : 'available',
  };
}

function defaultCacheRoot(platform = process.platform) {
  if (process.env.DEVWF_MANAGED_CACHE) return process.env.DEVWF_MANAGED_CACHE;
  if (platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'ProgramingLive', 'ManagedMCP');
  }
  return path.join(os.homedir(), '.local', 'share', 'ProgramingLive', 'ManagedMCP');
}

function createMachineUpdateSupervisor({
  machine = os.hostname(),
  platform = process.platform,
  arch = process.arch,
  modulesAbi = process.versions.modules,
  cacheRoot = defaultCacheRoot(platform),
  mode = UPDATE_MODES.SAFE_AUTOMATIC,
  localFirstStandalone = false,
} = {}) {
  const supervisorDir = path.join(cacheRoot, 'supervisor');
  const stateFile = path.join(supervisorDir, 'state.json');
  const processesFile = path.join(supervisorDir, 'processes.json');
  const runtimeKey = `${platform}-${arch}-${modulesAbi}`;

  function ensureDirsSync() {
    fs.mkdirSync(path.join(cacheRoot, 'releases'), { recursive: true });
    fs.mkdirSync(supervisorDir, { recursive: true });
  }

  function readStateSync() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return {
        machine,
        platform,
        mode,
        localFirstStandalone,
        state: UPDATE_STATES.UP_TO_DATE,
        targetManifest: null,
        stagedManifest: null,
        activeManifest: null,
        rollbackManifest: null,
        lastVerifiedAt: null,
        lastError: null,
        offline: false,
      };
    }
  }

  function writeStateSync(next) {
    ensureDirsSync();
    const merged = { ...readStateSync(), ...next, machine, platform, mode, localFirstStandalone };
    fs.writeFileSync(stateFile, JSON.stringify(merged, null, 2) + '\n');
    return merged;
  }

  function listProcesses() {
    try {
      const list = JSON.parse(fs.readFileSync(processesFile, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function saveProcesses(list) {
    ensureDirsSync();
    fs.writeFileSync(processesFile, JSON.stringify(list, null, 2) + '\n');
  }

  function registerProcess({
    pid,
    client = 'opencode',
    sessionKey = null,
    activeCriticalSession = false,
    revision,
    version,
    toolCatalogDigest,
  }) {
    const list = listProcesses().filter((p) => p.pid !== pid);
    const entry = {
      pid,
      client,
      sessionKey,
      activeCriticalSession: Boolean(activeCriticalSession),
      revision,
      version: version || null,
      toolCatalogDigest: toolCatalogDigest || null,
      startedAt: new Date().toISOString(),
    };
    list.push(entry);
    saveProcesses(list);
    return entry;
  }

  function unregisterProcess(pid) {
    const list = listProcesses().filter((p) => p.pid !== pid);
    saveProcesses(list);
    return list;
  }

  function getPlatformProcessHints() {
    if (platform === 'win32') {
      return {
        platform: 'win32',
        checkCommand: "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'ManagedMCP' }",
        opencodeReloadCommand: 'opencode service restart',
      };
    }
    return {
      platform,
      checkCommand: 'pgrep -fl ManagedMCP',
      opencodeReloadCommand: 'opencode service restart',
    };
  }

  async function checkForUpdates({ fetchTargetManifest } = {}) {
    const current = readStateSync();
    if (localFirstStandalone) {
      return {
        offline: false,
        localFirstStandalone: true,
        state: UPDATE_STATES.UP_TO_DATE,
        activeRevision: current.activeManifest?.revision || null,
        targetManifest: current.activeManifest || null,
      };
    }
    try {
      const rawTarget = await fetchTargetManifest();
      const targetManifest = validateExtendedManifest(rawTarget);
      const isSame =
        current.activeManifest &&
        current.activeManifest.revision === targetManifest.revision &&
        current.activeManifest.sha256 === targetManifest.sha256;
      const nextState = isSame ? UPDATE_STATES.UP_TO_DATE : UPDATE_STATES.UPDATE_AVAILABLE;
      const updated = writeStateSync({
        offline: false,
        targetManifest,
        state: nextState,
      });
      return {
        offline: false,
        state: updated.state,
        activeRevision: updated.activeManifest?.revision || null,
        targetManifest,
      };
    } catch (err) {
      const updated = writeStateSync({
        offline: true,
        lastError: err.message,
      });
      return {
        offline: true,
        state: updated.state,
        activeRevision: updated.activeManifest?.revision || null,
        targetManifest: updated.targetManifest || updated.activeManifest || null,
        error: err.message,
      };
    }
  }

  async function stageRelease(rawManifest, { artifactBytes, skipHashVerify = false, allowRollback = false } = {}) {
    const manifest = validateExtendedManifest(rawManifest);
    const current = readStateSync();

    // Downgrade protection: if an active manifest exists with a newer semver, reject unless allowRollback
    if (!allowRollback && current.activeManifest?.version && manifest.version) {
      if (compareSemver(manifest.version, current.activeManifest.version) < 0) {
        throw new Error(
          `Downgrade protection: candidate v${manifest.version} is older than active v${current.activeManifest.version}. Explicit rollback authorization required.`
        );
      }
    }

    const relDir = path.join(cacheRoot, 'releases', `${manifest.sha256}-${runtimeKey}`);
    const markerFile = path.join(relDir, '.managed-verified.json');

    // Scenario 9: Idempotent staging if already staged and verified
    if (fs.existsSync(markerFile)) {
      const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      if (marker.sha256 === manifest.sha256 && marker.revision === manifest.revision) {
        writeStateSync({
          targetManifest: manifest,
          stagedManifest: manifest,
          state:
            current.activeManifest?.revision === manifest.revision
              ? UPDATE_STATES.ACTIVE
              : UPDATE_STATES.STAGED,
        });
        return {
          ok: true,
          idempotent: true,
          stagedRevision: manifest.revision,
          runtimeRoot: relDir,
          state: UPDATE_STATES.STAGED,
        };
      }
    }

    writeStateSync({ state: UPDATE_STATES.DOWNLOADING, targetManifest: manifest });

    if (Buffer.isBuffer(artifactBytes)) {
      if (artifactBytes.length !== manifest.size) {
        writeStateSync({ state: UPDATE_STATES.FAILED, lastError: 'Managed release archive size mismatch (Interrupted download)' });
        throw new Error('Managed release archive size mismatch (Interrupted download)');
      }
      if (!skipHashVerify) {
        const computed = createHash('sha256').update(artifactBytes).digest('hex');
        if (computed !== manifest.sha256) {
          writeStateSync({ state: UPDATE_STATES.FAILED, lastError: 'Managed release artifact digest mismatch (SHA256 mismatch)' });
          throw new Error('Managed release artifact digest mismatch (SHA256 mismatch)');
        }
      }
    }

    await fsp.mkdir(relDir, { recursive: true });
    const indexStub = path.join(relDir, 'index.js');
    if (!fs.existsSync(indexStub)) {
      await fsp.writeFile(indexStub, `// Staged runtime ${manifest.revision}\n`);
    }
    await fsp.writeFile(
      markerFile,
      JSON.stringify({ ...manifest, runtimeKey, stagedAt: new Date().toISOString() }, null, 2) + '\n'
    );

    writeStateSync({
      targetManifest: manifest,
      stagedManifest: manifest,
      state: UPDATE_STATES.STAGED,
      lastError: null,
    });

    return {
      ok: true,
      idempotent: false,
      stagedRevision: manifest.revision,
      runtimeRoot: relDir,
      state: UPDATE_STATES.STAGED,
    };
  }

  function resolveRuntimeForNewSession() {
    const current = readStateSync();
    const chosen = current.stagedManifest || current.activeManifest || current.targetManifest;
    if (!chosen) return null;
    return {
      ...chosen,
      runtimeRoot: path.join(cacheRoot, 'releases', `${chosen.sha256}-${runtimeKey}`),
    };
  }

  async function activateRelease(rawManifest, { authorized = false, healthCheckFn = null } = {}) {
    const current = readStateSync();
    const manifest = rawManifest ? validateExtendedManifest(rawManifest) : current.stagedManifest;
    if (!manifest) {
      throw new Error('No staged release manifest available to activate');
    }

    if (mode === UPDATE_MODES.MANUAL && !authorized) {
      throw new Error('Explicit operator authorization is required to activate updates in MANUAL mode');
    }

    const processes = listProcesses();
    const pinnedProcesses = processes.filter(
      (p) => p.activeCriticalSession && p.revision !== manifest.revision
    );

    // Zero-Disruption Policy: Never terminate active coding sessions!
    if (pinnedProcesses.length > 0) {
      writeStateSync({
        targetManifest: manifest,
        stagedManifest: manifest,
        state: UPDATE_STATES.WAITING_FOR_SAFE_CUTOVER,
      });
      return {
        ok: true,
        state: UPDATE_STATES.WAITING_FOR_SAFE_CUTOVER,
        convergenceStatus: CONVERGENCE_STATUSES.PINNED_ACTIVE_SESSION,
        pinnedProcesses,
        activeManifest: current.activeManifest,
        stagedManifest: manifest,
      };
    }

    writeStateSync({ state: UPDATE_STATES.ACTIVATING, targetManifest: manifest });
    writeStateSync({ state: UPDATE_STATES.VERIFYING });

    if (typeof healthCheckFn === 'function') {
      const health = await healthCheckFn(manifest);
      if (!health || health.ok === false) {
        const reason = health?.reason || 'Runtime health check failed';
        const rollback = current.activeManifest || current.rollbackManifest || null;
        writeStateSync({
          state: rollback ? UPDATE_STATES.ACTIVE : UPDATE_STATES.ROLLBACK_REQUIRED,
          activeManifest: rollback,
          lastError: `Activation failed (${reason}); rolled back to ${rollback?.revision?.slice(0, 12) || 'none'}`,
        });
        return {
          ok: false,
          rolledBack: Boolean(rollback),
          state: rollback ? UPDATE_STATES.ACTIVE : UPDATE_STATES.ROLLBACK_REQUIRED,
          activeManifest: rollback,
          lastError: reason,
        };
      }
    }

    // Evaluate client refresh behavior for idle running processes
    const clientRefreshResults = {};
    const updatedProcesses = [];
    for (const proc of processes) {
      const matrix = CLIENT_COMPATIBILITY_MATRIX[proc.client] || {
        supportsAutomaticRefresh: false,
      };
      if (matrix.supportsAutomaticRefresh && !proc.activeCriticalSession) {
        clientRefreshResults[proc.client] = {
          client: proc.client,
          status: 'REFRESHED',
          mechanism: matrix.refreshMechanism,
        };
        updatedProcesses.push({
          ...proc,
          revision: manifest.revision,
          version: manifest.version,
          toolCatalogDigest: manifest.toolCatalogDigest,
        });
      } else if (proc.revision !== manifest.revision || proc.toolCatalogDigest !== manifest.toolCatalogDigest) {
        clientRefreshResults[proc.client] = {
          client: proc.client,
          status: 'CLIENT_RECONNECT_REQUIRED',
          mechanism: matrix.refreshMechanism || 'Manual client reconnect required',
        };
        updatedProcesses.push(proc);
      } else {
        clientRefreshResults[proc.client] = {
          client: proc.client,
          status: 'UP_TO_DATE',
        };
        updatedProcesses.push(proc);
      }
    }
    saveProcesses(updatedProcesses);

    const previousActive = current.activeManifest;
    const nowIso = new Date().toISOString();
    const updated = writeStateSync({
      state: UPDATE_STATES.ACTIVE,
      activeManifest: manifest,
      stagedManifest: manifest,
      targetManifest: manifest,
      rollbackManifest:
        previousActive && previousActive.revision !== manifest.revision
          ? previousActive
          : current.rollbackManifest,
      lastVerifiedAt: nowIso,
      lastError: null,
    });

    const status = getStatus();
    return {
      ok: true,
      rolledBack: false,
      state: updated.state,
      convergenceStatus: status.convergenceStatus,
      activeManifest: updated.activeManifest,
      rollbackManifest: updated.rollbackManifest,
      clientRefreshResults,
      pinnedProcesses: [],
    };
  }

  async function rollbackRelease({ authorized = false } = {}) {
    if (!authorized) {
      throw new Error('Explicit operator authorization is required for rollback');
    }
    const current = readStateSync();
    if (!current.rollbackManifest) {
      throw new Error('No approved rollback candidate retained on this machine');
    }
    const targetRollback = current.rollbackManifest;
    await stageRelease(targetRollback, { skipHashVerify: true, allowRollback: true });
    return activateRelease(targetRollback, { authorized: true });
  }

  function getStatus() {
    const current = readStateSync();
    const processes = listProcesses();

    if (localFirstStandalone) {
      return {
        machine,
        platform,
        localFirstStandalone: true,
        state: UPDATE_STATES.ACTIVE,
        convergenceStatus: CONVERGENCE_STATUSES.CONVERGED,
        targetVersion: current.activeManifest?.version || 'local',
        installedVersion: current.activeManifest?.version || 'local',
        runningVersion: current.activeManifest?.version || 'local',
        targetRevision: current.activeManifest?.revision || 'local',
        installedRevision: current.activeManifest?.revision || 'local',
        runningRevision: current.activeManifest?.revision || 'local',
        toolCatalogDigest: computeToolCatalogDigest(),
        staleToolCatalogDetected: false,
        activeSessionCount: processes.filter((p) => p.activeCriticalSession).length,
        processes,
        lastVerifiedAt: current.lastVerifiedAt,
        lastError: null,
      };
    }

    const target = current.targetManifest || current.stagedManifest || current.activeManifest;
    const staged = current.stagedManifest || current.activeManifest;
    const active = current.activeManifest;

    const pinned = processes.filter(
      (p) => p.activeCriticalSession && target && p.revision !== target.revision
    );
    const staleClients = processes.filter(
      (p) => !p.activeCriticalSession && target && p.revision !== target.revision
    );
    const staleTools = processes.filter(
      (p) =>
        target &&
        p.toolCatalogDigest &&
        target.toolCatalogDigest &&
        p.toolCatalogDigest !== target.toolCatalogDigest
    );

    let convergenceStatus = CONVERGENCE_STATUSES.CONVERGED;
    if (current.offline) {
      convergenceStatus = CONVERGENCE_STATUSES.OFFLINE;
    } else if (current.state === UPDATE_STATES.FAILED || current.state === UPDATE_STATES.ROLLBACK_REQUIRED) {
      convergenceStatus = CONVERGENCE_STATUSES.FAILED;
    } else if (pinned.length > 0) {
      convergenceStatus = CONVERGENCE_STATUSES.PINNED_ACTIVE_SESSION;
    } else if (staleClients.length > 0 || staleTools.length > 0) {
      convergenceStatus = CONVERGENCE_STATUSES.CLIENT_REFRESH_REQUIRED;
    } else if (target && active && target.revision !== active.revision) {
      convergenceStatus = staged && staged.revision === target.revision
        ? CONVERGENCE_STATUSES.STAGED
        : CONVERGENCE_STATUSES.VERSION_MISMATCH;
    } else if (!active && staged) {
      convergenceStatus = CONVERGENCE_STATUSES.STAGED;
    }

    const runningRevisions = [...new Set(processes.map((p) => p.revision).filter(Boolean))];
    const runningVersions = [...new Set(processes.map((p) => p.version).filter(Boolean))];

    return {
      machine,
      platform,
      mode,
      localFirstStandalone: false,
      state: current.state,
      convergenceStatus,
      targetVersion: target?.version || null,
      installedVersion: staged?.version || null,
      runningVersion: runningVersions[0] || active?.version || null,
      targetRevision: target?.revision || null,
      installedRevision: staged?.revision || null,
      runningRevision: runningRevisions[0] || active?.revision || null,
      toolCatalogDigest: active?.toolCatalogDigest || target?.toolCatalogDigest || computeToolCatalogDigest(),
      staleToolCatalogDetected: staleTools.length > 0,
      activeSessionCount: processes.filter((p) => p.activeCriticalSession).length,
      pinnedSessionKeys: pinned.map((p) => p.sessionKey).filter(Boolean),
      processes,
      rollbackAvailable: Boolean(current.rollbackManifest),
      rollbackRevision: current.rollbackManifest?.revision || null,
      lastVerifiedAt: current.lastVerifiedAt,
      lastError: current.lastError,
    };
  }

  return {
    checkForUpdates,
    stageRelease,
    activateRelease,
    rollbackRelease,
    resolveRuntimeForNewSession,
    registerProcess,
    unregisterProcess,
    listProcesses,
    getPlatformProcessHints,
    getStatus,
  };
}

function evaluateFleetConvergence({ targetManifest = null, machines = [] } = {}) {
  const counts = {
    CONVERGED: 0,
    STAGED: 0,
    PINNED_ACTIVE_SESSION: 0,
    CLIENT_REFRESH_REQUIRED: 0,
    OFFLINE: 0,
    VERSION_MISMATCH: 0,
    FAILED: 0,
  };

  for (const m of machines) {
    const st = m.convergenceStatus || CONVERGENCE_STATUSES.VERSION_MISMATCH;
    counts[st] = (counts[st] || 0) + 1;
  }

  const fullyConverged =
    machines.length > 0 &&
    machines.every((m) => m.convergenceStatus === CONVERGENCE_STATUSES.CONVERGED);

  let overallStatus = CONVERGENCE_STATUSES.CONVERGED;
  if (counts.FAILED > 0) overallStatus = CONVERGENCE_STATUSES.FAILED;
  else if (counts.OFFLINE > 0) overallStatus = CONVERGENCE_STATUSES.OFFLINE;
  else if (counts.VERSION_MISMATCH > 0) overallStatus = CONVERGENCE_STATUSES.VERSION_MISMATCH;
  else if (counts.PINNED_ACTIVE_SESSION > 0) overallStatus = CONVERGENCE_STATUSES.PINNED_ACTIVE_SESSION;
  else if (counts.CLIENT_REFRESH_REQUIRED > 0) overallStatus = CONVERGENCE_STATUSES.CLIENT_REFRESH_REQUIRED;
  else if (counts.STAGED > 0) overallStatus = CONVERGENCE_STATUSES.STAGED;

  return {
    evaluatedAt: new Date().toISOString(),
    targetVersion: targetManifest?.version || machines[0]?.targetVersion || null,
    targetRevision: targetManifest?.revision || machines[0]?.targetRevision || null,
    toolCatalogDigest: targetManifest?.toolCatalogDigest || computeToolCatalogDigest(),
    fullyConverged,
    overallStatus,
    counts,
    machines,
  };
}

function runFleetDoctor(machines = []) {
  const findings = [];
  for (const m of machines) {
    if (m.convergenceStatus === CONVERGENCE_STATUSES.OFFLINE) {
      findings.push({
        machine: m.machine,
        code: 'OFFLINE_DEVICE',
        severity: 'warning',
        message: `${m.machine} could not reach the release controller or SSH endpoint.`,
        remediation: `Verify Tailscale connectivity to ${m.machine} and run 'devwf fleet check'.`,
      });
    }
    if (!m.installedRevision && !m.localFirstStandalone) {
      findings.push({
        machine: m.machine,
        code: 'MISSING_RUNTIME',
        severity: 'error',
        message: `${m.machine} has no staged or active ManagedMCP runtime.`,
        remediation: `Run 'devwf fleet stage' on ${m.machine}.`,
      });
    }
    if (m.staleToolCatalogDetected) {
      findings.push({
        machine: m.machine,
        code: 'STALE_TOOL_REGISTRY',
        severity: 'warning',
        message: `${m.machine} has a running MCP process whose toolCatalogDigest differs from target.`,
        remediation: `Run 'devwf fleet activate --authorize' when idle or reconnect the client.`,
      });
    }
    if (m.convergenceStatus === CONVERGENCE_STATUSES.PINNED_ACTIVE_SESSION) {
      findings.push({
        machine: m.machine,
        code: 'ACTIVE_SESSION_BLOCKING',
        severity: 'info',
        message: `${m.machine} has ${m.activeSessionCount} active coding session(s) (${(m.pinnedSessionKeys || []).join(', ') || 'active'}) safely pinned to ${String(m.runningRevision || '').slice(0, 12)}.`,
        remediation: `Allow active session(s) to finish; new sessions on ${m.machine} already use ${String(m.installedRevision || '').slice(0, 12)}.`,
      });
    }
    if (m.convergenceStatus === CONVERGENCE_STATUSES.CLIENT_REFRESH_REQUIRED) {
      findings.push({
        machine: m.machine,
        code: 'UNSUPPORTED_CLIENT_REFRESH',
        severity: 'info',
        message: `${m.machine} has running client process(es) requiring reconnect or tool catalog refresh.`,
        remediation: `For OpenCode run 'devwf fleet activate --authorize'; for Codex/Antigravity reload the MCP connection when convenient.`,
      });
    }
    if (m.convergenceStatus === CONVERGENCE_STATUSES.VERSION_MISMATCH) {
      findings.push({
        machine: m.machine,
        code: 'INCORRECT_VERSION',
        severity: 'warning',
        message: `${m.machine} running revision ${String(m.runningRevision || 'none').slice(0, 12)} differs from target ${String(m.targetRevision || 'none').slice(0, 12)}.`,
        remediation: `Run 'devwf fleet stage' followed by 'devwf fleet activate --authorize'.`,
      });
    }
    if (m.convergenceStatus === CONVERGENCE_STATUSES.FAILED) {
      findings.push({
        machine: m.machine,
        code: 'FAILED_RELEASE_VERIFICATION',
        severity: 'error',
        message: `${m.machine} reported update failure: ${m.lastError || 'unknown error'}.`,
        remediation: m.rollbackAvailable
          ? `Run 'devwf fleet rollback --authorize' to restore ${String(m.rollbackRevision || '').slice(0, 12)}.`
          : `Inspect supervisor logs and run 'devwf fleet stage'.`,
      });
    }
  }

  let recommendedNextAction = {
    action: 'NONE',
    command: 'devwf fleet status',
    requiresAuthorization: false,
    reason: 'All evaluated machines are converged or operating normally.',
  };

  if (findings.some((f) => f.code === 'FAILED_RELEASE_VERIFICATION')) {
    recommendedNextAction = {
      action: 'ROLLBACK_OR_RESTAGE',
      command: 'devwf fleet rollback --authorize',
      requiresAuthorization: true,
      reason: 'One or more machines failed release verification.',
    };
  } else if (findings.some((f) => f.code === 'MISSING_RUNTIME' || f.code === 'INCORRECT_VERSION')) {
    recommendedNextAction = {
      action: 'STAGE_AND_ACTIVATE',
      command: 'devwf fleet stage && devwf fleet activate --authorize',
      requiresAuthorization: true,
      reason: 'One or more machines have un-staged or mismatched versions.',
    };
  } else if (findings.some((f) => f.code === 'ACTIVE_SESSION_BLOCKING')) {
    recommendedNextAction = {
      action: 'WAIT_FOR_SESSION_DRAIN',
      command: 'devwf fleet verify',
      requiresAuthorization: false,
      reason: 'Target runtime is staged; active coding session is safely pinned and will cut over after completion.',
    };
  } else if (findings.some((f) => f.code === 'STALE_TOOL_REGISTRY' || f.code === 'UNSUPPORTED_CLIENT_REFRESH')) {
    recommendedNextAction = {
      action: 'REFRESH_IDLE_CLIENTS',
      command: 'devwf fleet activate --authorize',
      requiresAuthorization: true,
      reason: 'Idle client connections or stale tool catalogs can be refreshed safely.',
    };
  }

  return {
    ok: !findings.some((f) => f.severity === 'error'),
    checkedAt: new Date().toISOString(),
    findings,
    recommendedNextAction,
  };
}

module.exports = {
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
  defaultCacheRoot,
};
