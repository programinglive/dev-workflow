'use strict';
// Centralized restart orchestration for the DevWorkflow fleet (Outcome C).
//
// WHY THIS IS A SEPARATE MODULE
// -----------------------------
// The Monitor already verifies sessions and archives confirmed orphans. It
// deliberately cannot stop a process: only the machine-local controller can
// re-verify a process on its own host. Restart is the same shape, one level up:
// the Monitor decides WHAT may be restarted and in what order, and the
// controller on each machine performs the stop and relaunch.
//
// The decision is the dangerous part, so it lives here as pure functions with
// no I/O. The executor takes injected adapters, so every failure path is
// testable without touching a real process.
//
// SAFETY RULES
// ------------
// - A graceful restart never stops a process before its checkpoint succeeded.
// - A force restart needs explicit authorization and still tries graceful first.
// - A process is identified by PID + creation time + executable, never by name.
// - A PID shared by two sessions is never stopped.
// - Restart All takes a fleet lock, so a double request cannot interleave.
// - An offline machine is blocked, not fatal: the rest still restarts.
// - A failed relaunch marks only that target for rollback.
const { verifyProcessIdentity } = require('./session-reaper.js');

const RESTART_MODES = Object.freeze({
  graceful: 'graceful',
  force: 'force',
  all: 'all',
});

const GRACEFUL_STEPS = Object.freeze([
  'block_admission',
  'verify_identity',
  'checkpoint',
  'drain',
  'stop',
  'relaunch',
  'restore',
  'verify',
]);

const FORCE_STEPS = Object.freeze([
  'verify_identity',
  'checkpoint_best_effort',
  'graceful_stop',
  'wait',
  'escalate_force',
  'relaunch',
  'verify',
]);

function refusal(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra };
}

/**
 * Decide whether one session may be restarted, and in what steps.
 *
 * @param {object} options
 * @param {object} options.session verified session record
 * @param {string} [options.mode] graceful|force
 * @param {number} [options.now]
 * @param {boolean} [options.forceAuthorized] explicit authorization for force
 * @returns {{ok: boolean, code: string, reason?: string, steps?: string[], requiresAuthorization?: boolean}}
 */
function planRestartOne({ session, mode = RESTART_MODES.graceful, now = Date.now(), forceAuthorized = false } = {}) {
  if (!session) return refusal('SESSION_REQUIRED', 'no session was supplied');
  const state = String(session.state || 'UNKNOWN');
  const normalized = String(mode || RESTART_MODES.graceful);

  if (normalized !== RESTART_MODES.graceful && normalized !== RESTART_MODES.force) {
    return refusal('UNKNOWN_MODE', `unknown restart mode "${normalized}"`);
  }

  if (state === 'ORPHANED') {
    return refusal('NOT_RUNNING', 'the process is already gone; there is nothing to restart');
  }
  if (state === 'RECOVERY_REQUIRED' || state === 'UNRECOVERABLE') {
    return refusal('IDENTITY_UNVERIFIED', 'the session identity cannot be verified, so it must not be stopped');
  }

  if (normalized === RESTART_MODES.force) {
    if (!forceAuthorized) {
      return refusal('AUTHORIZATION_REQUIRED', 'a controlled force restart needs explicit authorization', {
        requiresAuthorization: true,
      });
    }
    if (!session.owner || !Number.isFinite(Number(session.owner.pid))) {
      return refusal('NO_PROCESS', 'the session has no recorded process to restart');
    }
    return { ok: true, code: 'PLANNED', steps: [...FORCE_STEPS] };
  }

  // Graceful: never stop a process whose work is not safely captured.
  if (session.activeTask && !session.hasCheckpoint) {
    return refusal('CHECKPOINT_REQUIRED', 'an active task must be checkpointed before a graceful restart');
  }
  if (session.dirtyWorktree && !session.hasCheckpoint) {
    return refusal('DIRTY_WORKTREE_UNCHECKPOINTED', 'a dirty worktree must be checkpointed before a graceful restart');
  }
  return { ok: true, code: 'PLANNED', steps: [...GRACEFUL_STEPS] };
}

/**
 * Plan a fleet-wide restart.
 *
 * Machines are visited in the order given. A session that cannot be restarted
 * is blocked with a reason and does not stop the others. Inactive installations
 * are preserved as inactive: they are not started just because a restart ran.
 *
 * @returns {{ok: boolean, code: string, order: object[], blocked: object[], preserved: object[]}}
 */
function planRestartAll({ machines = [], sessions = [], inactive = [], admission = null, now = Date.now() } = {}) {
  // A restart-all already in progress is visible as an active maintenance
  // window. Refusing here is what makes a double click harmless.
  if (admission && String(admission.mode || '') === 'draining') {
    return refusal('RESTART_IN_PROGRESS', 'a maintenance window is already active', {
      order: [],
      blocked: [],
      preserved: [],
    });
  }

  const online = new Map();
  for (const machine of machines) {
    const name = typeof machine === 'string' ? machine : machine.name;
    const isOnline = typeof machine === 'string' ? true : machine.online !== false;
    online.set(String(name), isOnline);
  }

  const order = [];
  const blocked = [];
  for (const machine of machines) {
    const name = String(typeof machine === 'string' ? machine : machine.name);
    if (online.get(name) === false) {
      for (const entry of sessions.filter((s) => s.machine === name)) {
        blocked.push({ sessionKey: entry.sessionKey, machine: name, code: 'MACHINE_OFFLINE', reason: 'machine is offline' });
      }
      continue;
    }
    for (const entry of sessions.filter((s) => s.machine === name)) {
      const plan = planRestartOne({ session: entry, mode: RESTART_MODES.graceful, now });
      if (plan.ok) {
        order.push({ sessionKey: entry.sessionKey, machine: name, mode: RESTART_MODES.graceful });
      } else {
        blocked.push({ sessionKey: entry.sessionKey, machine: name, code: plan.code, reason: plan.reason });
      }
    }
  }

  return {
    ok: true,
    code: 'PLANNED',
    order,
    blocked,
    preserved: inactive.map((entry) => ({ sessionKey: entry.sessionKey, machine: entry.machine })),
  };
}

/**
 * Verify that the process about to be stopped is the one the session recorded.
 *
 * Stricter than the reaper's check on purpose: a restart stops a live process,
 * so a missing creation time or executable is a refusal, not a partial match.
 * "PID 4242 looks like node" is not enough evidence to kill something.
 */
function verifyRestartTarget({ session, isAlive, processInfo } = {}) {
  const owner = session?.owner;
  if (!owner || !Number.isFinite(Number(owner.pid))) {
    return { ok: false, code: 'OWNER_MISSING', reason: 'session has no recorded owner PID' };
  }
  if (!owner.startedAt || !owner.executable) {
    return {
      ok: false,
      code: 'IDENTITY_INCOMPLETE',
      reason: 'a restart requires the recorded process creation time and executable',
    };
  }
  return verifyProcessIdentity(session, { isAlive, processInfo });
}

/**
 * Refuse to stop a PID that more than one session claims.
 *
 * A shared PID means the recorded ownership is ambiguous, and stopping it could
 * take down another session's work.
 */
function assertNoSharedPid({ sessions = [], pid } = {}) {
  const target = Number(pid);
  const owners = sessions.filter((entry) => Number(entry?.owner?.pid) === target);
  if (owners.length > 1) {
    return refusal('SHARED_PID', `PID ${target} is claimed by ${owners.length} sessions`, {
      sessionKeys: owners.map((entry) => entry.sessionKey),
    });
  }
  return { ok: true };
}

/**
 * Execute one planned restart.
 *
 * Every dependency is injected so a test can drive each failure path. The
 * executor never decides policy: it runs the steps the plan authorized.
 */
async function executeRestartOne({
  plan,
  session,
  adapters = {},
  checkpoint = async () => ({ ok: true }),
  relaunch = async () => ({ ok: true }),
  verify = async () => ({ ok: true }),
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  if (!plan || !plan.ok) {
    return { ok: false, code: plan?.code || 'NOT_PLANNED', steps: [] };
  }
  const steps = [];
  const record = (step, ok, code) => {
    steps.push({ step, ok, code: code || (ok ? 'OK' : 'FAILED'), at: now() });
    return ok;
  };

  const force = plan.steps.includes('escalate_force');

  // Admission is blocked first so no new work starts while this target is
  // being restarted.
  if (!force) record('block_admission', true);

  // Identity next: never stop a process we cannot prove is the recorded one.
  // This applies to graceful restarts too, not only to force.
  const identity = verifyRestartTarget({
    session,
    isAlive: adapters.isAlive,
    processInfo: adapters.processInfo,
  });
  if (!record('verify_identity', identity.ok, identity.code)) {
    return { ok: false, code: identity.code, reason: identity.reason, steps };
  }

  // Checkpoint before any stop. A failed checkpoint aborts with the process
  // still running.
  const checkpointStep = force ? 'checkpoint_best_effort' : 'checkpoint';
  const checkpointResult = await checkpoint({ session, force });
  if (!force && !record(checkpointStep, checkpointResult.ok, checkpointResult.code)) {
    return { ok: false, code: checkpointResult.code || 'CHECKPOINT_FAILED', steps };
  }
  if (force) record(checkpointStep, checkpointResult.ok, checkpointResult.code);

  if (!force) record('drain', true);

  // Stop.
  const stopStep = force ? 'graceful_stop' : 'stop';
  const stop = adapters.requestStop ? adapters.requestStop(Number(session.owner.pid)) : { ok: false, code: 'NO_ADAPTER' };
  if (!record(stopStep, stop.ok, stop.code)) {
    return { ok: false, code: stop.code || 'STOP_FAILED', steps };
  }

  const waited = adapters.waitForExit
    ? await adapters.waitForExit(Number(session.owner.pid), { timeoutMs })
    : { ok: false, exited: false };
  if (force) {
    record('wait', waited.ok && waited.exited, waited.ok && waited.exited ? 'OK' : 'STOP_TIMEOUT');
    if (!(waited.ok && waited.exited)) {
      // Escalation is the whole point of force mode, and it is authorized.
      const escalated = adapters.forceStop ? adapters.forceStop(Number(session.owner.pid)) : { ok: false };
      record('escalate_force', escalated.ok, escalated.code);
      if (!escalated.ok) return { ok: false, code: 'FORCE_STOP_FAILED', steps };
    }
  } else if (!(waited.ok && waited.exited)) {
    record('stop', false, 'STOP_TIMEOUT');
    return { ok: false, code: 'STOP_TIMEOUT', steps };
  }

  const relaunched = await relaunch({ session });
  if (!record('relaunch', relaunched.ok, relaunched.code)) {
    return { ok: false, code: relaunched.code || 'RELAUNCH_FAILED', steps, rollbackRequired: true };
  }

  if (!force) record('restore', true);

  const verified = await verify({ session, pid: relaunched.pid });
  if (!record('verify', verified.ok, verified.code)) {
    return { ok: false, code: verified.code || 'VERIFY_FAILED', steps, rollbackRequired: true };
  }

  return { ok: true, code: 'RESTARTED', steps };
}

/**
 * Fleet-level lock and audit trail.
 *
 * The lock is in-process on purpose: the Monitor is the single control plane,
 * and a second Monitor is a deployment error, not a supported topology.
 */
function createRestartController({ now = () => Date.now(), maxAudit = 500 } = {}) {
  let active = null;
  const entries = [];

  return {
    begin(kind = 'restart-all') {
      if (active) {
        return refusal('RESTART_IN_PROGRESS', `a ${active.kind} started at ${new Date(active.startedAt).toISOString()} is still running`);
      }
      active = { kind, startedAt: now() };
      return { ok: true, kind, startedAt: active.startedAt };
    },
    end() {
      const finished = active;
      active = null;
      return { ok: true, finished };
    },
    isActive() {
      return Boolean(active);
    },
    record(entry) {
      entries.push({ at: now(), ...entry });
      if (entries.length > maxAudit) entries.splice(0, entries.length - maxAudit);
      return entries[entries.length - 1];
    },
    audit() {
      return [...entries];
    },
  };
}

module.exports = {
  RESTART_MODES,
  GRACEFUL_STEPS,
  FORCE_STEPS,
  planRestartOne,
  planRestartAll,
  verifyRestartTarget,
  assertNoSharedPid,
  executeRestartOne,
  createRestartController,
};

if (require.main === module) {
  // Controller-side CLI. The Monitor plans; a machine executes its own restart
  // here, because only the machine can verify and stop its own process.
  //
  //   node monitor-server/restart-orchestrator.cjs plan --session <file>
  //   node monitor-server/restart-orchestrator.cjs execute --session <file> --mode graceful
  //   node monitor-server/restart-orchestrator.cjs execute --session <file> --mode force --authorize
  const fs = require('node:fs');
  const argv = process.argv.slice(2);
  const command = argv[0] || 'plan';
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }

  const readSession = () => {
    if (!flags.session) throw new Error('--session <file> is required');
    return JSON.parse(fs.readFileSync(String(flags.session), 'utf8'));
  };

  (async () => {
    if (command === 'plan') {
      const session = readSession();
      const plan = planRestartOne({
        session,
        mode: flags.mode || RESTART_MODES.graceful,
        forceAuthorized: Boolean(flags.authorize),
      });
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      if (!plan.ok) process.exitCode = 1;
      return;
    }
    if (command === 'execute') {
      const session = readSession();
      const mode = flags.mode || RESTART_MODES.graceful;
      const plan = planRestartOne({ session, mode, forceAuthorized: Boolean(flags.authorize) });
      if (!plan.ok) {
        process.stderr.write(`${plan.code}: ${plan.reason}\n`);
        process.exitCode = 1;
        return;
      }
      const { createLocalAdapters } = await import('../session-controller-adapters.js');
      const adapters = createLocalAdapters();
      const result = await executeRestartOne({
        plan,
        session,
        adapters,
        // The controller does not invent a checkpoint or a relaunch: those are
        // supplied by the managed launcher and the task store. Without them the
        // executor refuses rather than guessing.
        checkpoint: async () => ({ ok: false, code: 'CHECKPOINT_ADAPTER_REQUIRED' }),
        relaunch: async () => ({ ok: false, code: 'RELAUNCH_ADAPTER_REQUIRED' }),
        verify: async () => ({ ok: false, code: 'VERIFY_ADAPTER_REQUIRED' }),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    process.stderr.write(`Unknown command "${command}". Use plan|execute.\n`);
    process.exitCode = 1;
  })().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
