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
const {
  buildReconcileQuery,
  revalidateAttestation,
} = require('./reaper-attestation.cjs');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RETRIES = 3;

/**
 * Newest unconsumed attestation per session.
 *
 * Only attestations the endpoint already accepted are stored, so this query
 * does not re-verify the signature. It does re-verify the binding, because the
 * row may have changed since the attestation arrived.
 */
function buildAttestationQuery({ limit = 500 } = {}) {
  const bounded = Math.min(1000, Math.max(1, Number(limit) || 500));
  return {
    sql: `SELECT DISTINCT ON (session_key)
                 session_key, machine, project_name, pid, process_started_at,
                 process_executable, lease_owner, lease_generation,
                 lease_fencing_token, verified_at, nonce
            FROM reaper_attestations
           WHERE consumed_at IS NULL
           ORDER BY session_key, received_at DESC
           LIMIT $1`,
    params: [bounded],
  };
}

function attestationFromRow(row) {
  return {
    machine: String(row.machine || ''),
    sessionKey: String(row.session_key || ''),
    projectName: String(row.project_name || ''),
    pid: Number(row.pid),
    startedAt: String(row.process_started_at || ''),
    executable: String(row.process_executable || ''),
    leaseOwner: String(row.lease_owner || ''),
    leaseGeneration: Number(row.lease_generation) || 0,
    leaseFencingToken: String(row.lease_fencing_token || ''),
    verifiedAt: row.verified_at,
    nonce: String(row.nonce || ''),
  };
}

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
  retries = MAX_RETRIES,
  baseDelayMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let running = false;
  let timer = null;
  const audit = [];

  async function loadReaper() {
    if (reaper) return reaper;
    return import('./session-reaper.js');
  }

  /**
   * Bounded retry with exponential backoff.
   *
   * A transient database error must not turn into a permanently skipped cycle,
   * and it must not turn into an unbounded retry loop either. The attempt count
   * is returned so the audit trail shows how hard the cycle tried.
   */
  async function withRetry(fn) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return { ok: true, value: await fn(), attempts: attempt + 1 };
      } catch (error) {
        lastError = error;
        if (attempt < retries) await sleep(baseDelayMs * 2 ** attempt);
      }
    }
    return { ok: false, error: lastError, attempts: retries + 1 };
  }

  async function runOnce() {
    if (running) return { ok: false, reason: 'ALREADY_RUNNING' };
    running = true;
    try {
      const { planCleanup } = await loadReaper();
      const { sql, params } = buildReaperSessionsQuery({ limit: 200 });
      const loaded = await withRetry(() => query(sql, params));
      if (!loaded.ok) {
        const failure = {
          ok: false,
          reason: String(loaded.error?.message || loaded.error),
          attempts: loaded.attempts,
        };
        audit.push({ at: new Date().toISOString(), ...failure });
        log.error?.('reaper cycle failed', loaded.error);
        return failure;
      }

      const rows = loaded.value;

      // Attestations are optional: a monitor without migration 006 still runs,
      // it simply has no verified orphan evidence and archives nothing.
      let attestations = new Map();
      try {
        const aq = buildAttestationQuery({ limit: 500 });
        const ar = await query(aq.sql, aq.params);
        for (const row of ar.rows) attestations.set(row.session_key, attestationFromRow(row));
      } catch (error) {
        log.warn?.('reaper attestation query unavailable', String(error && error.message || error));
      }

      const plans = rows.rows.map((row) => {
        const attestation = attestations.get(row.session_key);
        if (attestation) {
          // Revalidate against the current row AND the current clock: a stored
          // attestation older than the TTL is not evidence of anything now.
          const verdict = revalidateAttestation(attestation, row, { now: now() });
          if (verdict.ok) {
            // Verified by the machine that owns the process. This is the only
            // path that can produce ORPHANED, because the monitor cannot see
            // another host's process table.
            return {
              sessionKey: row.session_key,
              machine: row.machine,
              project: row.project_name,
              state: 'ORPHANED',
              reason: `attested by ${attestation.machine} at ${attestation.verifiedAt}`,
              action: 'recover_orphan',
              kill: false,
              releaseLease: Boolean(attestation.leaseOwner),
              archive: true,
              requiresAuthorization: false,
              attestation,
            };
          }
          return {
            sessionKey: row.session_key,
            machine: row.machine,
            project: row.project_name,
            state: 'RECOVERY_REQUIRED',
            reason: `attestation rejected: ${verdict.reason}`,
            action: 'hold',
            kill: false,
            releaseLease: false,
            archive: false,
            requiresAuthorization: true,
            attestation,
          };
        }
        return planCleanup(toReaperSession(row), { now: now(), machineOnline: true });
      });

      const actionable = plans.filter((plan) => plan.action === 'recover_orphan');

      const applied = [];
      if (!dryRun) {
        for (const plan of actionable) {
          const attestation = plan.attestation;
          if (!attestation) continue;

          // One statement: archive, lease release and attestation consumption
          // happen in a single transaction. The outcome is read back rather
          // than assumed, so a lost compare-and-swap is reported honestly and
          // the attestation is always consumed.
          const reconcile = buildReconcileQuery(attestation);
          const result = await query(reconcile.sql, reconcile.params);
          const row = Array.isArray(result?.rows) ? result.rows[0] : null;

          applied.push({
            sessionKey: plan.sessionKey,
            archived: Number(row?.archived || 0) > 0,
            leaseReleased: Number(row?.released || 0) > 0,
            leaseReason: !attestation.leaseOwner
              ? 'NO_LEASE'
              : Number(row?.released || 0) > 0
                ? 'RELEASED'
                : 'NOT_RELEASED',
            outcome: String(row?.outcome || 'unknown'),
          });
        }
      }

      const result = {
        ok: true,
        dryRun,
        total: plans.length,
        actionable: actionable.length,
        attested: plans.filter((plan) => plan.attestation).length,
        applied,
        attempts: loaded.attempts,
        plans,
      };
      audit.push({ at: new Date().toISOString(), ...result });
      return result;
    } catch (error) {
      log.error?.('reaper cycle failed', error);
      return { ok: false, reason: String(error?.message || error) };
    } finally {
      // Always released, so an interrupted or failed cycle cannot leave the
      // scheduler permanently stuck in ALREADY_RUNNING.
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

module.exports = {
  buildAttestationQuery,
  attestationFromRow,
  createReaperScheduler,
  toReaperSession,
  DEFAULT_INTERVAL_MS,
  MAX_RETRIES,
};
