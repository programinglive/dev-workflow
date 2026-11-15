#!/usr/bin/env node
'use strict';

/**
 * Dry-run reconciliation for the DevWorkflow monitor.
 *
 * This script is deliberately read-only. It fetches the monitor's session list,
 * classifies each session with the verified state machine, and prints the plan.
 * It never calls /api/session/close and never releases a lease: those actions
 * require a machine-local controller that can verify the process on its own
 * host. The monitor payload does not expose the owner PID, so a session without
 * local verification is reported as RECOVERY_REQUIRED rather than guessed.
 *
 * Usage:
 *   node scripts/session-reaper.cjs [--monitor http://100.77.138.14:3100] [--json]
 */

const DEFAULT_MONITOR = process.env.DEVWF_MONITOR_URL || 'http://100.77.138.14:3100';

function parseArgs(argv) {
  const args = { monitor: DEFAULT_MONITOR, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--monitor' && argv[i + 1]) {
      args.monitor = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--json') {
      args.json = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { reconcileSessions } = await import('../session-reaper.js');

  const response = await fetch(`${args.monitor.replace(/\/$/, '')}/api/sessions`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`monitor returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];

  const plans = reconcileSessions(sessions, {
    now: Date.now(),
    machineOnline: true,
    // No local process adapter in a dry run: identity cannot be verified, so
    // the state machine reports RECOVERY_REQUIRED instead of guessing.
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ monitor: args.monitor, plans }, null, 2)}\n`);
    return;
  }

  const counts = plans.reduce((acc, plan) => {
    acc[plan.state] = (acc[plan.state] || 0) + 1;
    return acc;
  }, {});

  console.log(`Monitor: ${args.monitor}`);
  console.log(`Sessions: ${plans.length}`);
  console.log(`States: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log('');
  for (const plan of plans) {
    console.log(`${plan.state.padEnd(18)} ${plan.machine.padEnd(12)} ${plan.project.padEnd(36)} ${plan.action}`);
    console.log(`  ${plan.reason}`);
  }
  console.log('');
  console.log('Dry run only. No session was closed and no lease was released.');
}

main().catch((error) => {
  console.error(`session-reaper: ${error.message}`);
  process.exitCode = 1;
});
