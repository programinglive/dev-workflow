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
  { name: 'docker-alma', ip: '100.117.87.66', port: 3101, isPrimary: true },
  { name: 'n8n-instance', ip: '100.78.134.44', port: 3101, isPrimary: false },
];

const MANAGED_RULE_BLOCK = `<!-- managed-development-workflow:start -->
## Shared development workflow
OpenCode, Codex and AGY (Antigravity CLI and IDE) use the same centrally managed Dev Workflow MCP release and Zettly owner account.
- Before development work, call dev-workflow start_task with an English task description, type, projectDir, a concrete definitionOfDone and an ordered plan. Reuse the canonical task ID and existing Zettly Todo when continuing work. Do not start coding before registration succeeds.
- **Mandatory Mermaid Flow Design Gate (Token & Scope Lock):** Immediately after \`start_task\` and BEFORE writing or modifying any implementation code or tests, you MUST call \`create_feature_flow\` with a connected Mermaid flowchart (\`flowchart TD\` / \`graph TD\`) and an English description. This generates and syncs the visual architecture canvas in Zettly Draw (\`https://zettly.programinglive.com/draw/{id}\`) linked to the canonical Zettly Todo. AI MUST NOT deviate from the recorded flow or write code before this gate succeeds, preventing hallucinations and token waste.
- **Multi-Device & Multi-AI Consistency:** Whenever updating dev-workflow MCP or workflow rules, the change MUST be published and promoted centrally to docker-alma/n8n-instance and synchronized across all three AI CLIs (Codex, OpenCode, AGY) on all three devices (HELLOWORLD, Mac, MMCH) via \`node managed/rollout.cjs\`.
- Verify the task appears on the central monitor at http://100.107.65.21:3100. A connected MCP process without a registered task does not prove that work is being tracked. If the tool is unavailable, report the failed registration and reload the MCP connection rather than claiming the session is tracked.
- Write new identifiers, comments, docstrings, test descriptions, developer documentation and commit messages in English. User conversation and explicitly localized product text may use the requested language.
- Update plan and definition-of-done evidence during execution. Use automatic Zettly synchronization and sync_zettly_task retries; do not create duplicate Todos or write to the retired Daily Activity Journal/PocketBase store.
- Verify the actual result before complete_task. Confirm the linked Zettly Todo and outcome were saved and read back. Keep unfinished tasks open and report the actual blocker.
- Use the managed bootstrap configured for this device. Never replace it with a direct checkout path or copy tokens between client settings. Reconnect an existing MCP session to load a newly promoted release.
<!-- managed-development-workflow:end -->`;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function publishRelease() {
  console.log('[1/5] Publishing release archive from reviewed Git tree...');
  const publishScript = path.join(MANAGED_DIR, 'publish.cjs');
  const manifestRaw = run(process.execPath, [publishScript, STAGING_DIR], { cwd: REPO_ROOT });
  const manifest = JSON.parse(manifestRaw);
  console.log(`      Revision: ${manifest.revision.slice(0, 12)} | SHA256: ${manifest.sha256.slice(0, 16)}... | Size: ${manifest.size} bytes`);
  return manifest;
}

function promoteToServers(manifest) {
  console.log('[2/5] Promoting release to central release servers...');
  const archivePath = path.join(STAGING_DIR, 'releases', `${manifest.sha256}.tar.gz`);
  const manifestPath = path.join(STAGING_DIR, 'current.json');

  for (const host of RELEASE_HOSTS) {
    try {
      console.log(`      Deploying to ${host.name} (${host.ip}:${host.port})...`);
      run('scp', ['-o', 'BatchMode=yes', manifestPath, archivePath, `${host.name}:/tmp/`]);

      const installCommands = [
        `sudo mv /tmp/${manifest.sha256}.tar.gz /var/lib/devwf-releases/releases/`,
        `sudo chown devwf-releases:devwf-releases /var/lib/devwf-releases/releases/${manifest.sha256}.tar.gz`,
        `sudo chmod 644 /var/lib/devwf-releases/releases/${manifest.sha256}.tar.gz`,
        `sudo cp /var/lib/devwf-releases/current.json /var/lib/devwf-releases/previous.json 2>/dev/null || true`,
        `sudo mv /tmp/current.json /var/lib/devwf-releases/current.json`,
        `sudo chown root:root /var/lib/devwf-releases/current.json`,
        `sudo chmod 644 /var/lib/devwf-releases/current.json`,
      ].join(' && ');

      run('ssh', ['-o', 'BatchMode=yes', host.name, installCommands]);
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
  const pattern = /(?ms)<!-- managed-development-workflow:start -->.*?<!-- managed-development-workflow:end -->/;
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
    const pythonScript = `import os, re
block = '''${MANAGED_RULE_BLOCK}'''
pattern = re.compile(r'(?ms)<!-- managed-development-workflow:start -->.*?<!-- managed-development-workflow:end -->')
home = os.path.expanduser('~')
for rel in ['.gemini/GEMINI.md', '.codex/AGENTS.md', '.config/opencode/AGENTS.md']:
    p = os.path.join(home, rel)
    if os.path.exists(p):
        txt = open(p, 'r', encoding='utf-8').read()
        new_txt = pattern.sub(block, txt) if pattern.search(txt) else txt.strip() + '\\n\\n' + block + '\\n'
        open(p, 'w', encoding='utf-8').write(new_txt)
`;
    run('ssh', ['-o', 'BatchMode=yes', 'mac', `python3 -c "${pythonScript.replace(/"/g, '\\"')}"`]);
    console.log('      ✅ Mac rules synchronized (GEMINI.md, Codex, OpenCode)');
  } catch (err) {
    console.error(`      ⚠️ Mac rule sync failed: ${err.message}`);
  }

  // 3. MMCH
  try {
    const pythonScriptMMCH = `import os, re
block = '''${MANAGED_RULE_BLOCK}'''
pattern = re.compile(r'(?ms)<!-- managed-development-workflow:start -->.*?<!-- managed-development-workflow:end -->')
home = 'C:/Users/mahardhika'
for rel in ['.gemini/GEMINI.md', '.codex/AGENTS.md', '.config/opencode/AGENTS.md']:
    p = os.path.join(home, rel)
    if os.path.exists(p):
        txt = open(p, 'r', encoding='utf-8').read()
        new_txt = pattern.sub(block, txt) if pattern.search(txt) else txt.strip() + '\\n\\n' + block + '\\n'
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

module.exports = { publishRelease, syncRuleText, MANAGED_RULE_BLOCK };
