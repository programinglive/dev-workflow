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
const fs = require('node:fs');
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

const WINDOWS_KILL_CLIENTS = [
  "$names=@('codex','agy','antigravity');",
  'Get-Process -ErrorAction SilentlyContinue',
  '| Where-Object { $names -contains $_.ProcessName }',
  '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessName }',
].join(' ');

const MAC_KILL = 'pkill -f ManagedMCP || true';

// The reconnect module runs from this checkout locally, and is streamed over
// stdin on remote devices so it never depends on a checkout path there. The
// runner tail is required: a program fed to `node -` never satisfies
// `require.main === module`, so without it the remote run exits silently and
// looks like a successful verification.
const {STDIN_RUNNER} = require('./mcp-reconnect.cjs');
const RECONNECT_SOURCE = fs.readFileSync(path.join(__dirname, 'mcp-reconnect.cjs'), 'utf8') + STDIN_RUNNER;

// Non-interactive shells on a Mac keep node off PATH when nvm manages it. A
// missing nvm directory only adds an empty prefix, so this stays safe when node
// is already on PATH.
const MAC_HEAL = [
  'export PATH="$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"',
  'node -',
].join('; ');

// opencode is excluded on purpose: it is reloaded in place through its service.
const MAC_KILL_CLIENTS = [
  'for n in codex agy antigravity; do',
  '  pkill -x "$n" 2>/dev/null && echo "$n" || true',
  'done',
].join('\n');

const MAC_RELOAD = [
  'if command -v opencode >/dev/null 2>&1; then',
  '  opencode service restart 2>&1',
  'else',
  '  # nvm keeps node off a non-interactive PATH',
  '  export PATH="$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"',
  '  if command -v opencode >/dev/null 2>&1; then opencode service restart 2>&1; else echo OPENCODE_MISSING; fi',
  'fi',
].join('\n');

function run(command, args, timeout = 90000, input) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    windowsHide: true,
    timeout,
  }).trim();
}

function encoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// A force-killed MCP server is recorded as "exited with code 255" and marked
// failed, and OpenCode never retries. Healing reads /api/mcp after the restart,
// reconnects only the failed servers, and re-reads the status.
function healOnDevice(device) {
  const isLocal = device.match.test(LOCAL);
  if (isLocal) return run(process.execPath, [path.join(__dirname, 'mcp-reconnect.cjs')], 180000);
  if (device.platform === 'windows') {
    return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', device.host, 'node', '-'], 180000, RECONNECT_SOURCE);
  }
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', device.host, MAC_HEAL], 180000, RECONNECT_SOURCE);
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

  // Codex and Antigravity cannot reload; they are closed and resumed by hand.
  try {
    const closed = onDevice(device, WINDOWS_KILL_CLIENTS, MAC_KILL_CLIENTS)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    console.log(closed.length
      ? `  closed     - ${[...new Set(closed)].join(', ')} (reopen and resume)`
      : '  closed     - no Codex or Antigravity process was running');
  } catch (error) {
    console.log(`  closed     - could not close clients: ${error.message.split('\n')[0]}`);
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

  // A green table must mean "connected", not merely "ManagedMCP is running".
  try {
    const output = healOnDevice(device);
    for (const line of output.split(/\r?\n/).filter(Boolean)) console.log(line);
  } catch (error) {
    failures += 1;
    const output = error.stdout ? String(error.stdout).trim() : '';
    if (output) {
      for (const line of output.split(/\r?\n/).filter(Boolean)) console.log(line);
    }
    console.log(`  MCP       - ! reconnect verification failed: ${error.message.split('\n')[0]}`);
  }
}

console.log('\n' + '='.repeat(60));
console.log('Codex and Antigravity were closed. Reopen them and resume your session;');
console.log('they pick up the promoted release on start. OpenCode was already reloaded');
console.log('in place and needs nothing.');

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
