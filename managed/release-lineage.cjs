'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(REPO_ROOT, '.managed-publish');

function run(cmd, args, opts = {}) {
  const stdio = opts.input == null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];
  return execFileSync(cmd, args, { encoding: 'utf8', stdio, ...opts }).trim();
}

function localManagedRoot() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ProgramingLive', 'ManagedMCP') : path.join(os.homedir(), '.local', 'share', 'ProgramingLive', 'ManagedMCP');
  }
  return path.join(os.homedir(), '.local', 'share', 'ProgramingLive', 'ManagedMCP');
}

// `same` | `forward` | `regression` | `divergent` | `unknown`
function classifyLineage(currentRevision, candidateRevision, isAncestor) {
  if (!currentRevision || !candidateRevision) return 'unknown';
  if (currentRevision === candidateRevision) return 'same';
  const isAncestorFn = typeof isAncestor === 'function' ? isAncestor : () => false;
  const forward = isAncestorFn(currentRevision, candidateRevision);
  if (forward === true) return 'forward';
  const regression = isAncestorFn(candidateRevision, currentRevision);
  if (regression === true) return 'regression';
  if (forward === null || regression === null) return 'unknown';
  return 'divergent';
}

function makeGitIsAncestor(cwd) {
  function objectPresent(revision) {
    try {
      run('git', ['-C', cwd, 'cat-file', '-e', revision], {});
      return true;
    } catch {
      try {
        run('git', ['-C', cwd, 'fetch', '--quiet', 'origin'], {});
        run('git', ['-C', cwd, 'cat-file', '-e', revision], {});
        return true;
      } catch {
        return false;
      }
    }
  }
  return function isAncestor(a, b) {
    if (!objectPresent(a) || !objectPresent(b)) return null;
    try {
      run('git', ['-C', cwd, 'merge-base', '--is-ancestor', a, b], {});
      return true;
    } catch {
      return false;
    }
  };
}

function enforceForwardOnly(manifest, { currentRevision, isAncestor }) {
  const decision = classifyLineage(currentRevision, manifest.revision, isAncestor);
  const short = (rev) => (rev || '').slice(0, 12);
  if (decision === 'regression') {
    throw new Error(
      `Forward-only guard: the release host is at ${short(currentRevision)} and the candidate ` +
      `${short(manifest.revision)} is an ancestor of it. Refusing to rotate the store backwards. ` +
      `Cut the release from a newer revision instead.`,
    );
  }
  if (decision === 'divergent') {
    throw new Error(
      `Forward-only guard: candidate ${short(manifest.revision)} is divergent from the host's ` +
      `current ${short(currentRevision)} (neither is an ancestor of the other). Refusing to rotate. ` +
      `Merge the lineages on main, cut the release from the merged tip, and retry.`,
    );
  }
  if (decision === 'unknown') {
    throw new Error(
      `Forward-only guard: cannot verify the lineage of ${short(manifest.revision)} against ` +
      `${short(currentRevision)} (commit object missing locally). Refusing to rotate; ` +
      `fetch the history first or re-cut the release.`,
    );
  }
  return decision;
}

function readHostCurrentRevision(host, { runImpl } = {}) {
  const runner = runImpl || function (args) {
    return run('ssh', ['-o', 'BatchMode=yes', host.name, args], {});
  };
  let raw = '';
  try {
    raw = runner('sudo -n cat /var/lib/devwf-releases/current.json').trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.revision === 'string' && parsed.revision ? parsed.revision : null;
  } catch {
    return null;
  }
}

function promoteToServers(manifest, deps = {}) {
  const hosts = Array.isArray(deps.hosts) ? deps.hosts : [];
  const reader = deps.readHostCurrentRevision || ((host, d) => readHostCurrentRevision(host, d));
  const runner = deps.runImpl || run;
  const stagingDir = deps.stagingDir || STAGING_DIR;
  const archivePath = path.join(stagingDir, 'releases', `${manifest.sha256}.tar.gz`);
  const manifestPath = path.join(stagingDir, 'current.json');

  for (const host of hosts) {
    const currentRevision = reader(host, deps);
    if (currentRevision) {
      enforceForwardOnly(manifest, {
        currentRevision,
        isAncestor: deps.isAncestor || makeGitIsAncestor(REPO_ROOT),
      });
    }
  }

  for (const host of hosts) {
    runner('scp', ['-o', 'BatchMode=yes', manifestPath, archivePath, `${host.name}:/tmp/`]);
    const oldRevision = reader(host, deps) || '';
    const oldShort = oldRevision.slice(0, 7);
    const installCommands = [
      `sudo mv /tmp/${manifest.sha256}.tar.gz /var/lib/devwf-releases/releases/`,
      `sudo chown devwf-releases:devwf-releases /var/lib/devwf-releases/releases/${manifest.sha256}.tar.gz`,
      `sudo chmod 644 /var/lib/devwf-releases/releases/${manifest.sha256}.tar.gz`,
      `sudo cp /var/lib/devwf-releases/current.json /var/lib/devwf-releases/previous.json 2>/dev/null || true`,
      oldShort ? `sudo cp /var/lib/devwf-releases/current.json /var/lib/devwf-releases/rollback-${oldShort}.json` : 'true',
      `sudo chown -R devwf-releases:devwf-releases /var/lib/devwf-releases/rollback-${oldShort}.json 2>/dev/null || true`,
      `sudo mv /tmp/current.json /var/lib/devwf-releases/current.json`,
      `sudo chown devwf-releases:devwf-releases /var/lib/devwf-releases/current.json`,
      `sudo chmod 644 /var/lib/devwf-releases/current.json`,
    ].join(' && ');
    runner('ssh', ['-o', 'BatchMode=yes', host.name, installCommands]);
  }
}

module.exports = {
  localManagedRoot,
  classifyLineage,
  makeGitIsAncestor,
  enforceForwardOnly,
  readHostCurrentRevision,
  promoteToServers,
};
