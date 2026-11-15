'use strict';

/**
 * Authorized Monitor actions for one verified reaper state.
 *
 * The UI must never offer an action the backend will refuse, and the backend
 * must never accept an action the verified state does not authorize. Both
 * sides read this table, so the rule lives in one place.
 *
 * The monitor can verify and archive. It cannot stop a process or release a
 * lease: those need the machine-local controller, which alone can re-verify the
 * process on its own host.
 */

const READ_ONLY_ACTIONS = Object.freeze(['verify', 'checkpoint', 'evidence']);

/** States where archiving is safe: the process is confirmed gone. */
const ARCHIVABLE = Object.freeze(['ORPHANED']);

/** States where a graceful stop may be requested, through the controller. */
const STOPPABLE = Object.freeze(['IDLE']);

function isReadOnly(action) {
  return READ_ONLY_ACTIONS.includes(action);
}

/**
 * @param {string} state one of SESSION_STATES
 * @param {string} action verify|stop|archive|checkpoint|evidence
 * @returns {{ok: boolean, reason?: string, mutate: boolean, controllerRequired?: boolean}}
 */
function planReaperAction(state, action) {
  const normalized = String(action || '').trim();
  const verified = String(state || 'UNKNOWN').trim();

  if (!normalized) return { ok: false, reason: 'ACTION_REQUIRED', mutate: false };

  if (isReadOnly(normalized)) {
    return { ok: true, mutate: false };
  }

  if (normalized === 'archive') {
    if (ARCHIVABLE.includes(verified)) return { ok: true, mutate: true };
    return { ok: false, reason: 'NOT_ORPHANED', state: verified, mutate: false };
  }

  if (normalized === 'stop') {
    if (!STOPPABLE.includes(verified)) {
      return { ok: false, reason: 'NOT_STOPPABLE', state: verified, mutate: false };
    }
    // Even an idle session is stopped by its own machine, never by the monitor.
    return { ok: false, reason: 'CONTROLLER_REQUIRED', state: verified, mutate: false, controllerRequired: true };
  }

  return { ok: false, reason: 'UNKNOWN_ACTION', mutate: false };
}

/**
 * The control set the UI is allowed to render for a verified state.
 *
 * @param {string} state
 * @returns {string[]}
 */
function authorizedActions(state) {
  const verified = String(state || 'UNKNOWN').trim();
  const actions = ['verify', 'checkpoint', 'evidence'];
  if (ARCHIVABLE.includes(verified)) actions.push('archive');
  if (STOPPABLE.includes(verified)) actions.push('stop');
  return actions;
}

module.exports = {
  ARCHIVABLE,
  READ_ONLY_ACTIONS,
  STOPPABLE,
  authorizedActions,
  isReadOnly,
  planReaperAction,
};
