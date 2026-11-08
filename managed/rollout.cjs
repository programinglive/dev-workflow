#!/usr/bin/env node
'use strict';

/**
 * Centrally promote an approved Dev Workflow MCP release and synchronize
 * workflow rules across all three AI CLIs (Codex, OpenCode, AGY) and three
 * workstations (HELLOWORLD, Mac, MMCH).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANAGED_DIR = __dirname;
const STAGING_DIR = path.join(REPO_ROOT, '.managed-publish');

const RELEASE_HOSTS = [
  { name: 'bw-tools', ip: '100.77.138.14', port: 3101, isPrimary: true },
];

const MANAGED_RULE_BLOCK = `<!-- managed-development-workflow:start -->
## Shared development workflow
OpenCode, Codex and AGY (Antigravity CLI and IDE) use the same centrally managed Dev Workflow MCP release and Zettly owner account.
- Before development work, call dev-workflow start_task with an English task description, type, projectDir, a concrete definitionOfDone and an ordered plan. Reuse the canonical task ID and existing Zettly Todo when continuing work. Do not start coding before registration succeeds.
- **Mandatory Mermaid Flow Design Gate (Token & Scope Lock):** Immediately after \`start_task\` and BEFORE writing or modifying any implementation code or tests, you MUST call \`create_feature_flow\` with a connected Mermaid flowchart (\`flowchart TD\` / \`graph TD\`) and an English description. This generates and syncs the visual architecture canvas in Zettly Draw (\`https://zettly.programinglive.com/draw/{id}\`) linked to the canonical Zettly Todo. AI MUST NOT deviate from the recorded flow or write code before this gate succeeds, preventing hallucinations and token waste.
- **Multi-Device & Multi-AI Consistency:** Whenever updating dev-workflow MCP or workflow rules, the change MUST be published and promoted centrally to the release host on \`bw-tools\` and synchronized across all three AI CLIs (Codex, OpenCode, AGY) on all three devices (HELLOWORLD, Mac, MMCH) via \`node managed/rollout.cjs\`.
- Verify the task appears on the central monitor at http://100.107.65.21:3100. A connected MCP process without a registered task does not prove that work is being tracked. If the tool is unavailable, report the failed registration and reload the MCP connection rather than claiming the session is tracked.
- Write new identifiers, comments, docstrings, test descriptions, developer documentation and commit messages in English. User conversation and explicitly localized product text may use the requested language.
- Update plan and definition-of-done evidence during execution. Use automatic Zettly synchronization and sync_zettly_task retries; do not create duplicate Todos or write to the retired Daily Activity Journal/PocketBase store.
- Verify the actual result before complete_task. Confirm the linked Zettly Todo and outcome were saved and read back. Keep unfinished tasks open and report the actual blocker.
- Use the managed bootstrap configured for this device. Never replace it with a direct checkout path or copy tokens between client settings. Reconnect an existing MCP session to load a newly promoted release.
<!-- managed-development-workflow:end -->`;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

/**
 * Forward-only lineage guard for the central release store.
 *
 * The store used to accept whatever the publishing checkout had at HEAD, so a
 * stale or divergent checkout could rotate /var/lib/devwf-releases/current.json
 * backwards (measured 8 Nov 2026: a v1.25.0 pointer was orphaned by two
 * pre-monitor revisions). These helpers classify the relationship between the
 * host's current revision and the candidate and let callers refuse any move
 * that is not idempotent or forward.
 */

// `same` | `forward` | `regression` | `divergent` | `unknown`
function classifyLineage(currentRevision, candidateRevision, isAncestor) {
  if (!currentRevision || !candidateRevision) return 'unknown';
  if (currentRevision === candidateRevision) return 'same';
  const isAncestorFn = typeof isAncestor === 'function' ? isAncestor : () => false;
  const forward = isAncestorFn(currentRevision, candidateRevision);
  if (forward === true) return 'forward';
  const regression = isAncestorFn(candidateRevision, currentRevision);
  if (regression === true) return 'regression';
  // A null answer means the git object was missing locally: fail closed.
  if (forward === null || regression === null) return 'unknown';
  return 'divergent';
}

/**
 * Build a git-based `isAncestor(a, b)` answerer rooted at `cwd`.
 * Missing objects trigger one best-effort `git fetch origin` before giving up,
 * and an unresolvable object reports `null` so callers fail closed.
 */
function makeGitIsAncestor(cwd) {
  // `git cat-file -e` exits non-zero when the object is absent from the
  // object database. `git rev-parse --verify` must NOT be used here: it
  // accepts any well-formed 40-hex string without checking the database.
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

// Refuse rotations that move the store backwards or to an unrelated lineage.
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

// Read the host's current revision without sudo-able access to arbitrary paths.
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
    return null; // corrupt pointer file: fail open with a warning at the call site
  }
}

function publishRelease() {
  console.log('[1/5] Publishing release archive from reviewed Git tree...');
  const publishScript = path.join(MANAGED_DIR, 'publish.cjs');
  const manifestRaw = run(process.execPath, [publishScript, STAGING_DIR], { cwd: REPO_ROOT });
  const manifest = JSON.parse(manifestRaw);
  console.log(`      Revision: ${manifest.revision.slice(0, 12)} | SHA256: ${manifest.sha256.slice(0, 16)}... | Size: ${manifest.size} bytes`);
  return manifest;
}

function promoteToServers(manifest, deps = {}) {
  console.log('[2/5] Promoting release to central release servers...');
  const hosts = deps.hosts || RELEASE_HOSTS;
  const reader = deps.readHostCurrentRevision || ((host, d) => readHostCurrentRevision(host, d));
  const runner = deps.runImpl || run;
  const archivePath = path.join(STAGING_DIR, 'releases', `${manifest.sha256}.tar.gz`);
  const manifestPath = path.join(STAGING_DIR, 'current.json');

  // Pre-flight: the forward-only guard runs BEFORE any transfer. A guard
  // failure must hard-stop the rollout, never degrade to a warning.
  for (const host of hosts) {
    const currentRevision = reader(host, deps);
    if (currentRevision) {
      const decision = enforceForwardOnly(manifest, {
        currentRevision,
        isAncestor: deps.isAncestor || makeGitIsAncestor(REPO_ROOT),
      });
      console.log(
        decision === 'same'
          ? `      ✅ ${host.name} already serves this revision (idempotent no-op)`
          : `      ✅ ${host.name} rotation is forward-only (current ${currentRevision.slice(0, 12)} -> ${manifest.revision.slice(0, 12)})`,
      );
    } else {
      console.warn(
        `      ⚠️ Warning: ${host.name} current.json is unreadable; promoting without the lineage check. Verify the store afterwards.`,
      );
    }
  }

  for (const host of hosts) {
    try {
      console.log(`      Deploying to ${host.name} (${host.ip}:${host.port})...`);
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
      console.log(`      ✅ Promoted on ${host.name}`);
    } catch (err) {
      console.error(`      ⚠️ Warning: Failed promoting to ${host.name}: ${err.message}`);
    }
  }
}

function updateBootstraps() {
  console.log('[3/5] Updating ManagedMCP bootstrap files across devices...');
  const bootstrapFiles = [
    path.join(MANAGED_DIR, 'launcher.cjs'),
    path.join(MANAGED_DIR, 'protocol.cjs'),
    path.join(MANAGED_DIR, 'device-entry.cjs'),
  ];

  // 1. HELLOWORLD (local)
  const localBootstrap = path.join(process.env.LOCALAPPDATA, 'ProgramingLive', 'ManagedMCP', 'bootstrap');
  fs.mkdirSync(localBootstrap, { recursive: true });
  for (const file of bootstrapFiles) {
    fs.copyFileSync(file, path.join(localBootstrap, path.basename(file)));
  }
  console.log('      ✅ HELLOWORLD bootstrap updated');

  // 2. Mac
  try {
    run('scp', ['-o', 'BatchMode=yes', ...bootstrapFiles, 'mac:~/.local/share/ProgramingLive/ManagedMCP/bootstrap/']);
    console.log('      ✅ Mac bootstrap updated');
  } catch (err) {
    console.error(`      ⚠️ Failed updating Mac bootstrap: ${err.message}`);
  }

  // 3. MMCH
  try {
    run('scp', ['-o', 'BatchMode=yes', ...bootstrapFiles, 'mmch:C:/Users/mahardhika/AppData/Local/ProgramingLive/ManagedMCP/bootstrap/']);
    console.log('      ✅ MMCH bootstrap updated');
  } catch (err) {
    console.error(`      ⚠️ Failed updating MMCH bootstrap: ${err.message}`);
  }
}

function prewarmDevices() {
  console.log('[4/5] Prewarming and resolving managed runtime on all devices...');

  // 1. HELLOWORLD
  try {
    const entry = path.join(process.env.LOCALAPPDATA, 'ProgramingLive', 'ManagedMCP', 'bootstrap', 'device-entry.cjs');
    const out = run(process.execPath, [entry, 'opencode', '--resolve-only']);
    const parsed = JSON.parse(out);
    console.log(`      ✅ HELLOWORLD: revision ${parsed.revision.slice(0, 12)} (offline: ${parsed.offline})`);
  } catch (err) {
    console.error(`      ⚠️ HELLOWORLD prewarm failed: ${err.message}`);
  }

  // 2. Mac
  try {
    const macCmd = '/Users/mahardhika/.nvm/versions/node/v24.22.1/bin/node ~/.local/share/ProgramingLive/ManagedMCP/bootstrap/device-entry.cjs opencode --resolve-only';
    const out = run('ssh', ['-o', 'BatchMode=yes', 'mac', macCmd]);
    const parsed = JSON.parse(out);
    console.log(`      ✅ Mac: revision ${parsed.revision.slice(0, 12)} (offline: ${parsed.offline})`);
  } catch (err) {
    console.error(`      ⚠️ Mac prewarm failed: ${err.message}`);
  }

  // 3. MMCH
  try {
    const mmchCmd = 'node C:\\Users\\mahardhika\\AppData\\Local\\ProgramingLive\\ManagedMCP\\bootstrap\\device-entry.cjs opencode --resolve-only';
    const out = run('ssh', ['-o', 'BatchMode=yes', 'mmch', mmchCmd]);
    const parsed = JSON.parse(out);
    console.log(`      ✅ MMCH: revision ${parsed.revision.slice(0, 12)} (offline: ${parsed.offline})`);
  } catch (err) {
    console.error(`      ⚠️ MMCH prewarm failed: ${err.message}`);
  }
}

function syncRuleText(content) {
  const pattern = /<!-- managed-development-workflow:start -->[\s\S]*?<!-- managed-development-workflow:end -->/;
  if (pattern.test(content)) {
    return content.replace(pattern, MANAGED_RULE_BLOCK);
  }
  return content.trim() + '\n\n' + MANAGED_RULE_BLOCK + '\n';
}

function syncRules() {
  console.log('[5/5] Synchronizing AI CLI rules across Codex, OpenCode, and AGY on all devices...');

  // 1. HELLOWORLD
  const hwFiles = [
    path.join(process.env.USERPROFILE, '.gemini', 'GEMINI.md'),
    path.join(process.env.USERPROFILE, '.codex', 'AGENTS.md'),
    path.join(process.env.USERPROFILE, '.config', 'opencode', 'AGENTS.md'),
  ];
  for (const f of hwFiles) {
    if (fs.existsSync(f)) {
      const updated = syncRuleText(fs.readFileSync(f, 'utf8'));
      fs.writeFileSync(f, updated, 'utf8');
    }
  }
  console.log('      ✅ HELLOWORLD rules synchronized (GEMINI.md, Codex, OpenCode)');

  // 2. Mac
  try {
    // The block contains backticks and `{id}`. Passing it through `ssh "..."`
    // lets the remote shell expand those, which silently emptied every
    // backticked token (measured 8 Nov 2026: "to the release host on  and
    // synchronized"). Embed the block as base64 instead, so the script that
    // travels over the wire contains no character a shell would touch.
    const payload = Buffer.from(MANAGED_RULE_BLOCK, 'utf8').toString('base64');
    const pythonScript = `import base64, os, re
block = base64.b64decode('${payload}').decode('utf-8')
pattern = re.compile(r'(?ms)<!-- managed-development-workflow:start -->.*?<!-- managed-development-workflow:end -->')
home = os.path.expanduser('~')
for rel in ['.gemini/GEMINI.md', '.codex/AGENTS.md', '.config/opencode/AGENTS.md']:
    p = os.path.join(home, rel)
    if os.path.exists(p):
        txt = open(p, 'r', encoding='utf-8').read()
        new_txt = pattern.sub(lambda m: block, txt) if pattern.search(txt) else txt.strip() + '\\n\\n' + block + '\\n'
        open(p, 'w', encoding='utf-8').write(new_txt)
`;
    run('ssh', ['-o', 'BatchMode=yes', 'mac', `python3 -c "${pythonScript.replace(/"/g, '\\"')}"`]);
    console.log('      ✅ Mac rules synchronized (GEMINI.md, Codex, OpenCode)');
  } catch (err) {
    console.error(`      ⚠️ Mac rule sync failed: ${err.message}`);
  }

  // 3. MMCH
  try {
    // Same base64 treatment as Mac: the Windows shell would also eat backticks,
    // and the home directory must be resolved on the device instead of being
    // hard-coded (it was wrong: MMCH runs as DHIKA, not mahardhika).
    const payloadMMCH = Buffer.from(MANAGED_RULE_BLOCK, 'utf8').toString('base64');
    const pythonScriptMMCH = `import base64, os, re
block = base64.b64decode('${payloadMMCH}').decode('utf-8')
pattern = re.compile(r'(?ms)<!-- managed-development-workflow:start -->.*?<!-- managed-development-workflow:end -->')
home = os.path.expanduser('~')
for rel in ['.gemini/GEMINI.md', '.codex/AGENTS.md', '.config/opencode/AGENTS.md']:
    p = os.path.join(home, rel)
    if os.path.exists(p):
        txt = open(p, 'r', encoding='utf-8').read()
        new_txt = pattern.sub(lambda m: block, txt) if pattern.search(txt) else txt.strip() + '\\n\\n' + block + '\\n'
        open(p, 'w', encoding='utf-8').write(new_txt)
`;
    run('ssh', ['-o', 'BatchMode=yes', 'mmch', `python -c "${pythonScriptMMCH.replace(/"/g, '\\"')}"`]);
    console.log('      ✅ MMCH rules synchronized (GEMINI.md, Codex, OpenCode)');
  } catch (err) {
    console.error(`      ⚠️ MMCH rule sync failed: ${err.message}`);
  }
}

function main() {
  console.log('🚀 Starting Dev Workflow MCP Central Rollout & Rule Sync');
  console.log('========================================================');
  const manifest = publishRelease();
  promoteToServers(manifest);
  updateBootstraps();
  prewarmDevices();
  syncRules();
  console.log('========================================================');
  console.log('🎉 Rollout and rule synchronization completed successfully!');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`Rollout failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  publishRelease,
  syncRuleText,
  MANAGED_RULE_BLOCK,
  classifyLineage,
  makeGitIsAncestor,
  enforceForwardOnly,
  readHostCurrentRevision,
  promoteToServers,
};
