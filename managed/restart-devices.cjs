#!/usr/bin/env node
'use strict';

/**
 * Restart the managed Dev Workflow MCP on fleet devices that actually have a
 * live AI session.
 *
 * WHY THIS EXISTS
 * ---------------
 * The MCP is a child of the AI CLI. Killing it does not make the CLI spawn it
 * again, and the launcher only picks a release at start. A device with no AI
 * session has no MCP child to restart: killing its process tree is a no-op and
 * leaves stale telemetry on the monitor. Restarting it was a recurring mistake.
 *
 * The monitor's /api/sessions payload is the source of truth for liveness. A
 * session counts as live only when its reaper_state is ACTIVE and its last
 * heartbeat is recent. Everything else (IDLE, ORPHANED, UNREACHABLE or an old
 * ACTIVE row) is skipped.
 *
 * Usage:
 *   node managed/restart-devices.cjs          # only devices with live sessions
 *   node managed/restart-devices.cjs --all    # override the liveness check
 *
 * After it finishes, reopen the AI CLI on the affected devices. The launcher
 * will resolve the release that managed/rollout.cjs promoted. Devices that
 * were skipped already resolve the promoted release via their launcher; no
 * reopen is needed there.
 */

const os = require('node:os');
const { execFileSync } = require('node:child_process');

/**
 * @zettly-code ZC-DW-RESTART-LIVENESS-001
 * @purpose Restart only fleet devices that have a genuinely live AI session.
 * @domain tooling
 * @bug-fix The blanket restart no longer kills ManagedMCP on devices with no active session, such as MMCH.
 * @root-cause restart-devices.cjs iterated all three devices without checking monitor liveness, so idle devices were killed and left stale telemetry.
 * @fix Gate each device on a recent ACTIVE session from the monitor, with an explicit --all override.
 * @related managed/rollout.cjs, tests/restart-devices-liveness.test.cjs
 * @tests tests/restart-devices-liveness.test.cjs
 */

const LOCAL = os.hostname();
const MONITOR_URL = process.env.DEVWF_MONITOR_URL || 'http://100.77.138.14:3100';
const FRESHNESS_MS = 10 * 60 * 1000;

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

/**
 * Machines with at least one genuinely live AI session.
 * Pure function so it can be tested without SSH or a running monitor.
 */
function activeMachinesFromMonitor(payload, now = Date.now(), freshnessMs = FRESHNESS_MS) {
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  const live = new Set();
  for (const session of sessions) {
    if (String(session?.reaper_state || '').toUpperCase() !== 'ACTIVE') continue;
    const stamp = Date.parse(session?.updated_at || session?.last_seen || '');
    if (!Number.isFinite(stamp) || now - stamp > freshnessMs) continue;
    if (typeof session?.machine === 'string') live.add(session.machine);
  }
  return live;
}

function readActiveMachines() {
  const response = fetch(`${MONITOR_URL.replace(/\/$/, '')}/api/sessions`, {
    signal: AbortSignal.timeout(10000),
  });
  return response.then((r) => {
    if (!r.ok) throw new Error(`monitor returned HTTP ${r.status}`);
    return r.json();
  }).then((payload) => ({ ok: true, machines: activeMachinesFromMonitor(payload) }))
    .catch((error) => ({ ok: false, error: error.message, machines: new Set() }));
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

async function main(argv = process.argv.slice(2)) {
  console.log('Restart managed Dev Workflow MCP only where an AI session is live.');
  const forceAll = argv.includes('--all');
  let active = new Set();
  if (!forceAll) {
    const probe = await readActiveMachines();
    if (!probe.ok) {
      console.log(`  ⚠️ Cannot verify live sessions (${probe.error}); nothing restarted. Use --all to override.`);
      process.exitCode = 1;
      return;
    }
    active = probe.machines;
    console.log(`  Live AI sessions reported on: ${active.size ? [...active].join(', ') : '(none)'}`);
  }

  let failures = 0;
  for (const device of DEVICES) {
    if (!forceAll && !active.has(device.label)) {
      console.log(`  ⏭️ ${device.label}: skipped (no live AI session)`);
      continue;
    }
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
  console.log('Reopen the AI CLI only on devices that were restarted; skipped devices need no action.');
  process.exitCode = failures > 0 ? 1 : 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Restart failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { DEVICES, activeMachinesFromMonitor, main };
