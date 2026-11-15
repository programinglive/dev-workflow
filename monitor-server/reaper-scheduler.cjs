'use strict';

/**
 * Idempotent reconciliation cycle for the session reaper.
 *
 * One scheduler owner: `start()` is a no-op when a timer already exists, and
 * `runOnce()` refuses to overlap itself. The default is dry-run; a mutation
 * only happens when `dryRun` is explicitly false and the plan is a confirmed
 * orphan. The cycle never stops a process and never releases a lease: those
 * require the machine-local controller, which the monitor cannot impersonate.
 */

const { buildReaperSessionsQuery } = require('./reaper-query.cjs');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RETRIES = 3;

function toReaperSession(row) {
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

function createReaperScheduler({
  query,
  log = console,
  intervalMs = DEFAULT_INTERVAL_MS,
  dryRun = true,
  now = () => Date.now(),
  reaper = null,
} = {}) {
  let running = false;
  let timer = null;
  const audit = [];

  async function loadReaper() {
    if (reaper) return reaper;
    return import('../session-reaper.js');
  }

  async function runOnce() {
    if (running) return { ok: false, reason: 'ALREADY_RUNNING' };
    running = true;
    try {
      const { planCleanup } = await loadReaper();
      const { sql, params } = buildReaperSessionsQuery({ limit: 200 });
      const rows = await query(sql, params);
      const plans = rows.rows.map((row) => planCleanup(toReaperSession(row), { now: now(), machineOnline: true }));
      const actionable = plans.filter((plan) => plan.action === 'recover_orphan');

      if (!dryRun) {
        for (const plan of actionable) {
          // Archive only. Lease release and process termination belong to the
          // machine-local controller, which verifies the process on its host.
          await query(
            `UPDATE sessions SET phase = 'closed', updated_at = now()
              WHERE session_key = $1 AND phase NOT IN ('closed', 'done', 'cancelled')`,
            [plan.sessionKey],
          );
        }
      }

      const result = {
        ok: true,
        dryRun,
        total: plans.length,
        actionable: actionable.length,
        plans,
      };
      audit.push({ at: new Date().toISOString(), ...result });
      return result;
    } catch (error) {
      log.error?.('reaper cycle failed', error);
      return { ok: false, reason: String(error?.message || error) };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return false;
    timer = setInterval(() => {
      void runOnce();
    }, intervalMs);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return { runOnce, start, stop, audit, isRunning: () => running };
}

module.exports = { createReaperScheduler, toReaperSession, DEFAULT_INTERVAL_MS, MAX_RETRIES };
