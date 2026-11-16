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
import { fetchReaperSessions, fetchRestartCommands, claimRestartCommand, reportRestartResult } from '../reaper-client.js';
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
 * Run the checkpoint command and require a confirmed result.
 *
 * The command is `devwf checkpoint --session <key>`, which uses the same
 * authenticated handler as the MCP tool and exits non-zero unless the write
 * was read back and matched. A command that merely exits 0 without a
 * checkpoint would be a claim, not proof, so the exit code is the contract.
 */
function runCheckpoint(template, sessionKey, timeoutMs = 120_000) {
  const command = template.map((part) => String(part).replace('{sessionKey}', sessionKey));
  return new Promise((resolve) => {
    const [executable, ...args] = command;
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk).slice(0, 2000); });
    child.stdout?.on('data', () => {});
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, code: 'CHECKPOINT_TIMEOUT' }); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, code: 'CHECKPOINT_FAILED' }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, code: 'CHECKPOINT_CONFIRMED' });
      // The CLI refuses rather than guesses: an unconfirmed write, a missing
      // task, or a live session holding the mutation lock all land here.
      const code2 = /mutation lock|foreign_lock|mutex/i.test(stderr) ? 'CHECKPOINT_LOCKED' : 'CHECKPOINT_FAILED';
      resolve({ ok: false, code: code2 });
    });
  });
}

/**
 * Execute one queued command for this machine.
 *
 * Returns the result the Monitor should record. It never throws: a failure is a
 * result, because a command that silently disappears is worse than one that
 * reports why it could not run.
 *
 * TWO RULES THAT KEEP THIS SAFE
 * -----------------------------
 * 1. The target must be verified locally before anything is stopped.
 * 2. The checkpoint and relaunch adapters must exist BEFORE the stop. A restart
 *    that stops a process and only then discovers it cannot start it again is a
 *    half restart, which is worse than no restart.
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
    // `hasCheckpoint` means "we have a way to save this before stopping", not
    // "a checkpoint already exists". An idle session has nothing to lose; a
    // session with a task is only restartable when a checkpoint adapter is
    // configured, and that adapter must still exit 0 before any stop.
    hasCheckpoint: !row.task || Boolean(config.checkpointCommand),
    dirtyWorktree: false,
    activeTask: Boolean(row.task),
  };

  const plan = planRestartOne({ session, mode: command.mode });
  if (!plan.ok) return { status: 'failed', code: plan.code };

  // Fail before the stop, not after it.
  if (!config.checkpointCommand) return { status: 'failed', code: 'CHECKPOINT_ADAPTER_REQUIRED' };
  if (!config.relaunchCommand) return { status: 'failed', code: 'RELAUNCH_ADAPTER_REQUIRED' };

  if (dryRun) return { status: 'done', code: 'DRY_RUN_PLANNED', detail: { steps: plan.steps } };

  const checkpoint = async () => runCheckpoint(config.checkpointCommand, session.sessionKey);
  const relaunch = async () => runCommand(config.relaunchCommand);

  const result = await executeRestartOne({
    plan,
    session,
    adapters,
    checkpoint,
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
      // Claim before executing: two controllers must never run one command, and
      // a controller that restarts after executing but before reporting must not
      // run it again.
      const claim = await claimRestartCommand({
        baseUrl: config.monitor,
        secret: config.secret,
        machine: config.machine,
        id: command.id,
      });
      if (!claim.claimed) {
        console.log(JSON.stringify({ command: command.id, sessionKey: command.sessionKey, skipped: 'ALREADY_CLAIMED' }));
        continue;
      }
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
