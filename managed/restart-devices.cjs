#!/usr/bin/env node
'use strict';

/**
 * Restart the managed Dev Workflow MCP on every fleet device.
 *
 * WHY THIS EXISTS
 * ---------------
 * The MCP is a child of the AI CLI. Killing it does not make the CLI spawn it
 * again, and the launcher only picks a release at start. So "restart the MCP"
 * means: kill the ManagedMCP process tree on every device, then reopen the CLI.
 * Doing that by hand, device by device, is how one device was left on an old
 * release while the others were current.
 *
 * This script kills the ManagedMCP processes on HELLOWORLD, Mac and MMCH in one
 * command. It does not touch other MCP servers: the match is `ManagedMCP` in the
 * command line, not every node process.
 *
 * Usage:
 *   node managed/restart-devices.cjs
 *
 * After it finishes, reopen the AI CLI on each device. The launcher will resolve
 * the release that `managed/rollout.cjs` promoted.
 */

const os = require('node:os');
const { execFileSync } = require('node:child_process');

const LOCAL = os.hostname();

const DEVICES = [
  { label: 'HELLOWORLD', host: 'helloworld', match: /helloworld/i, platform: 'windows' },
  { label: 'Mac', host: 'mac', match: /mac/i, platform: 'mac' },
  { label: 'MMCH', host: 'mmch', match: /mmch/i, platform: 'windows' },
];

const WINDOWS_SCRIPT = [
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
  "| Where-Object { $_.CommandLine -match 'ManagedMCP' }",
  '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
].join(' ');

const WINDOWS_ENCODED = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
const MAC_SCRIPT = "pkill -f ManagedMCP || true";

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function killLocal(platform) {
  if (platform === 'windows') {
    run('powershell', ['-NoProfile', '-EncodedCommand', WINDOWS_ENCODED]);
  } else {
    run('sh', ['-c', MAC_SCRIPT]);
  }
}

function killRemote(device) {
  if (device.platform === 'windows') {
    run('ssh', ['-o', 'BatchMode=yes', device.host, 'powershell', '-NoProfile', '-EncodedCommand', WINDOWS_ENCODED]);
  } else {
    run('ssh', ['-o', 'BatchMode=yes', device.host, MAC_SCRIPT]);
  }
}

let failures = 0;

for (const device of DEVICES) {
  const isLocal = device.match.test(LOCAL);
  try {
    if (isLocal) {
      killLocal(device.platform);
    } else {
      killRemote(device);
    }
    console.log(`  ✅ ${device.label}${isLocal ? ' (local)' : ''}: ManagedMCP processes stopped`);
  } catch (error) {
    failures += 1;
    console.log(`  ⚠️ ${device.label}: ${error.message}`);
  }
}

console.log('');
console.log('Reopen the AI CLI on each device so the launcher resolves the promoted release.');
process.exitCode = failures > 0 ? 1 : 0;
