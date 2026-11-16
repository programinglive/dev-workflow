'use strict';
// Cooperative restart handshake.
//
// WHY COOPERATIVE
// ---------------
// An external controller cannot checkpoint a live session: the session holds
// the worktree mutex, and the ownership guard refuses a foreign mutation on
// purpose. So the restart cannot be driven from outside. The owner has to do
// the part only the owner can do (checkpoint, quiesce, release), and the
// controller does the part only an independent process can do (verify, stop,
// relaunch, verify again).
//
// The handshake is the contract between those two halves. Every transition is
// recorded, and a transition that is not listed here does not exist: the state
// machine refuses it rather than letting a half-restart look successful.
//
// FAILURE IS A STATE, NOT AN ABSENCE
// ----------------------------------
// A failed restart keeps its last confirmed state and a reason. That is what
// lets an operator tell "the owner never acknowledged" from "the process exited
// but the relaunch failed" without reading logs.

const STATES = Object.freeze({
  REQUESTED: 'REQUESTED',
  OWNER_ACKNOWLEDGED: 'OWNER_ACKNOWLEDGED',
  CHECKPOINT_CONFIRMED: 'CHECKPOINT_CONFIRMED',
  QUIESCED: 'QUIESCED',
  OWNER_RELEASED: 'OWNER_RELEASED',
  PROCESS_EXIT_VERIFIED: 'PROCESS_EXIT_VERIFIED',
  RELAUNCHED: 'RELAUNCHED',
  SESSION_RECOVERED: 'SESSION_RECOVERED',
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

// The happy path, in order. The index is used to refuse going backwards and to
// answer "what is the next step" without a second table to keep in sync.
const ORDER = Object.freeze([
  STATES.REQUESTED,
  STATES.OWNER_ACKNOWLEDGED,
  STATES.CHECKPOINT_CONFIRMED,
  STATES.QUIESCED,
  STATES.OWNER_RELEASED,
  STATES.PROCESS_EXIT_VERIFIED,
  STATES.RELAUNCHED,
  STATES.SESSION_RECOVERED,
  STATES.VERIFIED,
]);

const TERMINAL = Object.freeze([STATES.VERIFIED, STATES.FAILED, STATES.CANCELLED]);

// Which states each side may drive. The owner can only move its own half; the
// controller can only move the half that needs an independent process. This is
// the rule that stops one side from faking the other's work.
const OWNER_DRIVEN = new Set([
  STATES.OWNER_ACKNOWLEDGED,
  STATES.CHECKPOINT_CONFIRMED,
  STATES.QUIESCED,
  STATES.OWNER_RELEASED,
]);

const CONTROLLER_DRIVEN = new Set([
  STATES.PROCESS_EXIT_VERIFIED,
  STATES.RELAUNCHED,
  STATES.SESSION_RECOVERED,
  STATES.VERIFIED,
]);

function isTerminal(state) {
  return TERMINAL.includes(String(state));
}

function indexOf(state) {
  return ORDER.indexOf(String(state));
}

/**
 * The single step that may follow `current` on the happy path.
 * Returns null at the end.
 */
function nextStep(current) {
  const index = indexOf(current);
  if (index < 0 || index === ORDER.length - 1) return null;
  return ORDER[index + 1];
}

/**
 * Decide whether one transition is allowed.
 *
 * @param {object} options
 * @param {string} options.current current handshake state
 * @param {string} options.next requested next state
 * @param {"owner"|"controller"} options.actor who is asking
 * @returns {{ok: boolean, code: string, reason?: string}}
 */
function canTransition({ current, next, actor } = {}) {
  const from = String(current || '');
  const to = String(next || '');
  const who = String(actor || '');

  if (indexOf(from) < 0) {
    return { ok: false, code: 'UNKNOWN_STATE', reason: `unknown handshake state "${from}"` };
  }
  if (from === STATES.VERIFIED) return { ok: false, code: 'ALREADY_COMPLETED' };
  if (from === STATES.CANCELLED) return { ok: false, code: 'ALREADY_CANCELLED' };
  if (from === STATES.FAILED) return { ok: false, code: 'ALREADY_FAILED' };

  if (to === STATES.FAILED) return { ok: true, code: 'OK' };
  if (to === STATES.CANCELLED) {
    // Only the owner may cancel its own restart before the process is touched.
    if (indexOf(from) >= indexOf(STATES.PROCESS_EXIT_VERIFIED)) {
      return { ok: false, code: 'TOO_LATE_TO_CANCEL', reason: 'the process has already been stopped' };
    }
    return { ok: true, code: 'OK' };
  }

  if (who === 'owner' && !OWNER_DRIVEN.has(to)) {
    return { ok: false, code: 'NOT_OWNER_STEP', reason: `"${to}" is the controller's step, not the owner's` };
  }
  if (who === 'controller' && !CONTROLLER_DRIVEN.has(to)) {
    return { ok: false, code: 'NOT_CONTROLLER_STEP', reason: `"${to}" is the owner's step, not the controller's` };
  }

  // Strictly forward, one step at a time: a skipped state is an unproven step.
  if (nextStep(from) !== to) {
    return {
      ok: false,
      code: 'OUT_OF_ORDER',
      reason: `expected ${nextStep(from) || 'no further step'} after ${from}, got ${to}`,
    };
  }

  return { ok: true, code: 'OK' };
}

/**
 * Apply a transition, returning a new record. Never mutates the input, so a
 * caller can persist first and replace only after the write succeeded.
 */
function applyTransition(record = {}, { next, actor, at = Date.now(), detail = null } = {}) {
  const verdict = canTransition({ current: record.state, next, actor });
  if (!verdict.ok) {
    return { ok: false, code: verdict.code, reason: verdict.reason, record };
  }
  const history = Array.isArray(record.history) ? [...record.history] : [];
  history.push({ state: next, actor, at, ...(detail ? { detail } : {}) });
  return {
    ok: true,
    code: 'OK',
    record: {
      ...record,
      state: String(next),
      updatedAt: at,
      actor,
      ...(detail ? { detail } : {}),
      history,
    },
  };
}

/**
 * Why a restart may proceed right now, or why it may not.
 *
 * The controller checks this before it touches a process. Each precondition
 * maps to an earlier transition, so "ready" is never a guess.
 */
function restartReadiness(record = {}) {
  const state = String(record.state || '');
  const index = indexOf(state);
  if (index < 0) return { ok: false, code: 'UNKNOWN_STATE' };
  if (state !== STATES.OWNER_RELEASED) {
    return {
      ok: false,
      code: 'OWNER_NOT_RELEASED',
      reason: `the owner reached ${state}; a restart needs ${STATES.OWNER_RELEASED}`,
    };
  }
  if (!record.checkpointConfirmedAt) {
    return { ok: false, code: 'CHECKPOINT_NOT_CONFIRMED', reason: 'no confirmed checkpoint is recorded' };
  }
  if (!record.ownerReleasedAt) {
    return { ok: false, code: 'RELEASE_NOT_RECORDED', reason: 'the ownership release is not recorded' };
  }
  return { ok: true, code: 'READY', state };
}

/**
 * A stable fingerprint of the task a handover transfers.
 *
 * The handover binds this at release and adoption recomputes it from the source
 * JSON, so a changed or stale file with the same session key cannot supply a
 * different task, DoD, plan, or evidence.
 */
function stateFingerprint(state) {
  const crypto = require('node:crypto');
  const subset = {
    taskDescription: state?.taskDescription || '',
    workflowTaskId: state?.workflowTaskId || '',
    currentPhase: state?.currentPhase || 'idle',
    dodRevision: Number(state?.dodRevision) || 0,
    definitionOfDone: state?.definitionOfDone || [],
    plan: state?.plan || [],
    zettly: state?.zettly || null,
    machine: state?.machine || '',
    projectDir: state?.projectDir || '',
    repository: state?.repository || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(subset)).digest('hex');
}

module.exports = {
  STATES,
  ORDER,
  TERMINAL,
  OWNER_DRIVEN,
  CONTROLLER_DRIVEN,
  isTerminal,
  nextStep,
  canTransition,
  applyTransition,
  restartReadiness,
  stateFingerprint,
};
