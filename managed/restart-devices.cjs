#!/usr/bin/env node
'use strict';

/**
 * Bring the managed Dev Workflow MCP onto the promoted release on every device.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This used to only kill ManagedMCP and tell the operator to "reopen the AI
 * CLI". That left out three facts the operator needs: which CLIs exist, which
 * of them can reload without closing a window, and how to prove it worked.
 *
 * OpenCode owns a background service. `opencode service restart` re-launches the
 * MCP and the running TUI reconnects on its own, so no window has to be closed.
 * That path is exercised here, not described.
 *
 * Codex and Antigravity spawn their MCP at process start and expose no reload
 * command. They are reported as "needs its own restart" instead of being ignored,
 * because silently skipping them is how a device ends up on an old release.
 *
 * Usage:
 *   node managed/restart-devices.cjs            # reload + verify
 *   node managed/restart-devices.cjs --no-verify
 */

const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LOCAL = os.hostname();
const SKIP_VERIFY = process.argv.includes('--no-verify');

const DEVICES = [
  { label: 'HELLOWORLD', host: 'helloworld', match: /helloworld/i, platform: 'windows' },
  { label: 'Mac', host: 'mac', match: /mac/i, platform: 'mac' },
  { label: 'MMCH', host: 'mmch', match: /mmch/i, platform: 'windows' },
];

const WINDOWS_KILL = [
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
  "| Where-Object { $_.CommandLine -match 'ManagedMCP' }",
  '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
].join(' ');

const WINDOWS_RELOAD = [
  "try { $null = Get-Command opencode -ErrorAction Stop; opencode service restart 2>&1 | Out-String }",
  "catch { 'OPENCODE_MISSING' }",
].join(' ');

const MAC_KILL = 'pkill -f ManagedMCP || true';

const MAC_RELOAD = [
  'if command -v opencode >/dev/null 2>&1; then',
  '  opencode service restart 2>&1',
  'else',
  '  # nvm keeps node off a non-interactive PATH',
  '  export PATH="$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"',
  '  if command -v opencode >/dev/null 2>&1; then opencode service restart 2>&1; else echo OPENCODE_MISSING; fi',
  'fi',
].join('\n');

function run(command, args, timeout = 90000) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout,
  }).trim();
}

function encoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function onDevice(device, script, macScript) {
  const isLocal = device.match.test(LOCAL);
  if (device.platform === 'windows') {
    const args = ['-NoProfile', '-EncodedCommand', encoded(script)];
    return isLocal ? run('powershell', args) : run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', device.host, 'powershell', ...args]);
  }
  const payload = Buffer.from(macScript, 'utf8').toString('base64');
  const remote = `echo ${payload} | base64 -d | sh`;
  return isLocal ? run('sh', ['-c', macScript]) : run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', device.host, remote]);
}

let failures = 0;

console.log('Dev Workflow MCP — reload to the promoted release');
console.log('='.repeat(60));

for (const device of DEVICES) {
  const isLocal = device.match.test(LOCAL);
  const suffix = isLocal ? ' (local)' : '';

  // Stale processes hold the old build in memory and must go first.
  try {
    onDevice(device, WINDOWS_KILL, MAC_KILL);
    console.log(`\n${device.label}${suffix}`);
    console.log('  stale ManagedMCP processes stopped');
  } catch (error) {
    failures += 1;
    console.log(`\n${device.label}${suffix}`);
    console.log(`  ! could not stop ManagedMCP: ${error.message.split('\n')[0]}`);
    continue;
  }

  // OpenCode reloads through its own service; nothing is closed.
  try {
    const output = onDevice(device, WINDOWS_RELOAD, MAC_RELOAD);
    if (output.includes('OPENCODE_MISSING')) {
      console.log('  OpenCode  - not installed on this device');
    } else {
      console.log('  OpenCode  - reloaded via `opencode service restart`');
    }
  } catch (error) {
    failures += 1;
    console.log(`  OpenCode  - reload failed: ${error.message.split('\n')[0]}`);
  }
}

console.log('\n' + '='.repeat(60));
console.log('Codex and Antigravity spawn their MCP at process start and have no');
console.log('reload command. Where either is open, close that one app and start it');
console.log('again; nothing else on the device needs to be touched.');

if (!SKIP_VERIFY) {
  try {
    const statusScript = path.join(__dirname, 'fleet-status.cjs');
    console.log('\n' + run(process.execPath, [statusScript]));
  } catch (error) {
    const output = error.stdout ? String(error.stdout).trim() : '';
    if (output) console.log('\n' + output);
    failures += 1;
    console.log('\n! fleet-status reported a problem; see the table above.');
  }
}

process.exitCode = failures > 0 ? 1 : 0;
