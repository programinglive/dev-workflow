'use strict';
// Durable restart command queue (Outcome C dispatch).
//
// The Monitor decides, the machine controller executes. Between them is this
// queue: one row per target, polled by the controller that owns the machine.
// The queue is durable so a Monitor restart or a controller that is briefly
// offline does not lose a command.
//
// The queue deliberately has no "execute" function. It only moves rows from
// pending to done or failed. Execution lives in restart-orchestrator.cjs and
// runs on the machine, because only that machine can verify its own process.
const RESTART_COMMAND_STATUS = Object.freeze({
  pending: 'pending',
  claimed: 'claimed',
  done: 'done',
  failed: 'failed',
});

// A claim older than this is considered abandoned and may be taken again. Long
// enough for one restart, short enough that a crashed controller does not block
// the target forever.
const CLAIM_STALE_MS = 15 * 60 * 1000;

const MODES = new Set(['graceful', 'force']);
const MAX_PENDING = 100;
const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MACHINE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function refusal(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Validate targets before anything is written. A row that cannot be executed
 * must never reach the queue.
 */
function validateEnqueue(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return refusal('COMMANDS_REQUIRED', 'at least one restart target is required');
  }
  if (commands.length > MAX_PENDING) {
    return refusal('TOO_MANY_COMMANDS', `at most ${MAX_PENDING} targets may be enqueued at once`);
  }
  for (const command of commands) {
    const machine = typeof command?.machine === 'string' ? command.machine.trim() : '';
    if (!MACHINE_PATTERN.test(machine)) return refusal('MACHINE_REQUIRED', 'each target needs a valid machine');
    if (!MODES.has(String(command?.mode || ''))) {
      return refusal('UNKNOWN_MODE', `unknown restart mode "${command?.mode}"`);
    }
    if (typeof command?.sessionKey !== 'string' || !SESSION_KEY_PATTERN.test(command.sessionKey)) {
      return refusal('INVALID_SESSION_KEY', 'each target needs a valid session key');
    }
  }
  return { ok: true };
}

function buildCommandsTableSql() {
  return `CREATE TABLE IF NOT EXISTS restart_commands (
    id bigserial PRIMARY KEY,
    machine text NOT NULL,
    session_key text NOT NULL,
    mode text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    completed_at timestamptz,
    result_code text,
    result_detail jsonb
  );
  CREATE UNIQUE INDEX IF NOT EXISTS restart_commands_open_unique
    ON restart_commands (machine, session_key, mode)
    WHERE status IN ('pending', 'claimed');
  CREATE INDEX IF NOT EXISTS restart_commands_pending
    ON restart_commands (machine, status, created_at);
  CREATE INDEX IF NOT EXISTS restart_commands_session
    ON restart_commands (session_key, created_at DESC);`;
}

/**
 * Enqueue one row per target.
 *
 * `ON CONFLICT DO NOTHING` makes a repeated Restart All idempotent: a target
 * that is already pending is not queued twice.
 */
function buildEnqueueQuery(commands) {
  const params = [];
  const values = [];
  for (const command of commands) {
    const base = params.length;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    params.push(command.machine, command.sessionKey, command.mode);
  }
  return {
    sql: `INSERT INTO restart_commands (machine, session_key, mode)
          VALUES ${values.join(', ')}
          ON CONFLICT DO NOTHING
          RETURNING id, machine, session_key, mode`,
    params,
  };
}

/** Pending commands for exactly one machine. */
function buildPendingQuery({ machine, limit = 20 } = {}) {
  const bounded = Math.min(MAX_PENDING, Math.max(1, Number(limit) || 20));
  return {
    sql: `SELECT id, machine, session_key, mode, created_at
            FROM restart_commands
           WHERE machine = $1
             AND status = 'pending'
           ORDER BY created_at
           LIMIT $2`,
    params: [String(machine), bounded],
  };
}

/**
 * Claim one command before executing it.
 *
 * The poll only lists `pending` rows; without a claim two controllers (or one
 * controller that restarts after executing but before reporting) would run the
 * same command twice. The claim is a compare-and-swap: a row can be claimed
 * only while it is pending, or while a previous claim is stale because that
 * controller died. `RETURNING id` being empty means someone else owns it.
 */
function buildClaimQuery({ id, machine, staleMs = CLAIM_STALE_MS } = {}) {
  const stale = Math.max(60_000, Number(staleMs) || CLAIM_STALE_MS);
  return {
    sql: `UPDATE restart_commands
             SET status = 'claimed', claimed_at = now()
           WHERE id = $1
             AND machine = $2
             AND (status = 'pending'
                  OR (status = 'claimed' AND claimed_at < now() - ($3::bigint * interval '1 millisecond')))
           RETURNING id`,
    params: [Number(id), String(machine), stale],
  };
}

/**
 * Record the outcome of one command.
 *
 * The update applies while the row is `pending` or `claimed`, so a resumed
 * controller can still report, but never twice: after the first report the row
 * is terminal and a replay is a no-op. The `machine` predicate means one
 * controller cannot report another machine's command.
 */
function buildCompleteQuery({ id, machine, status, code, detail } = {}) {
  const terminal = status === RESTART_COMMAND_STATUS.done || status === RESTART_COMMAND_STATUS.failed;
  if (!terminal) throw new Error('restart command status must be a terminal state');
  return {
    sql: `UPDATE restart_commands
             SET status = $3,
                 completed_at = now(),
                 result_code = $4,
                 result_detail = $5::jsonb
           WHERE id = $1 AND machine = $2 AND status IN ('pending', 'claimed')
           RETURNING id`,
    params: [
      Number(id),
      String(machine),
      status,
      String(code || '').slice(0, 120),
      JSON.stringify(detail ?? null),
    ],
  };
}

module.exports = {
  RESTART_COMMAND_STATUS,
  MAX_PENDING,
  validateEnqueue,
  buildCommandsTableSql,
  buildEnqueueQuery,
  buildPendingQuery,
  buildClaimQuery,
  buildCompleteQuery,
  CLAIM_STALE_MS,
};
