#!/usr/bin/env node
'use strict';

/**
 * Report the real state of the managed Dev Workflow MCP on every fleet device.
 *
 * WHY THIS EXISTS
 * ---------------
 * `restart-devices.cjs` only kills the ManagedMCP process. The MCP is a child of
 * the AI CLI, so nothing comes back until the CLI is started again, and the
 * release is only chosen at CLI start. After a restart the agent had no way to
 * tell whether the MCP was running, which release it would load, or what to do
 * next — so it guessed.
 *
 * This command answers those three questions with facts:
 *   - is a ManagedMCP process running on this device right now?
 *   - which revision will each AI client resolve on its next start?
 *   - is every device and client on the same revision as the release host?
 *
 * Usage:
 *   node managed/fleet-status.cjs
 *   node managed/fleet-status.cjs --json
 *
 * Exit code is 1 when any device is unreachable or any client would resolve a
 * different revision than the majority. Read-only: it starts nothing and kills
 * nothing.
 */

const os = require('node:os');
const { execFileSync } = require('node:child_process');

const LOCAL = os.hostname();
const CLIENTS = ['opencode', 'codex', 'antigravity'];
const WANT_JSON = process.argv.includes('--json');

const DEVICES = [
  {
    label: 'HELLOWORLD',
    host: 'helloworld',
    match: /helloworld/i,
    platform: 'windows',
    entry: 'C:\\Users\\DHIKA\\AppData\\Local\\ProgramingLive\\ManagedMCP\\bootstrap\\device-entry.cjs',
  },
  {
    label: 'Mac',
    host: 'mac',
    match: /mac/i,
    platform: 'mac',
    entry: '/Users/mahardhika/.local/share/ProgramingLive/ManagedMCP/bootstrap/device-entry.cjs',
  },
  {
    label: 'MMCH',
    host: 'mmch',
    match: /mmch/i,
    platform: 'windows',
    entry: 'C:\\Users\\mahardhika\\AppData\\Local\\ProgramingLive\\ManagedMCP\\bootstrap\\device-entry.cjs',
  },
];

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 60000,
  }).trim();
}

function windowsScript(entry) {
  const clients = CLIENTS.map((c) => `'${c}'`).join(',');
  return [
    `$entry='${entry}';`,
    `$clients=@(${clients});`,
    "$alive=(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'ManagedMCP' } | Measure-Object).Count;",
    '"ALIVE=" + $alive;',
    'foreach($c in $clients){',
    '  try { $r = (node $entry $c --resolve-only 2>$null | Select-Object -Last 1); "CLIENT=$c|" + $r } catch { "CLIENT=$c|ERROR" }',
    '}',
  ].join(' ');
}

function macScript(entry) {
  const lines = [
    `entry="${entry}"`,
    // A non-interactive SSH shell does not load the login profile, so nvm's
    // node is not on PATH. Resolve it explicitly instead of failing.
    'node_bin=$(command -v node 2>/dev/null)',
    '[ -n "$node_bin" ] || node_bin=/Users/mahardhika/.nvm/versions/node/v24.22.1/bin/node',
    '[ -x "$node_bin" ] || node_bin=$(ls -1 ~/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)',
    '[ -x "$node_bin" ] || node_bin=$(ls -1 /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1)',
    'alive=$(pgrep -f ManagedMCP | wc -l | tr -d " ")',
    'echo "ALIVE=$alive"',
    `for c in ${CLIENTS.join(' ')}; do`,
    '  if [ -x "$node_bin" ]; then',
    '    r=$("$node_bin" "$entry" "$c" --resolve-only 2>/dev/null | tail -1)',
    '    echo "CLIENT=$c|$r"',
    '  else',
    '    echo "CLIENT=$c|NONODE"',
    '  fi',
    'done',
  ];
  return lines.join('\n');
}

function collect(device) {
  const isLocal = device.match.test(LOCAL);
  let output;

  if (device.platform === 'windows') {
    const encoded = Buffer.from(windowsScript(device.entry), 'utf16le').toString('base64');
    const args = ['-NoProfile', '-EncodedCommand', encoded];
    output = isLocal
      ? run('powershell', args)
      : run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', device.host, 'powershell', ...args]);
  } else {
    // A multi-line script passed as separate arguments loses its quoting over
    // ssh, so it travels base64-encoded and runs through a single shell.
    const encoded = Buffer.from(macScript(device.entry), 'utf8').toString('base64');
    const remote = `echo ${encoded} | base64 -d | sh`;
    output = isLocal
      ? run('sh', ['-c', macScript(device.entry)])
      : run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', device.host, remote]);
  }

  const alive = /ALIVE=(\d+)/.exec(output);
  const clients = {};
  for (const line of output.split('\n')) {
    const hit = /CLIENT=([a-z]+)\|(.*)$/.exec(line.trim());
    if (!hit) continue;
    const [, client, payload] = hit;
    if (payload === 'NONODE') {
      clients[client] = { revision: null, error: 'node not found on device' };
      continue;
    }
    if (payload === 'ERROR' || !payload) {
      clients[client] = { revision: null, error: 'resolve failed' };
      continue;
    }
    try {
      const parsed = JSON.parse(payload);
      clients[client] = {
        revision: parsed.revision || null,
        version: parsed.version || null,
        offline: parsed.offline === true,
      };
    } catch {
      clients[client] = { revision: null, error: 'unreadable output' };
    }
  }

  return {
    label: device.label,
    local: isLocal,
    alive: alive ? Number(alive[1]) : 0,
    clients,
  };
}

const results = [];
for (const device of DEVICES) {
  try {
    results.push(collect(device));
  } catch (error) {
    results.push({
      label: device.label,
      local: device.match.test(LOCAL),
      alive: 0,
      clients: Object.fromEntries(CLIENTS.map((c) => [c, { revision: null, error: 'device unreachable' }])),
      error: error.message.split('\n')[0],
    });
  }
}

const revisions = results.flatMap((r) => Object.values(r.clients).map((c) => c.revision).filter(Boolean));
const tally = revisions.reduce((acc, rev) => ({ ...acc, [rev]: (acc[rev] || 0) + 1 }), {});
const majority = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

const problems = [];
for (const device of results) {
  if (device.error) problems.push(`${device.label}: ${device.error}`);
  for (const [client, info] of Object.entries(device.clients)) {
    if (info.error) problems.push(`${device.label}/${client}: ${info.error}`);
    else if (majority && info.revision !== majority) problems.push(`${device.label}/${client}: revision ${String(info.revision).slice(0, 12)} differs from ${String(majority).slice(0, 12)}`);
  }
}

if (WANT_JSON) {
  console.log(JSON.stringify({ majority, devices: results, problems }, null, 2));
} else {
  console.log('Dev Workflow MCP fleet status');
  console.log('='.repeat(60));
  for (const device of results) {
    const running = device.alive > 0 ? `running (${device.alive})` : 'NOT RUNNING';
    console.log(`\n${device.label}${device.local ? ' (local)' : ''} — ManagedMCP: ${running}`);
    if (device.error) console.log(`  ! ${device.error}`);
    for (const client of CLIENTS) {
      const info = device.clients[client] || {};
      const rev = info.revision ? `${info.revision.slice(0, 12)} (v${info.version || '?'})` : (info.error || 'unknown');
      console.log(`  ${client.padEnd(12)} next start -> ${rev}`);
    }
  }
  console.log('');
  console.log(majority ? `Majority revision: ${majority.slice(0, 12)}` : 'No revision could be resolved.');
  if (problems.length) {
    console.log('\nProblems:');
    for (const problem of problems) console.log(`  - ${problem}`);
    console.log('\nTo fix: run  node managed/restart-devices.cjs  and reopen each AI CLI.');
  } else {
    console.log('\nAll devices and clients agree. Anything not yet RUNNING starts on next CLI launch.');
  }
}

process.exitCode = problems.length ? 1 : 0;
