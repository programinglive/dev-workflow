'use strict';
// Centralized restart orchestration (Outcome C).
//
// The owner wants Restart One, Graceful Restart, Controlled Force Restart and
// Restart All from the Monitor. The dangerous part is not the button, it is the
// decision: which process may be stopped, in what order, and what happens when
// a step fails. These tests pin that decision.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  RESTART_MODES,
  planRestartOne,
  planRestartAll,
  verifyRestartTarget,
  assertNoSharedPid,
  executeRestartOne,
  createRestartController,
} = require('../monitor-server/restart-orchestrator.cjs');

const NOW = Date.parse('2026-11-16T00:00:00Z');

function session(overrides = {}) {
  return {
    sessionKey: 'ses_a',
    machine: 'HELLOWORLD',
    state: 'ACTIVE',
    phase: 'coding',
    owner: { pid: 4242, startedAt: '2026-11-15T08:00:00Z', executable: 'node.exe' },
    hasCheckpoint: true,
    dirtyWorktree: false,
    activeTask: true,
    ...overrides,
  };
}

// ------------------------------------------------------------- single target

test('graceful restart of an active session with a checkpoint is allowed', () => {
  const plan = planRestartOne({ session: session(), mode: RESTART_MODES.graceful, now: NOW });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps, [
    'block_admission',
    'verify_identity',
    'checkpoint',
    'drain',
    'stop',
    'relaunch',
    'restore',
    'verify',
  ]);
});

test('graceful restart refuses an active task without a checkpoint', () => {
  const plan = planRestartOne({
    session: session({ hasCheckpoint: false }),
    mode: RESTART_MODES.graceful,
    now: NOW,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'CHECKPOINT_REQUIRED');
});

test('graceful restart refuses a dirty worktree that is not checkpointed', () => {
  const plan = planRestartOne({
    session: session({ dirtyWorktree: true, hasCheckpoint: false, activeTask: false }),
    mode: RESTART_MODES.graceful,
    now: NOW,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'DIRTY_WORKTREE_UNCHECKPOINTED');
});

test('graceful restart refuses a session whose identity cannot be verified', () => {
  const plan = planRestartOne({
    session: session({ state: 'RECOVERY_REQUIRED' }),
    mode: RESTART_MODES.graceful,
    now: NOW,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'IDENTITY_UNVERIFIED');
});

test('restarting an already-orphaned session is refused as nothing to restart', () => {
  const plan = planRestartOne({ session: session({ state: 'ORPHANED' }), mode: RESTART_MODES.graceful, now: NOW });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'NOT_RUNNING');
});

test('force restart requires explicit authorization', () => {
  const plan = planRestartOne({ session: session(), mode: RESTART_MODES.force, now: NOW });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'AUTHORIZATION_REQUIRED');
  assert.equal(plan.requiresAuthorization, true);
});

test('force restart with authorization attempts graceful first, then escalates', () => {
  const plan = planRestartOne({
    session: session(),
    mode: RESTART_MODES.force,
    now: NOW,
    forceAuthorized: true,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps, [
    'verify_identity',
    'checkpoint_best_effort',
    'graceful_stop',
    'wait',
    'escalate_force',
    'relaunch',
    'verify',
  ]);
});

test('force restart still refuses a session with no recorded process', () => {
  const plan = planRestartOne({
    session: session({ owner: null }),
    mode: RESTART_MODES.force,
    now: NOW,
    forceAuthorized: true,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'NO_PROCESS');
});

// --------------------------------------------------------- identity checks

test('a reused PID is refused', () => {
  const verdict = verifyRestartTarget({
    session: session(),
    isAlive: () => true,
    processInfo: () => ({ pid: 4242, startedAt: '2026-11-16T09:00:00Z', executable: 'node.exe' }),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'PID_REUSED');
});

test('a changed executable is refused', () => {
  const verdict = verifyRestartTarget({
    session: session(),
    isAlive: () => true,
    processInfo: () => ({ pid: 4242, startedAt: '2026-11-15T08:00:00Z', executable: 'other.exe' }),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'EXECUTABLE_MISMATCH');
});

test('an incomplete recorded identity is refused before any stop', () => {
  // "PID 4242 looks like node" is not enough evidence to kill a process; the
  // restart path requires the recorded creation time and executable.
  for (const owner of [
    { pid: 4242, startedAt: '', executable: 'node.exe' },
    { pid: 4242, startedAt: '2026-11-15T08:00:00Z', executable: '' },
  ]) {
    const verdict = verifyRestartTarget({
      session: session({ owner }),
      isAlive: () => true,
      processInfo: () => ({ pid: 4242, startedAt: '2026-11-15T08:00:00Z', executable: 'node.exe' }),
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'IDENTITY_INCOMPLETE');
  }
});

test('a PID shared by two sessions is refused', () => {  const verdict = assertNoSharedPid({
    sessions: [session({ sessionKey: 'ses_a' }), session({ sessionKey: 'ses_b' })],
    pid: 4242,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'SHARED_PID');
});

test('a PID owned by one session is allowed', () => {
  const verdict = assertNoSharedPid({ sessions: [session()], pid: 4242 });
  assert.equal(verdict.ok, true);
});

// ------------------------------------------------------------- restart all

test('restart all refuses a second concurrent request', () => {
  const plan = planRestartAll({
    machines: ['HELLOWORLD'],
    sessions: [session()],
    admission: { mode: 'draining', reason: 'restart-all in progress' },
    now: NOW,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'RESTART_IN_PROGRESS');
});

test('restart all orders machines and skips offline ones without failing the rest', () => {
  const plan = planRestartAll({
    machines: [
      { name: 'HELLOWORLD', online: true },
      { name: 'MMCH', online: false },
      { name: 'Mac', online: true },
    ],
    sessions: [
      session({ sessionKey: 'ses_h', machine: 'HELLOWORLD' }),
      session({ sessionKey: 'ses_m', machine: 'MMCH' }),
      session({ sessionKey: 'ses_x', machine: 'Mac' }),
    ],
    admission: null,
    now: NOW,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.order.map((entry) => entry.sessionKey), ['ses_h', 'ses_x']);
  assert.deepEqual(plan.blocked.map((entry) => entry.sessionKey), ['ses_m']);
  assert.equal(plan.blocked[0].code, 'MACHINE_OFFLINE');
});

test('restart all blocks a session that needs a checkpoint but still restarts the rest', () => {
  const plan = planRestartAll({
    machines: [{ name: 'HELLOWORLD', online: true }],
    sessions: [
      session({ sessionKey: 'ses_ok' }),
      session({ sessionKey: 'ses_busy', hasCheckpoint: false }),
    ],
    admission: null,
    now: NOW,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.order.map((entry) => entry.sessionKey), ['ses_ok']);
  assert.equal(plan.blocked[0].sessionKey, 'ses_busy');
  assert.equal(plan.blocked[0].code, 'CHECKPOINT_REQUIRED');
});

test('restart all preserves inactive installations as inactive', () => {
  const plan = planRestartAll({
    machines: [{ name: 'HELLOWORLD', online: true }],
    sessions: [session({ sessionKey: 'ses_live' })],
    inactive: [{ sessionKey: 'ses_off', machine: 'HELLOWORLD' }],
    admission: null,
    now: NOW,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.order.map((entry) => entry.sessionKey), ['ses_live']);
  assert.deepEqual(plan.preserved.map((entry) => entry.sessionKey), ['ses_off']);
});

// --------------------------------------------------------------- execution

function fakeAdapters(overrides = {}) {
  const calls = [];
  return {
    calls,
    isAlive: () => true,
    processInfo: () => ({ pid: 4242, startedAt: '2026-11-15T08:00:00Z', executable: 'node.exe' }),
    requestStop: () => { calls.push('requestStop'); return { ok: true }; },
    forceStop: () => { calls.push('forceStop'); return { ok: true }; },
    waitForExit: async () => { calls.push('waitForExit'); return { ok: true, exited: true }; },
    ...overrides,
  };
}

test('a graceful restart runs every step in order', async () => {
  const adapters = fakeAdapters();
  const result = await executeRestartOne({
    plan: planRestartOne({ session: session(), mode: RESTART_MODES.graceful, now: NOW }),
    session: session(),
    adapters,
    checkpoint: async () => ({ ok: true }),
    relaunch: async () => ({ ok: true, pid: 5000 }),
    verify: async () => ({ ok: true }),
    now: () => NOW,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.step), [
    'block_admission',
    'verify_identity',
    'checkpoint',
    'drain',
    'stop',
    'relaunch',
    'restore',
    'verify',
  ]);
  assert.ok(adapters.calls.includes('requestStop'));
});

test('a checkpoint failure aborts before any process is stopped', async () => {
  const adapters = fakeAdapters();
  const result = await executeRestartOne({
    plan: planRestartOne({ session: session(), mode: RESTART_MODES.graceful, now: NOW }),
    session: session(),
    adapters,
    checkpoint: async () => ({ ok: false, code: 'CHECKPOINT_FAILED' }),
    relaunch: async () => ({ ok: true }),
    verify: async () => ({ ok: true }),
    now: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHECKPOINT_FAILED');
  assert.equal(adapters.calls.includes('requestStop'), false, 'nothing may be stopped after a failed checkpoint');
});

test('a process identity mismatch aborts before stopping', async () => {
  const adapters = fakeAdapters({
    processInfo: () => ({ pid: 4242, startedAt: '2026-11-16T09:00:00Z', executable: 'node.exe' }),
  });
  const result = await executeRestartOne({
    plan: planRestartOne({ session: session(), mode: RESTART_MODES.graceful, now: NOW }),
    session: session(),
    adapters,
    checkpoint: async () => ({ ok: true }),
    relaunch: async () => ({ ok: true }),
    verify: async () => ({ ok: true }),
    now: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PID_REUSED');
  assert.equal(adapters.calls.includes('requestStop'), false);
});

test('a stop timeout escalates only in force mode', async () => {
  const adapters = fakeAdapters({ waitForExit: async () => ({ ok: false, exited: false }) });
  const graceful = await executeRestartOne({
    plan: planRestartOne({ session: session(), mode: RESTART_MODES.graceful, now: NOW }),
    session: session(),
    adapters,
    checkpoint: async () => ({ ok: true }),
    relaunch: async () => ({ ok: true }),
    verify: async () => ({ ok: true }),
    now: () => NOW,
  });
  assert.equal(graceful.ok, false);
  assert.equal(graceful.code, 'STOP_TIMEOUT');

  const forced = await executeRestartOne({
    plan: planRestartOne({ session: session(), mode: RESTART_MODES.force, now: NOW, forceAuthorized: true }),
    session: session(),
    adapters,
    checkpoint: async () => ({ ok: true }),
    relaunch: async () => ({ ok: true }),
    verify: async () => ({ ok: true }),
    now: () => NOW,
  });
  assert.equal(forced.ok, true);
  assert.ok(forced.steps.some((step) => step.step === 'escalate_force' && step.ok));
});

test('a failed relaunch is reported and the target is marked for rollback', async () => {
  const result = await executeRestartOne({
    plan: planRestartOne({ session: session(), mode: RESTART_MODES.graceful, now: NOW }),
    session: session(),
    adapters: fakeAdapters(),
    checkpoint: async () => ({ ok: true }),
    relaunch: async () => ({ ok: false, code: 'RELAUNCH_FAILED' }),
    verify: async () => ({ ok: true }),
    now: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RELAUNCH_FAILED');
  assert.equal(result.rollbackRequired, true);
});

test('a restart-all controller refuses a double request and releases the lock', async () => {
  const controller = createRestartController({ now: () => NOW });
  const first = controller.begin('restart-all');
  assert.equal(first.ok, true);
  const second = controller.begin('restart-all');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'RESTART_IN_PROGRESS');
  controller.end();
  assert.equal(controller.begin('restart-all').ok, true);
  controller.end();
});

test('the controller records an audit entry for every attempt', async () => {
  const controller = createRestartController({ now: () => NOW });
  controller.begin('restart-all');
  controller.record({ sessionKey: 'ses_a', ok: true, code: 'RESTARTED' });
  controller.end();
  const audit = controller.audit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].sessionKey, 'ses_a');
  assert.equal(audit[0].code, 'RESTARTED');
});

// ------------------------------------------------------------- control surface

test('the Monitor exposes the restart control surface', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'monitor-server', 'dashboard.cjs'), 'utf8');
  assert.match(source, /'\/api\/fleet\/restart'/, 'the restart endpoint must exist');
  assert.match(source, /'\/api\/fleet\/restart\/status'/, 'the status endpoint must exist');
  assert.match(source, /'\/api\/fleet\/restart\/audit'/, 'the audit endpoint must exist');
  // Privileged: the endpoint must require the write token, not just be reachable.
  const route = source.slice(source.indexOf("'/api/fleet/restart'"));
  assert.match(route.slice(0, 1500), /writeAllowed\(req\)/, 'the restart endpoint must require authorization');
});
