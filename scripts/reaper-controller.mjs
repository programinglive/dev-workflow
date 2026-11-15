#!/usr/bin/env node
/**
 * Machine-local Session Reaper controller.
 *
 * The monitor cannot inspect another host's process table, so this controller
 * does it and reports verified evidence. It never stops a process and never
 * releases a lease: it only attests that a process is gone.
 *
 * WHAT IT DOES
 * ------------
 * 1. Fetches the privileged session list with this machine's own credential.
 * 2. Keeps only sessions bound to this machine.
 * 3. Re-verifies each session's process identity locally (PID, creation time,
 *    executable).
 * 4. For a session whose process is confirmed absent, sends a signed
 *    attestation to the monitor.
 *
 * CROSS-PROJECT SESSIONS
 * ----------------------
 * One AI client process can host several project bindings. Each binding is a
 * separate session row, so each gets its own attestation. Retiring a binding
 * never touches the process, and a live process produces no attestation at all.
 *
 * USAGE
 * -----
 *   node scripts/reaper-controller.mjs --config <path> [--dry-run] [--json]
 *
 * The config file is JSON:
 *   { "machine": "MMCH", "secret": "<per-machine secret>", "monitor": "http://..." }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createLocalAdapters } from '../session-controller-adapters.js';
import { verifyProcessIdentity } from '../session-reaper.js';
import { attestOrphan, fetchReaperSessions } from '../reaper-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { config: '', dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config' && argv[i + 1]) {
      args.config = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--dry-run') {
      args.dryRun = true;
    } else if (argv[i] === '--json') {
      args.json = true;
    }
  }
  return args;
}

async function loadConfig(configPath) {
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (!config.machine) throw new Error('config.machine is required');
  if (!config.secret) throw new Error('config.secret is required');
  if (!config.monitor) throw new Error('config.monitor is required');
  return config;
}

function toSession(row) {
  return {
    session_key: row.session_key,
    machine: row.machine,
    project_name: row.project_name,
    phase: row.phase,
    updated_at: row.updated_at,
    owner: row.owner_pid
      ? {
          pid: Number(row.owner_pid),
          startedAt: String(row.owner_started_at || ''),
          executable: String(row.owner_executable || ''),
        }
      : null,
    lease: row.lease_owner
      ? {
          owner: String(row.lease_owner),
          generation: Number(row.lease_generation) || 0,
          fencingToken: String(row.lease_fencing_token || ''),
        }
      : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    process.stderr.write('usage: node scripts/reaper-controller.mjs --config <path> [--dry-run] [--json]\n');
    process.exitCode = 2;
    return;
  }

  const config = await loadConfig(path.resolve(args.config));
  const adapters = createLocalAdapters();

  const rows = await fetchReaperSessions({
    baseUrl: config.monitor,
    secret: config.secret,
    machine: config.machine,
  });

  const mine = rows.filter((row) => String(row.machine || '') === config.machine);
  const report = { machine: config.machine, platform: process.platform, total: rows.length, mine: mine.length, attested: [], skipped: [] };

  for (const row of mine) {
    const session = toSession(row);
    if (!session.owner) {
      report.skipped.push({ sessionKey: session.session_key, reason: 'OWNER_MISSING' });
      continue;
    }

    const identity = verifyProcessIdentity(session, adapters);
    if (identity.ok) {
      // The process is alive. Nothing to attest, and nothing to touch.
      report.skipped.push({ sessionKey: session.session_key, reason: 'PROCESS_ALIVE' });
      continue;
    }
    if (identity.code !== 'PROCESS_ABSENT') {
      // A reused PID or a changed executable is ambiguous, not an orphan.
      report.skipped.push({ sessionKey: session.session_key, reason: identity.code });
      continue;
    }

    const attestation = {
      sessionKey: session.session_key,
      projectName: session.project_name,
      pid: session.owner.pid,
      startedAt: session.owner.startedAt,
      executable: session.owner.executable,
      leaseOwner: session.lease ? session.lease.owner : '',
      leaseGeneration: session.lease ? session.lease.generation : 0,
      leaseFencingToken: session.lease ? session.lease.fencingToken : '',
      verifiedAt: new Date().toISOString(),
      nonce: randomUUID(),
    };

    if (args.dryRun) {
      report.attested.push({ sessionKey: session.session_key, sent: false, reason: 'DRY_RUN' });
      continue;
    }

    const result = await attestOrphan({
      baseUrl: config.monitor,
      secret: config.secret,
      machine: config.machine,
      attestation,
    });
    report.attested.push({
      sessionKey: session.session_key,
      sent: result.ok,
      status: result.status,
      error: result.error,
    });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`machine ${report.machine} (${report.platform}): ${report.mine}/${report.total} session(s)\n`);
  for (const item of report.attested) {
    process.stdout.write(`  attested ${item.sessionKey} sent=${item.sent}${item.error ? ` error=${item.error}` : ''}\n`);
  }
  for (const item of report.skipped) {
    process.stdout.write(`  skipped  ${item.sessionKey} ${item.reason}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`controller failed: ${String(error && error.message || error)}\n`);
  process.exitCode = 1;
});
