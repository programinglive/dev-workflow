/**
 * Owner-side of the cooperative restart handshake.
 *
 * WHY THE OWNER DOES THIS
 * -----------------------
 * An external controller cannot checkpoint or quiesce a live session: the
 * session holds the worktree mutex, and the ownership guard refuses a foreign
 * mutation on purpose. So the owner performs its half here, and the controller
 * performs the half that needs an independent process.
 *
 * WHERE THE RECORD LIVES
 * ----------------------
 * Not in workflow state. Workflow state is loaded from SQLite, and once the
 * mutex is released the normal save path correctly refuses. The handshake
 * therefore keeps its own durable record beside the session state file, written
 * atomically, so a fresh process reads exactly what the owner recorded.
 */
import { releaseWorktreeMutex } from "../../process-lock.js";
import { handleCheckpointTask } from "./checkpoint-handlers.js";
import {
  STATES,
  applyTransition,
  restartReadiness,
} from "../../monitor-server/restart-handshake.cjs";
import { readHandshake, writeHandshake } from "../../monitor-server/restart-handshake-store.cjs";

function stateFileOf(workflowState, options = {}) {
  return options.stateFile || workflowState?.stateFile || null;
}

function loadRecord(workflowState, options = {}) {
  const read = readHandshake(stateFileOf(workflowState, options));
  if (read.status === 'ok') return { record: read.record, corrupt: false };
  if (read.status === 'corrupt') return { record: { state: STATES.REQUESTED, history: [] }, corrupt: true };
  return { record: { state: STATES.REQUESTED, history: [] }, corrupt: false };
}

function save(workflowState, options, record) {
  return writeHandshake(stateFileOf(workflowState, options), record);
}

/**
 * Advance the handshake from the owner's side.
 *
 * @param {object} args
 * @param {string} args.action status|checkpoint|release|cancel
 */
export async function handleRestartHandshake(args = {}, workflowState = null, options = {}) {
  const action = String(args.action || 'status');
  if (!workflowState?.state) return { ok: false, code: 'NO_STATE', note: 'No session state is loaded.' };
  if (!stateFileOf(workflowState, options)) {
    return { ok: false, code: 'NO_STATE_FILE', note: 'This session has no state file to record the handshake in.' };
  }

  const { record, corrupt } = loadRecord(workflowState, options);

  if (action === 'status') {
    return {
      ok: true,
      state: record.state,
      corrupt,
      checkpointConfirmedAt: record.checkpointConfirmedAt || null,
      ownerReleasedAt: record.ownerReleasedAt || null,
      readiness: restartReadiness(record),
      history: record.history || [],
    };
  }

  if (action === 'cancel') {
    const result = applyTransition(record, { next: STATES.CANCELLED, actor: 'owner' });
    if (!result.ok) return { ok: false, code: result.code, note: result.reason };
    save(workflowState, options, result.record);
    return { ok: true, state: result.record.state, note: 'Restart cancelled by the owner.' };
  }

  if (action === 'checkpoint') {
    const acknowledged = applyTransition(record, { next: STATES.OWNER_ACKNOWLEDGED, actor: 'owner' });
    if (!acknowledged.ok) return { ok: false, code: acknowledged.code, note: acknowledged.reason };
    save(workflowState, options, acknowledged.record);

    const runCheckpoint = options.runCheckpoint || handleCheckpointTask;
    const checkpoint = await runCheckpoint(
      { summary: typeof args.summary === 'string' ? args.summary : 'cooperative restart checkpoint' },
      { workflowState, ...(options.checkpoint || {}) },
    );

    if (checkpoint?.confirmed !== true) {
      save(workflowState, options, {
        ...acknowledged.record,
        lastCheckpointError: checkpoint?.note || 'checkpoint not confirmed',
      });
      return {
        ok: false,
        code: 'CHECKPOINT_NOT_CONFIRMED',
        note: checkpoint?.note || 'The checkpoint write was not confirmed by the Zettly read-back.',
        state: acknowledged.record.state,
      };
    }

    const confirmed = applyTransition(acknowledged.record, {
      next: STATES.CHECKPOINT_CONFIRMED,
      actor: 'owner',
      at: Number(args.at) || Date.now(),
      detail: { note: checkpoint.note },
    });
    if (!confirmed.ok) return { ok: false, code: confirmed.code, note: confirmed.reason };

    const next = {
      ...confirmed.record,
      checkpointConfirmedAt: Number(args.at) || Date.now(),
      checkpointNote: checkpoint.note,
    };
    const written = save(workflowState, options, next);
    return {
      ok: true,
      state: next.state,
      persisted: Boolean(written.ok),
      checkpointNote: checkpoint.note,
    };
  }

  if (action === 'release') {
    if (record.state !== STATES.CHECKPOINT_CONFIRMED) {
      return {
        ok: false,
        code: 'CHECKPOINT_REQUIRED',
        note: `ownership can only be released after a confirmed checkpoint; the handshake is at ${record.state}.`,
      };
    }

    const quiesced = applyTransition(record, { next: STATES.QUIESCED, actor: 'owner' });
    if (!quiesced.ok) return { ok: false, code: quiesced.code, note: quiesced.reason };
    save(workflowState, options, quiesced.record);

    const projectDir = workflowState.state.projectDir || '';
    const releaseMutex = options.releaseMutex || releaseWorktreeMutex;
    const released = await releaseMutex(projectDir);
    if (!released) {
      save(workflowState, options, { ...quiesced.record, lastReleaseError: 'releaseWorktreeMutex returned false' });
      return {
        ok: false,
        code: 'RELEASE_NOT_CONFIRMED',
        note: 'The lock mechanism did not confirm the release; ownership is still held.',
        state: quiesced.record.state,
      };
    }

    const released2 = applyTransition(quiesced.record, {
      next: STATES.OWNER_RELEASED,
      actor: 'owner',
      at: Number(args.at) || Date.now(),
    });
    if (!released2.ok) return { ok: false, code: released2.code, note: released2.reason };

    const next = { ...released2.record, ownerReleasedAt: Number(args.at) || Date.now() };
    // The mutex is gone, so the record must be written by the store, not by
    // workflowState.save(). `persisted` is reported only when that write
    // actually succeeded and can be read back.
    const written = save(workflowState, options, next);
    const readBack = written.ok ? readHandshake(stateFileOf(workflowState, options)) : { status: 'absent' };
    const persisted = readBack.status === 'ok' && readBack.record?.state === STATES.OWNER_RELEASED;

    return {
      ok: true,
      state: next.state,
      persisted,
      note: persisted
        ? 'Checkpoint confirmed and ownership released. The controller may now stop this process.'
        : 'Ownership released in memory but the record could not be verified on disk; the controller must not proceed.',
      readiness: restartReadiness(next),
    };
  }

  return { ok: false, code: 'UNKNOWN_ACTION', note: `unknown action "${action}"` };
}
