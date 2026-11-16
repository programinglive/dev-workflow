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
 * The owner may only advance its own states. It cannot record that the process
 * exited or that the runtime recovered, because it cannot see that honestly.
 */
import { releaseWorktreeMutex } from "../../process-lock.js";
import { handleCheckpointTask } from "./checkpoint-handlers.js";
import {
  STATES,
  applyTransition,
  restartReadiness,
} from "../../monitor-server/restart-handshake.cjs";

function current(workflowState) {
  const record = workflowState?.state?.restartHandshake;
  return record && typeof record === "object" ? record : { state: STATES.REQUESTED, history: [] };
}

async function persist(workflowState, record) {
  if (!workflowState?.state) return false;
  workflowState.state.restartHandshake = record;
  if (typeof workflowState.save === "function") {
    await workflowState.save();
    return true;
  }
  return false;
}

/**
 * Persist the release record after the mutex is gone.
 *
 * `workflowState.save()` correctly refuses once this process is no longer the
 * owner. The release record still has to survive for the controller, so it is
 * written atomically straight to the state file. This is the only write allowed
 * to bypass the ownership guard, and only because it records the release that
 * just happened.
 */
async function persistAfterRelease(workflowState, record, options = {}) {
  if (workflowState?.state) workflowState.state.restartHandshake = record;
  const fs = await import("node:fs");
  const path = await import("node:path");
  let file = options.stateFile || workflowState?.stateFile || null;
  if (!file) {
    try {
      const mod = await import("../../workflow-state.js");
      file = mod.resolveStateFile({ sessionId: workflowState?.sessionId || null, skipMigrationWrites: true });
    } catch {
      file = null;
    }
  }
  if (!file) return false;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(workflowState.state, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

/**
 * Advance the handshake from the owner's side.
 *
 * @param {object} args
 * @param {string} args.action status|checkpoint|release|cancel
 * @returns {Promise<object>}
 */
export async function handleRestartHandshake(args = {}, workflowState = null, options = {}) {
  const action = String(args.action || "status");
  const state = workflowState?.state;
  if (!state) return { ok: false, code: 'NO_STATE', note: 'No session state is loaded.' };

  const record = current(workflowState);

  if (action === 'status') {
    return {
      ok: true,
      state: record.state,
      checkpointConfirmedAt: record.checkpointConfirmedAt || null,
      ownerReleasedAt: record.ownerReleasedAt || null,
      readiness: restartReadiness(record),
      history: record.history || [],
    };
  }

  if (action === 'cancel') {
    const result = applyTransition(record, { next: STATES.CANCELLED, actor: 'owner' });
    if (!result.ok) return { ok: false, code: result.code, note: result.reason };
    await persist(workflowState, result.record);
    return { ok: true, state: result.record.state, note: 'Restart cancelled by the owner.' };
  }

  if (action === 'checkpoint') {
    // Acknowledge first, so the record shows the owner engaged even if the
    // checkpoint itself fails. Failure is durable and auditable.
    const acknowledged = applyTransition(record, { next: STATES.OWNER_ACKNOWLEDGED, actor: 'owner' });
    if (!acknowledged.ok) return { ok: false, code: acknowledged.code, note: acknowledged.reason };

    const runCheckpoint = options.runCheckpoint || handleCheckpointTask;
    const checkpoint = await runCheckpoint(
      { summary: typeof args.summary === 'string' ? args.summary : 'cooperative restart checkpoint' },
      { workflowState, ...(options.checkpoint || {}) },
    );

    if (checkpoint?.confirmed !== true) {
      // Do not record CHECKPOINT_CONFIRMED. The restart must abort here.
      await persist(workflowState, {
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
    await persist(workflowState, next);
    return { ok: true, state: next.state, checkpointNote: checkpoint.note };
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
    await persist(workflowState, quiesced.record);

    // Release through the official path. It returns false when this process
    // does not hold the mutex, which must not be recorded as released.
    const projectDir = state.projectDir || '';
    const releaseMutex = options.releaseMutex || releaseWorktreeMutex;
    const released = await releaseMutex(projectDir);
    if (!released) {
      await persist(workflowState, {
        ...quiesced.record,
        lastReleaseError: 'releaseWorktreeMutex returned false',
      });
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
    // The mutex is gone now, so the normal save path correctly refuses: this
    // process is no longer the owner. The record still has to survive for the
    // controller, so it is written atomically straight to the state file. That
    // is the one write that is allowed to bypass the guard, because it is the
    // record OF the release itself.
    const written = await persistAfterRelease(workflowState, next, options);
    return {
      ok: true,
      state: next.state,
      persisted: written,
      note: 'Checkpoint confirmed and ownership released. The controller may now stop this process.',
      readiness: restartReadiness(next),
    };
  }

  return { ok: false, code: 'UNKNOWN_ACTION', note: `unknown action "${action}"` };
}
