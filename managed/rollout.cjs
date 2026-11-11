#!/usr/bin/env node
'use strict';

/**
 * Centrally promote an approved Dev Workflow MCP release and synchronize
 * workflow rules across all three AI CLIs (Codex, OpenCode, AGY) and three
 * workstations (HELLOWORLD, Mac, MMCH).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANAGED_DIR = __dirname;
const STAGING_DIR = path.join(REPO_ROOT, '.managed-publish');

/**
 * The ManagedMCP root on THIS device, whatever the platform.
 *
 * The rollout was written on Windows and read `process.env.LOCALAPPDATA`
 * directly. Run from the Mac, that value is undefined, so `path.join` threw
 * "The path argument must be of type string" and the whole rollout died after
 * the release had already been promoted. Every device runs this script, so the
 * location has to be discovered rather than assumed.
 */
function localManagedRoot() {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ProgramingLive', 'ManagedMCP') : null,
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'ProgramingLive', 'ManagedMCP') : null,
    path.join(os.homedir(), '.local', 'share', 'ProgramingLive', 'ManagedMCP'),
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'ProgramingLive', 'ManagedMCP')
      : null,
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(dir)) || null;
}

// The device this script is running on. It used to be hard-coded as
// HELLOWORLD, which made the log lie when the rollout ran from another machine.
const LOCAL_LABEL = os.hostname();

/**
 * All three fleet workstations.
 *
 * The rollout used to hard-code `mac` and `mmch` as the remote SSH targets
 * because it was originally run only from HELLOWORLD. When run from the Mac,
 * `ssh mac` failed to resolve and HELLOWORLD was skipped altogether.
 */
const FLEET_DEVICES = [
  {
    label: 'HELLOWORLD',
    host: 'helloworld',
    matchHost: (h) => /helloworld/i.test(h),
    scpBootstrapDest: 'helloworld:C:/Users/DHIKA/AppData/Local/ProgramingLive/ManagedMCP/bootstrap/',
    prewarmCmd: 'node C:\\Users\\DHIKA\\AppData\\Local\\ProgramingLive\\ManagedMCP\\bootstrap\\device-entry.cjs opencode --resolve-only',
    python: 'python',
  },
  {
    label: 'Mac',
    host: 'mac',
    matchHost: (h) => /mac/i.test(h),
    scpBootstrapDest: 'mac:~/.local/share/ProgramingLive/ManagedMCP/bootstrap/',
    prewarmCmd: '/Users/mahardhika/.nvm/versions/node/v24.22.1/bin/node ~/.local/share/ProgramingLive/ManagedMCP/bootstrap/device-entry.cjs opencode --resolve-only',
    python: 'python3',
  },
  {
    label: 'MMCH',
    host: 'mmch',
    matchHost: (h) => /mmch/i.test(h),
    scpBootstrapDest: 'mmch:C:/Users/mahardhika/AppData/Local/ProgramingLive/ManagedMCP/bootstrap/',
    prewarmCmd: 'node C:\\Users\\mahardhika\\AppData\\Local\\ProgramingLive\\ManagedMCP\\bootstrap\\device-entry.cjs opencode --resolve-only',
    python: 'python',
  },
];

function remoteTargets(hostname = LOCAL_LABEL) {
  const hostStr = String(hostname || '');
  return FLEET_DEVICES.filter((d) => !d.matchHost(hostStr));
}

const RELEASE_HOSTS = [
  { name: 'bw-tools', ip: '100.77.138.14', port: 3101, isPrimary: true },
];

const MANAGED_RULE_BLOCK = `<!-- managed-development-workflow:start -->
## Shared development workflow
OpenCode, Codex and AGY (Antigravity CLI and IDE) use the same centrally managed Dev Workflow MCP release and Zettly owner account.
- Before development work, call dev-workflow start_task with an English task description, type, projectDir, a concrete definitionOfDone and an ordered plan. Reuse the canonical task ID and existing Zettly Todo when continuing work. Do not start coding before registration succeeds.
- **Mandatory Mermaid Flow Design Gate (Token & Scope Lock):** Immediately after \`start_task\` and BEFORE writing or modifying any implementation code or tests, you MUST call \`create_feature_flow\` with a connected Mermaid flowchart (\`flowchart TD\` / \`graph TD\`) and an English description. This generates and syncs the visual architecture canvas in Zettly Draw (\`https://zettly.programinglive.com/draw/{id}\`) linked to the canonical Zettly Todo. AI MUST NOT deviate from the recorded flow or write code before this gate succeeds, preventing hallucinations and token waste.
- **AI task refinement:** After \`start_task\` and \`create_feature_flow\`, call \`refine_with_ai\` with the canonical task ID, new findings, and a complete AI-rewritten description, plan and definition of done. Re-run it when new evidence arrives; preserve previous context and proven items in the same task and Todo.
- **Multi-Device & Multi-AI Consistency:** Whenever updating dev-workflow MCP or workflow rules, the change MUST be published and promoted centrally to the release host on \`bw-tools\` and synchronized across all three AI CLIs (Codex, OpenCode, AGY) on all three devices (HELLOWORLD, Mac, MMCH) via \`node managed/rollout.cjs\`.
- **Restarting the MCP on all devices:** run \`node managed/restart-devices.cjs\`. It kills the ManagedMCP process tree on HELLOWORLD, Mac and MMCH in one command; reopen the AI CLI on each device afterwards so the launcher resolves the promoted release. Never restart one device by hand and leave the others on an old release.
- **Centralized Build & CI/CD Runner on bw-tools:** All builds, tests, package artifacts, and CI/CD pipelines run on the universal self-hosted Linux runner on \`bw-tools\` (\`100.77.138.14\`, \`[self-hosted, linux, bw-tools]\`). The MMCH Windows runner has been fully decommissioned. AI agents must NEVER target or configure MMCH for build or CI runner tasks.
- Verify the task appears on the central monitor at http://100.77.138.14:3100. A connected MCP process without a registered task does not prove that work is being tracked. If the tool is unavailable, report the failed registration and reload the MCP connection rather than claiming the session is tracked.
- Write new identifiers, comments, docstrings, test descriptions, developer documentation and commit messages in English. User conversation and explicitly localized product text may use the requested language.
- Update plan and definition-of-done evidence during execution. Use automatic Zettly synchronization and sync_zettly_task retries; do not create duplicate Todos or write to the retired Daily Activity Journal/PocketBase store.
- Verify the actual result before complete_task. Confirm the linked Zettly Todo and outcome were saved and read back. Keep unfinished tasks open and report the actual blocker.
- Use the managed bootstrap configured for this device. Never replace it with a direct checkout path or copy tokens between client settings. Reconnect an existing MCP session to load a newly promoted release.
<!-- managed-development-workflow:end -->`;

function run(cmd, args, opts = {}) {
  // `input` is only delivered when stdin is a pipe. The old default of 'ignore'
  // silently dropped the rule-sync script, so `python -` read an empty stdin and
  // the ssh call sat there until the rollout timed out.
  const stdio = opts.input == null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];
  return execFileSync(cmd, args, { encoding: 'utf8', stdio, ...opts }).trim();
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

  // 1. This device
  const localRoot = localManagedRoot();
  if (localRoot) {
    const localBootstrap = path.join(localRoot, 'bootstrap');
    fs.mkdirSync(localBootstrap, { recursive: true });
    for (const file of bootstrapFiles) {
      fs.copyFileSync(file, path.join(localBootstrap, path.basename(file)));
    }
    console.log(`      ✅ ${LOCAL_LABEL} bootstrap updated`);
  } else {
    console.error(`      ⚠️ ${LOCAL_LABEL} has no ManagedMCP directory; bootstrap update skipped`);
  }

  // 2. Remote fleet workstations
  for (const device of remoteTargets()) {
    try {
      run('scp', ['-o', 'BatchMode=yes', ...bootstrapFiles, device.scpBootstrapDest]);
      console.log(`      ✅ ${device.label} bootstrap updated`);
    } catch (err) {
      console.error(`      ⚠️ Failed updating ${device.label} bootstrap: ${err.message}`);
    }
  }
}

function prewarmDevices() {
  console.log('[4/5] Prewarming and resolving managed runtime on all devices...');

  // 1. This device
  const localRoot = localManagedRoot();
  if (!localRoot) {
    console.error(`      ⚠️ ${LOCAL_LABEL} prewarm skipped: no ManagedMCP directory`);
  } else {
    try {
      const entry = path.join(localRoot, 'bootstrap', 'device-entry.cjs');
      const out = run(process.execPath, [entry, 'opencode', '--resolve-only']);
      const parsed = JSON.parse(out);
      console.log(`      ✅ ${LOCAL_LABEL}: revision ${parsed.revision.slice(0, 12)} (offline: ${parsed.offline})`);
    } catch (err) {
      console.error(`      ⚠️ ${LOCAL_LABEL} prewarm failed: ${err.message}`);
    }
  }

  // 2. Remote fleet workstations
  for (const device of remoteTargets()) {
    try {
      const out = run('ssh', ['-o', 'BatchMode=yes', device.host, device.prewarmCmd]);
      const parsed = JSON.parse(out);
      console.log(`      ✅ ${device.label}: revision ${parsed.revision.slice(0, 12)} (offline: ${parsed.offline})`);
    } catch (err) {
      console.error(`      ⚠️ ${device.label} prewarm failed: ${err.message}`);
    }
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

  // 1. This device
  const home = os.homedir();
  const hwFiles = [
    path.join(home, '.gemini', 'GEMINI.md'),
    path.join(home, '.codex', 'AGENTS.md'),
    path.join(home, '.config', 'opencode', 'AGENTS.md'),
  ];
  let localChanged = 0;
  let localPresent = 0;
  for (const f of hwFiles) {
    if (!fs.existsSync(f)) continue;
    localPresent += 1;
    const before = fs.readFileSync(f, 'utf8');
    const updated = syncRuleText(before);
    if (updated === before) continue;
    fs.writeFileSync(f, updated, 'utf8');
    localChanged += 1;
  }
  // Report what actually changed, not just that the device was visited: a
  // silent "synchronized" hid a stale rule block on MMCH for a whole day.
  console.log(`      ✅ ${LOCAL_LABEL} rules synchronized (${localChanged} changed of ${localPresent}/3 files)`);

  // 2. Remote fleet workstations
  for (const device of remoteTargets()) {
    try {
      syncRulesOnDevice({ host: device.host, python: device.python, label: device.label });
    } catch (err) {
      console.error(`      ⚠️ ${device.label} rule sync failed: ${err.message}`);
    }
  }
}

/**
 * Rewrite the rule block in every AI CLI file on one device.
 *
 * TWO BUGS THIS REPLACES (measured 8 November 2026)
 * -------------------------------------------------
 * 1. Passing the block inside `ssh "... python -c \"...\""` let the remote
 *    shell expand the backticks, so `bw-tools` and `node managed/rollout.cjs`
 *    arrived empty ("promoted centrally to the release host on  and...").
 *    The block is now base64-encoded inside the script.
 * 2. A multi-line script passed with `python -c "..."` is truncated at the
 *    first newline by cmd.exe. The command still exits 0, so the rollout
 *    printed "✅ synchronized" while nothing was written. The script now
 *    travels over stdin (`python -`), and the device prints which files it
 *    actually changed. A device with no change is reported as a warning.
 */
function syncRulesOnDevice({host, python, label}) {
  const payload = Buffer.from(MANAGED_RULE_BLOCK, 'utf8').toString('base64');
  const script = [
    'import base64, os, re, sys',
    `block = base64.b64decode('${payload}').decode('utf-8')`,
    "pattern = re.compile(r'(?ms)<!-- managed-development-workflow:start -->.*?<!-- managed-development-workflow:end -->')",
    "home = os.path.expanduser('~')",
    "changed = []",
    "missing = []",
    "for rel in ['.gemini/GEMINI.md', '.codex/AGENTS.md', '.config/opencode/AGENTS.md']:",
    '    p = os.path.join(home, rel)',
    '    if not os.path.exists(p):',
    '        missing.append(rel)',
    '        continue',
    '    txt = open(p, "r", encoding="utf-8").read()',
    '    new_txt = pattern.sub(lambda m: block, txt) if pattern.search(txt) else txt.strip() + "\\n\\n" + block + "\\n"',
    '    if new_txt == txt:',
    '        continue',
    '    open(p, "w", encoding="utf-8").write(new_txt)',
    '    back = open(p, "r", encoding="utf-8").read()',
    '    if block not in back:',
    '        sys.exit("write did not stick: " + rel)',
    '    changed.append(rel)',
    'print("CHANGED=" + ",".join(changed))',
    'print("MISSING=" + ",".join(missing))',
  ].join('\n');

  const output = run('ssh', ['-o', 'BatchMode=yes', host, `${python} -`], {input: `${script}\n`});
  const changed = (/CHANGED=(.*)/.exec(output) || [])[1] || '';
  const missing = (/MISSING=(.*)/.exec(output) || [])[1] || '';

  if (!changed) {
    console.error(`      ⚠️ ${label} rules unchanged${missing ? ` (missing: ${missing})` : ''}`);
    return;
  }
  console.log(`      ✅ ${label} rules synchronized (${changed})`);
}

function main() {
  console.log('🚀 Starting Dev Workflow MCP Central Rollout & Rule Sync');
  console.log('========================================================');
  // `--rules-only` exists so the rule block can be re-applied and verified
  // without publishing a release. Publishing copies the committed tree and
  // promotes it to the release host; when only the rules changed (or when a
  // device missed an earlier sync) that work is unnecessary and slow.
  if (process.argv.includes('--rules-only')) {
    console.log('mode: rules only (no publish, no promote)');
    syncRules();
    console.log('========================================================');
    console.log('🎉 Rule synchronization completed.');
    return;
  }
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
  syncRulesOnDevice,
  MANAGED_RULE_BLOCK,
  FLEET_DEVICES,
  remoteTargets,
  classifyLineage,
  makeGitIsAncestor,
  enforceForwardOnly,
  readHostCurrentRevision,
  promoteToServers,
};
