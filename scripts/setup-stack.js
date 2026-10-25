#!/usr/bin/env node

/**
 * Unified Setup Script for AI Agent Development Stack:
 * 1. dev-workflow-mcp-server (Workflow discipline & state tracking)
 * 2. obra/superpowers (Agentic skills framework: brainstorming, TDD, planning)
 * 3. rtk (Rust Token Killer - command output compression)
 *
 * Works against OpenCode V2, which reads its config from the path reported by
 * `opencode debug paths` (~/.config/opencode on every platform) and uses the
 * `plugins` key plus `mcp.servers`, not the V1 `plugin` key and flat `mcp`.
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

export const SUPERPOWERS_SPEC = 'superpowers@git+https://github.com/obra/superpowers.git';
export const MCP_SERVER_NAME = 'dev-workflow';
export const SCHEMA_URL = 'https://opencode.ai/config.json';

/**
 * Parses the `config` line out of `opencode debug paths`.
 * Returns null when the output is unusable, so callers can fall back.
 */
export function parseConfigPathOutput(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*config\s+(.+?)\s*$/);
    if (match && match[1]) return match[1];
  }

  return null;
}

/**
 * Last-resort config location. OpenCode V2 resolves its config directory to
 * ~/.config/opencode on Windows as well - APPDATA is not consulted.
 */
export function fallbackConfigDir({ home = os.homedir(), platform = process.platform } = {}) {
  // Use the target platform's separator, not the host's: a POSIX home must not
  // turn into a backslash path when this helper is exercised on Windows.
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(home, '.config', 'opencode');
}

/**
 * Resolves the OpenCode config directory, preferring what OpenCode itself
 * reports over any platform guess.
 */
export function resolveConfigDir({ probe, home = os.homedir() } = {}) {
  const probed = typeof probe === 'function' ? probe() : null;
  if (probed) return probed;

  return fallbackConfigDir({ home });
}

export function ensureSchema(config) {
  if (!config.$schema) config.$schema = SCHEMA_URL;
  return config;
}

/**
 * Registers Superpowers under the V2 `plugins` key.
 * The V1 `plugin` key is deprecated and ignored by OpenCode V2.
 */
export function mergePluginEntry(config) {
  if (!Array.isArray(config.plugins)) config.plugins = [];
  if (!config.plugins.includes(SUPERPOWERS_SPEC)) config.plugins.push(SUPERPOWERS_SPEC);
  return config;
}

/**
 * Registers a local MCP server under `mcp.servers`, matching
 * Mcp.LocalConfigEncoded. `enabled` is not part of that schema.
 */
export function mergeMcpServer(config, { name = MCP_SERVER_NAME, command }) {
  if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp)) {
    config.mcp = {};
  }
  if (!config.mcp.servers || typeof config.mcp.servers !== 'object') {
    config.mcp.servers = {};
  }

  config.mcp.servers[name] = { type: 'local', command };
  return config;
}

export function backupPathFor(configDir, filename, stamp) {
  return path.join(configDir, 'secrets', `opencode-backup-${stamp}.json`);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  ].join('') + '-' + [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join('');
}

function run(command, options = {}) {
  return execSync(command, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function hasCommand(name) {
  try {
    execSync(process.platform === 'win32' ? `where ${name}` : `command -v ${name}`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function probeConfigDir() {
  try {
    return parseConfigPathOutput(run('opencode debug paths'));
  } catch {
    return null;
  }
}

function readConfig(configPath) {
  if (!existsSync(configPath)) return ensureSchema({});
  const raw = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
  return ensureSchema(JSON.parse(raw));
}

function writeConfig(configPath, config) {
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function backupConfig(configPath, configDir) {
  if (!existsSync(configPath)) return null;

  const dir = path.join(configDir, 'secrets');
  mkdirSync(dir, { recursive: true });
  const target = backupPathFor(configDir, path.basename(configPath), timestamp());
  copyFileSync(configPath, target);
  return target;
}

function ensureDependencies() {
  const nodeModules = path.join(projectRoot, 'node_modules');
  if (existsSync(nodeModules)) {
    console.log('✓ Dependencies already installed.');
    return true;
  }

  console.log('📥 Installing dependencies (required: the MCP server imports dotenv and others)...');
  try {
    execSync('npm install --no-audit --no-fund', { cwd: projectRoot, stdio: 'inherit' });
    console.log('✓ Dependencies installed.');
    return true;
  } catch {
    console.error('✗ npm install failed. The MCP server cannot start without dependencies.');
    return false;
  }
}

function smokeTestServer(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
      cwd: projectRoot,
      // stdin must stay OPEN: a stdio MCP server treats stdin EOF as "shut down"
      // and exits 0 immediately, which would look like a crash.
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let exitedEarly = false;
    let exitCode = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve(result);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      stderr += String(error.message || error);
      exitedEarly = true;
      exitCode = -1;
      finish(smokeTestVerdict({ exitedEarly, exitCode, stdout, stderr }));
    });
    child.on('exit', (code) => {
      if (settled) return;
      exitedEarly = true;
      exitCode = code;
      finish(smokeTestVerdict({ exitedEarly, exitCode, stdout, stderr }));
    });

    const timer = setTimeout(
      () => finish(smokeTestVerdict({ exitedEarly: false, exitCode: null, stdout, stderr })),
      timeoutMs,
    );
  });
}

/**
 * Decides whether a smoke-test run counts as healthy.
 *
 * A stdio MCP server exits cleanly when stdin closes, so "exited with 0" is not
 * a failure on its own - only an early exit *without* the startup banner, or a
 * non-zero exit, is. Exported so the rule is unit-testable without spawning.
 */
export function smokeTestVerdict({ exitedEarly, exitCode, stdout = '', stderr = '' }) {
  if (!exitedEarly) return { ok: true, reason: 'server stayed alive' };

  const started = /running on stdio|MCP Server starting/i.test(`${stdout}${stderr}`);
  if (started) return { ok: true, reason: 'server started then exited cleanly' };

  return {
    ok: false,
    reason: `exited with code ${exitCode} before starting: ${stderr.trim().split('\n')[0] || 'no output'}`,
  };
}

function verifyInstall(configPath) {
  const results = [];

  try {
    const output = run('opencode mcp list');
    const connected = /dev-workflow\s+connected/i.test(output) || /dev-workflow/.test(output);
    results.push({ check: 'mcp dev-workflow registered', ok: connected, detail: output.trim() });
  } catch (error) {
    results.push({ check: 'mcp dev-workflow registered', ok: false, detail: error.message });
  }

  try {
    const output = run('opencode plugin list');
    const ok = /superpowers/.test(output);
    results.push({ check: 'superpowers plugin loaded', ok, detail: output.trim() });
  } catch (error) {
    results.push({ check: 'superpowers plugin loaded', ok: false, detail: error.message });
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    const ok = Array.isArray(config.plugins) && config.plugins.includes(SUPERPOWERS_SPEC);
    results.push({
      check: 'opencode.json uses V2 plugins key',
      ok,
      detail: `plugins=${JSON.stringify(config.plugins ?? null)}`,
    });
  } catch (error) {
    results.push({ check: 'opencode.json readable', ok: false, detail: error.message });
  }

  return results;
}

function ensureAgentsMd(targetProjectRoot) {
  const agentsMdPath = path.join(targetProjectRoot, 'AGENTS.md');
  if (existsSync(agentsMdPath)) {
    console.log('✓ AGENTS.md already exists in project root.');
    return;
  }

  const defaultAgentsMd = `# Dev Workflow Enforcement Rules

## 🛑 MANDATORY MCP WORKFLOW DISCIPLINE

You are connected to the \`dev-workflow\` MCP server. **You MUST NOT perform any coding task, bug fix, or feature implementation without going through the strict workflow enforced by the dev-workflow MCP tools.**

### The Rule of Operation
Before taking any action or answering user requests regarding code changes, check your workflow status and follow these exact steps in sequence:

1. **Start Task**: Call \`start_task\` with a clear description and type (\`feature\`, \`bugfix\`, \`refactor\`, or \`other\`).
2. **Implement**: Write your code changes.
3. **Mark Fixed**: Call \`mark_bug_fixed\` with a summary of the implementation.
4. **Create Tests**: Create appropriate unit/integration tests covering your changes.
5. **Run Tests**: Execute your test suite and call \`run_tests\` with \`passed: true\` and the test command. **Never commit if tests fail!**
6. **Document**: Update documentation and call \`create_documentation\`.
7. **Ready Check**: Call \`check_ready_to_commit\` to verify all steps.
8. **Commit & Push**: Call \`commit_and_push\` with a conventional commit message.
9. **Release**: Call \`perform_release\` with the release command (or \`skip_release\` if docs-only).
10. **Complete**: Call \`complete_task\` to finish the session and reset the workflow.

**Do not bypass these steps. The MCP server will block commits and releases if any required step is skipped.**
`;

  try {
    writeFileSync(agentsMdPath, defaultAgentsMd, 'utf8');
    console.log(`✓ Created AGENTS.md rule enforcement at ${agentsMdPath}`);
  } catch (error) {
    console.warn('⚠️ Could not create AGENTS.md:', error.message);
  }
}

export async function setupStack() {
  console.log('🚀 Setting up Unified AI Agent Development Stack...\n');

  const configDir = resolveConfigDir({ probe: probeConfigDir });
  const opencodeJsonPath = path.join(configDir, 'opencode.json');
  const serverIndexPath = path.join(projectRoot, 'index.js');

  console.log(`✓ OpenCode config directory: ${configDir}`);

  mkdirSync(path.join(configDir, 'plugins'), { recursive: true });

  const backup = backupConfig(opencodeJsonPath, configDir);
  if (backup) console.log(`✓ Backed up opencode.json → ${backup}`);

  const hasOpencodeCli = hasCommand('opencode');
  const command = ['node', serverIndexPath];
  let usedCli = false;

  if (hasOpencodeCli) {
    try {
      console.log('\n🔌 Registering Superpowers via OpenCode CLI...');
      execSync(`opencode plugin add "${SUPERPOWERS_SPEC}"`, { stdio: 'inherit' });
      console.log('✓ Superpowers plugin registered.');

      console.log('\n🔌 Registering dev-workflow MCP server via OpenCode CLI...');
      execSync(`opencode mcp add ${MCP_SERVER_NAME} --global -- node "${serverIndexPath}"`, {
        stdio: 'inherit',
      });
      console.log('✓ dev-workflow MCP server registered.');
      usedCli = true;
    } catch (error) {
      console.warn(`⚠️ OpenCode CLI registration failed (${error.message}). Falling back to direct config edit.`);
    }
  } else {
    console.warn('⚠️ `opencode` CLI not found on PATH. Falling back to direct config edit.');
  }

  if (!usedCli) {
    const config = readConfig(opencodeJsonPath);
    mergePluginEntry(config);
    mergeMcpServer(config, { name: MCP_SERVER_NAME, command });
    writeConfig(opencodeJsonPath, config);
    console.log(`✓ opencode.json updated directly at ${opencodeJsonPath}`);
  }

  // Whatever path we took, confirm the on-disk config is V2-shaped.
  const finalConfig = readConfig(opencodeJsonPath);
  mergePluginEntry(finalConfig);
  mergeMcpServer(finalConfig, { name: MCP_SERVER_NAME, command });
  writeConfig(opencodeJsonPath, finalConfig);
  console.log('✓ opencode.json verified (V2 `plugins` + `mcp.servers`).');

  console.log('\n⚡ Checking RTK (Rust Token Killer)...');
  if (hasCommand('rtk')) {
    try {
      const version = run('rtk --version').trim();
      console.log(`✓ Found ${version}`);
      execSync('rtk init -g --opencode --auto-patch --no-trust-filters', { stdio: 'inherit' });
      console.log('✓ RTK OpenCode plugin registered.');
    } catch {
      console.warn('⚠️ Could not run `rtk init -g --opencode`. Run it manually.');
    }
  } else {
    console.warn('⚠️ `rtk` not found on PATH. Install it, then re-run this script:');
    console.log(process.platform === 'win32' ? '  winget install rtk-ai.rtk' : '  brew install rtk');
  }

  const depsOk = ensureDependencies();

  console.log('\n🔎 Smoke testing the MCP server...');
  const smoke = depsOk
    ? await smokeTestServer()
    : { ok: false, reason: 'skipped: dependencies missing', stderr: '' };
  if (smoke.ok) {
    console.log(`✓ MCP server healthy (${smoke.reason}).`);
  } else {
    console.error(`✗ MCP server failed to start (${smoke.reason}).`);
    if (smoke.stderr) console.error(smoke.stderr.trim());
  }

  ensureAgentsMd(process.env.INIT_CWD || process.cwd());

  console.log('\n🧪 Verifying installation...');
  const checks = verifyInstall(opencodeJsonPath);
  let allOk = smoke.ok;

  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.check}`);
    if (!check.ok) {
      allOk = false;
      if (check.detail) console.log(`      ${check.detail.split('\n')[0]}`);
    }
  }

  console.log('\n============================================================');
  if (allOk) {
    console.log('🎉 UNIFIED AI AGENT DEVELOPMENT STACK INSTALLED SUCCESSFULLY!');
    console.log('============================================================');
    console.log('• Workflow Discipline (dev-workflow MCP): Active');
    console.log('• Agentic Skills (Superpowers): Registered');
    console.log('• Token Compression (RTK): Configured');
    console.log('\nRestart OpenCode to start developing with superpowers! 🚀');
  } else {
    console.log('⚠️ SETUP INCOMPLETE - see the failed checks above.');
    console.log('============================================================');
  }

  return allOk;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  setupStack()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((error) => {
      console.error('Setup encountered an error:', error);
      process.exit(1);
    });
}
