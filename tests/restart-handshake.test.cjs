'use strict';
// Cooperative restart handshake: the owner does its half, the controller does
// its half, and neither can skip or fake the other's step.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STATES,
  applyTransition,
  canTransition,
  nextStep,
  restartReadiness,
  isTerminal,
} = require('../monitor-server/restart-handshake.cjs');

const AT = 1_800_000_000_000;

function at(state, extra = {}) {
  return { state, updatedAt: AT, history: [], ...extra };
}

test('the happy path advances one state at a time', () => {
  let record = at(STATES.REQUESTED);
  const ownerSteps = [
    STATES.OWNER_ACKNOWLEDGED,
    STATES.CHECKPOINT_CONFIRMED,
    STATES.QUIESCED,
    STATES.OWNER_RELEASED,
  ];
  for (const next of ownerSteps) {
    const result = applyTransition(record, { next, actor: 'owner', at: AT });
    assert.equal(result.ok, true, `${next} must be allowed`);
    record = result.record;
  }
  const controllerSteps = [
    STATES.PROCESS_EXIT_VERIFIED,
    STATES.RELAUNCHED,
    STATES.SESSION_RECOVERED,
    STATES.VERIFIED,
  ];
  for (const next of controllerSteps) {
    const result = applyTransition(record, { next, actor: 'controller', at: AT });
    assert.equal(result.ok, true, `${next} must be allowed`);
    record = result.record;
  }
  assert.equal(record.state, STATES.VERIFIED);
  assert.equal(record.history.length, 8);
});

test('a skipped state is refused', () => {
  const verdict = canTransition({
    current: STATES.REQUESTED,
    next: STATES.CHECKPOINT_CONFIRMED,
    actor: 'owner',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'OUT_OF_ORDER');
});

test('going backwards is refused', () => {
  const verdict = canTransition({
    current: STATES.QUIESCED,
    next: STATES.CHECKPOINT_CONFIRMED,
    actor: 'owner',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'OUT_OF_ORDER');
});

test('the owner cannot perform a controller step', () => {
  const verdict = canTransition({
    current: STATES.OWNER_RELEASED,
    next: STATES.PROCESS_EXIT_VERIFIED,
    actor: 'owner',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'NOT_OWNER_STEP');
});

test('the controller cannot perform an owner step', () => {
  const verdict = canTransition({
    current: STATES.REQUESTED,
    next: STATES.OWNER_ACKNOWLEDGED,
    actor: 'controller',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'NOT_CONTROLLER_STEP');
});

test('only the owner may release ownership', () => {
  const verdict = canTransition({
    current: STATES.QUIESCED,
    next: STATES.OWNER_RELEASED,
    actor: 'controller',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'NOT_CONTROLLER_STEP');
});

test('cancelling is allowed before the process is touched', () => {
  const verdict = canTransition({ current: STATES.QUIESCED, next: STATES.CANCELLED, actor: 'owner' });
  assert.equal(verdict.ok, true);
});

test('cancelling after the stop is refused', () => {
  const verdict = canTransition({
    current: STATES.PROCESS_EXIT_VERIFIED,
    next: STATES.CANCELLED,
    actor: 'owner',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'TOO_LATE_TO_CANCEL');
});

test('failure is allowed from any live state and is terminal', () => {
  for (const current of [STATES.REQUESTED, STATES.QUIESCED, STATES.RELAUNCHED]) {
    const result = applyTransition(at(current), { next: STATES.FAILED, actor: 'controller', at: AT });
    assert.equal(result.ok, true, `${current} can fail`);
    assert.equal(isTerminal(result.record.state), true);
  }
});

test('a terminal handshake cannot advance', () => {
  assert.equal(canTransition({ current: STATES.VERIFIED, next: STATES.FAILED, actor: 'controller' }).ok, false);
  assert.equal(canTransition({ current: STATES.FAILED, next: STATES.VERIFIED, actor: 'controller' }).ok, false);
});

test('an unknown state is refused rather than treated as the start', () => {
  const verdict = canTransition({ current: 'BANANA', next: STATES.OWNER_ACKNOWLEDGED, actor: 'owner' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'UNKNOWN_STATE');
});

test('a refused transition does not mutate the record', () => {
  const record = at(STATES.REQUESTED);
  const result = applyTransition(record, { next: STATES.VERIFIED, actor: 'controller', at: AT });
  assert.equal(result.ok, false);
  assert.equal(record.state, STATES.REQUESTED);
  assert.equal(record.history.length, 0);
});

test('the controller may only restart after the owner released ownership', () => {
  const notYet = restartReadiness(at(STATES.CHECKPOINT_CONFIRMED, { checkpointConfirmedAt: AT }));
  assert.equal(notYet.ok, false);
  assert.equal(notYet.code, 'OWNER_NOT_RELEASED');

  const ready = restartReadiness(
    at(STATES.OWNER_RELEASED, { checkpointConfirmedAt: AT, ownerReleasedAt: AT }),
  );
  assert.equal(ready.ok, true);
  assert.equal(ready.code, 'READY');
});

test('a release without a confirmed checkpoint is not ready', () => {
  const verdict = restartReadiness(at(STATES.OWNER_RELEASED, { ownerReleasedAt: AT }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'CHECKPOINT_NOT_CONFIRMED');
});

test('nextStep walks the happy path and stops at the end', () => {
  assert.equal(nextStep(STATES.REQUESTED), STATES.OWNER_ACKNOWLEDGED);
  assert.equal(nextStep(STATES.SESSION_RECOVERED), STATES.VERIFIED);
  assert.equal(nextStep(STATES.VERIFIED), null);
});
