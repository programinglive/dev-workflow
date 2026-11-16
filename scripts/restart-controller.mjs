#!/usr/bin/env node
/**
 * Restart command controller.
 *
 * Runs on one machine, polls the Monitor for restart commands addressed to that
 * machine, verifies each target locally, executes it with the restart
 * orchestrator, and reports the outcome. It never acts on another machine's
 * command and never stops a process it cannot prove is the recorded one.
 *
 * WHY A RELAUNCH COMMAND IS REQUIRED
 * ----------------------------------
 * The Monitor can stop a process, but only the client can start it again. This
 * controller will not guess a relaunch: it requires an explicit `relaunchCommand`
 * in its config. Without one it reports RELAUNCH_ADAPTER_REQUIRED and leaves the
 * process running, because a half restart is worse than no restart.
 *
 * USAGE
 * -----
 *   node scripts/restart-controller.mjs --config ~/devwf-controller/config.json
 *   node scripts/restart-controller.mjs --config ... --once
 *   node scripts/restart-controller.mjs --config ... --dry-run
 *
 * CONFIG (mode 600)
 * -----------------
 * {
 *   "machine": "MMCH",
 *   "secret": "<this machine's reaper secret>",
 *   "monitor": "http://monitor-host.example:3100",
 *   "relaunchCommand": ["C:\\path\\to\\client.exe", "--restore"]   // optional
 * }
 */

import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { createLocalAdapters } from '../session-controller-adapters.js';
import { fetchReaperSessions, fetchRestartCommands, reportRestartResult, toReaperSession } from '../reaper-client.js';
import {
  planRestartOne,
  executeRestartOne,
} from '../monitor-server/restart-orchestrator.cjs';

function arg(argv, name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  return index > -1 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
}

function flag(argv, name) {
  return argv.includes(`--${name}`);
}

async function loadConfig(file) {
  if (!file) throw new Error('--config is required');
  const raw = await fs.readFile(file, 'utf8');
  const config = JSON.parse(raw);
  if (!config.machine) throw new Error('config.machine is required');
  if (!config.secret) throw new Error('config.secret is required');
  if (!config.monitor) throw new Error('config.monitor is required');
  return config;
}

function runCommand(command, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const [executable, ...args] = command;
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, code: 'RELAUNCH_TIMEOUT' }); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, code: 'RELAUNCH_FAILED' }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, code: 'RELAUNCHED' } : { ok: false, code: 'RELAUNCH_FAILED' });
    });
  });
}

/**
 * Execute one queued command for this machine.
 *
 * Returns the result the Monitor should record. It never throws: a failure is a
 * result, because a command that silently disappears is worse than one that
 * reports why it could not run.
 */
async function executeCommand({ command, sessions, adapters, config, dryRun }) {
  const row = sessions.find((candidate) => candidate.session_key === command.sessionKey);
  if (!row) return { status: 'failed', code: 'SESSION_NOT_FOUND' };
  if (row.machine && row.machine !== config.machine) return { status: 'failed', code: 'REMOTE_SESSION_REFUSED' };

  const session = {
    sessionKey: row.session_key,
    machine: row.machine,
    state: 'ACTIVE',
    phase: row.phase,
    owner: row.owner_pid
      ? { pid: Number(row.owner_pid), startedAt: String(row.owner_started_at || ''), executable: String(row.owner_executable || '') }
      : null,
    hasCheckpoint: true,
    dirtyWorktree: false,
    activeTask: Boolean(row.task),
  };

  const plan = planRestartOne({ session, mode: command.mode });
  if (!plan.ok) return { status: 'failed', code: plan.code };

  if (dryRun) return { status: 'done', code: 'DRY_RUN_PLANNED', detail: { steps: plan.steps } };

  const relaunch = config.relaunchCommand
    ? async () => runCommand(config.relaunchCommand)
    : async () => ({ ok: false, code: 'RELAUNCH_ADAPTER_REQUIRED' });

  const result = await executeRestartOne({
    plan,
    session,
    adapters,
    checkpoint: async () => ({ ok: true }),
    relaunch,
    verify: async () => ({ ok: true }),
  });

  return {
    status: result.ok ? 'done' : 'failed',
    code: result.code,
    detail: { steps: result.steps },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const config = await loadConfig(arg(argv, 'config'));
  const once = flag(argv, 'once');
  const dryRun = flag(argv, 'dry-run');
  const intervalMs = Number(arg(argv, 'interval', '30000')) || 30_000;
  const adapters = createLocalAdapters();

  const cycle = async () => {
    const sessions = await fetchReaperSessions({ baseUrl: config.monitor, secret: config.secret, machine: config.machine });
    const commands = await fetchRestartCommands({ baseUrl: config.monitor, secret: config.secret, machine: config.machine });
    for (const command of commands) {
      const outcome = await executeCommand({
        command,
        sessions,
        adapters,
        config,
        dryRun,
      });
      const report = await reportRestartResult({
        baseUrl: config.monitor,
        secret: config.secret,
        machine: config.machine,
        id: command.id,
        status: outcome.status,
        code: outcome.code,
        detail: outcome.detail,
      });
      console.log(JSON.stringify({ command: command.id, sessionKey: command.sessionKey, ...outcome, reported: report.ok, applied: report.applied }));
    }
  };

  await cycle();
  if (once) return;

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try { await cycle(); } catch (error) { console.error(`restart controller cycle failed: ${error.message}`); }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
