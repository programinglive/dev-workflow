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
  if (read.status === "ok") return { record: read.record, corrupt: false };
  if (read.status === "corrupt") return { record: { state: STATES.REQUESTED, history: [] }, corrupt: true };
  return { record: { state: STATES.REQUESTED, history: [] }, corrupt: false };
}

function save(workflowState, options, record) {
  return writeHandshake(stateFileOf(workflowState, options), record);
}

function samePath(a, b) {
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Advance the handshake.
 *
 * @param {object} args
 * @param {string} args.action status|checkpoint|release|cancel|claim
 */
export async function handleRestartHandshake(args = {}, workflowState = null, options = {}) {
  const action = String(args.action || "status");
  if (!workflowState?.state) return { ok: false, code: "NO_STATE", note: "No session state is loaded." };
  if (!stateFileOf(workflowState, options)) {
    return { ok: false, code: "NO_STATE_FILE", note: "This session has no state file to record the handshake in." };
  }

  const { record, corrupt } = loadRecord(workflowState, options);

  if (action === "status") {
    return {
      ok: true,
      state: record.state,
      corrupt,
      checkpointConfirmedAt: record.checkpointConfirmedAt || null,
      ownerReleasedAt: record.ownerReleasedAt || null,
      handler: record.handover || null,
      claimedBy: record.claimedBy || null,
      readiness: restartReadiness(record),
      history: record.history || [],
    };
  }

  if (action === "cancel") {
    const result = applyTransition(record, { next: STATES.CANCELLED, actor: "owner" });
    if (!result.ok) return { ok: false, code: result.code, note: result.reason };
    save(workflowState, options, result.record);
    return { ok: true, state: result.record.state, note: "Restart cancelled by the owner." };
  }

  if (action === "checkpoint") {
    const acknowledged = applyTransition(record, { next: STATES.OWNER_ACKNOWLEDGED, actor: "owner" });
    if (!acknowledged.ok) return { ok: false, code: acknowledged.code, note: acknowledged.reason };
    save(workflowState, options, acknowledged.record);

    const runCheckpoint = options.runCheckpoint || handleCheckpointTask;
    const checkpoint = await runCheckpoint(
      { summary: typeof args.summary === "string" ? args.summary : "cooperative restart checkpoint" },
      { workflowState, ...(options.checkpoint || {}) },
    );

    if (checkpoint?.confirmed !== true) {
      save(workflowState, options, {
        ...acknowledged.record,
        lastCheckpointError: checkpoint?.note || "checkpoint not confirmed",
      });
      return {
        ok: false,
        code: "CHECKPOINT_NOT_CONFIRMED",
        note: checkpoint?.note || "The checkpoint write was not confirmed by the Zettly read-back.",
        state: acknowledged.record.state,
      };
    }

    const confirmed = applyTransition(acknowledged.record, {
      next: STATES.CHECKPOINT_CONFIRMED,
      actor: "owner",
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

  if (action === "release") {
    if (record.state !== STATES.CHECKPOINT_CONFIRMED) {
      return {
        ok: false,
        code: "CHECKPOINT_REQUIRED",
        note: `ownership can only be released after a confirmed checkpoint; the handshake is at ${record.state}.`,
      };
    }

    const quiesced = applyTransition(record, { next: STATES.QUIESCED, actor: "owner" });
    if (!quiesced.ok) return { ok: false, code: quiesced.code, note: quiesced.reason };
    save(workflowState, options, quiesced.record);

    const projectDir = workflowState.state.projectDir || "";
    const releaseMutex = options.releaseMutex || releaseWorktreeMutex;
    const released = await releaseMutex(projectDir);
    if (!released) {
      save(workflowState, options, { ...quiesced.record, lastReleaseError: "releaseWorktreeMutex returned false" });
      return {
        ok: false,
        code: "RELEASE_NOT_CONFIRMED",
        note: "The lock mechanism did not confirm the release; ownership is still held.",
        state: quiesced.record.state,
      };
    }

    const released2 = applyTransition(quiesced.record, {
      next: STATES.OWNER_RELEASED,
      actor: "owner",
      at: Number(args.at) || Date.now(),
    });
    if (!released2.ok) return { ok: false, code: released2.code, note: released2.reason };

    const next = {
      ...released2.record,
      ownerReleasedAt: Number(args.at) || Date.now(),
      // The durable handover: everything a successor needs so it never depends
      // on this conversation. No credentials, no tokens.
      handover: {
        sessionKey: workflowState.sessionId || null,
        stateFile: stateFileOf(workflowState, options),
        machine: workflowState.state.machine || null,
        projectDir: workflowState.state.projectDir || null,
        taskDescription: workflowState.state.taskDescription || null,
        todoId: Number(workflowState.state.zettly?.todoId) || null,
        phase: workflowState.state.currentPhase || null,
        at: Number(args.at) || Date.now(),
      },
      claimedBy: null,
    };

    // The mutex is gone, so the record must be written by the store, not by
    // workflowState.save(). `persisted` is reported only when that write
    // actually succeeded and can be read back.
    const written = save(workflowState, options, next);
    const readBack = written.ok ? readHandshake(stateFileOf(workflowState, options)) : { status: "absent" };
    const persisted = readBack.status === "ok" && readBack.record?.state === STATES.OWNER_RELEASED;

    return {
      ok: true,
      state: next.state,
      persisted,
      handover: next.handover,
      note: persisted
        ? "Checkpoint confirmed and ownership released. The controller may now stop this process."
        : "Ownership released in memory but the record could not be verified on disk; the controller must not proceed.",
      readiness: restartReadiness(next),
    };
  }

  if (action === "claim") {
    // Successor-side. The new agent reads the previous owner's durable handover
    // and takes it over. It never touches the old process: that one is already
    // released and stopped. Adoption itself is performed by the existing
    // guarded `resume_session { adopt }`; this step authorizes and fences it.
    const handoverFile = options.stateFile || workflowState.stateFile || null;
    const read = readHandshake(handoverFile);
    if (read.status !== "ok") {
      return { ok: false, code: "HANDOVER_NOT_FOUND", note: `no readable handover at ${handoverFile}` };
    }
    const prior = read.record;

    if (prior.claimedBy) {
      return {
        ok: false,
        code: "ALREADY_CLAIMED",
        note: `the handover was already claimed by ${prior.claimedBy.sessionKey} at ${prior.claimedBy.at}`,
      };
    }
    if (prior.state !== STATES.OWNER_RELEASED) {
      return {
        ok: false,
        code: "OWNER_NOT_RELEASED",
        note: `the handover is at ${prior.state}; a successor may only claim after OWNER_RELEASED`,
      };
    }
    if (!prior.handover || !prior.handover.sessionKey) {
      return { ok: false, code: "HANDOVER_INCOMPLETE", note: "the handover does not name its session" };
    }

    // Same machine and same repository only: a handover must never let a
    // different project or host take the task.
    const machine = workflowState.state.machine || null;
    if (prior.handover.machine && machine && prior.handover.machine !== machine) {
      return {
        ok: false,
        code: "MACHINE_MISMATCH",
        note: `handover belongs to ${prior.handover.machine}, this session is ${machine}`,
      };
    }
    const projectDir = workflowState.state.projectDir || null;
    if (prior.handover.projectDir && projectDir && !samePath(prior.handover.projectDir, projectDir)) {
      return {
        ok: false,
        code: "PROJECT_MISMATCH",
        note: `handover belongs to ${prior.handover.projectDir}, this session is ${projectDir}`,
      };
    }

    const claimant = String(workflowState.sessionId || "");
    if (!claimant) return { ok: false, code: "NO_SESSION_IDENTITY", note: "this session has no identity to record" };

    // Atomic fence: re-read and write, and refuse if someone claimed in between.
    const again = readHandshake(handoverFile);
    if (again.status !== "ok" || again.record.claimedBy) {
      return { ok: false, code: "ALREADY_CLAIMED", note: "another successor claimed the handover first" };
    }
    const claimed = {
      ...again.record,
      state: STATES.SESSION_RECOVERED,
      claimedBy: { sessionKey: claimant, at: Date.now() },
      history: [
        ...(again.record.history || []),
        { state: STATES.SESSION_RECOVERED, actor: "successor", at: Date.now(), detail: { claimant } },
      ],
    };
    const written = writeHandshake(handoverFile, claimed);
    if (!written.ok) return { ok: false, code: "CLAIM_WRITE_FAILED", note: String(written.code) };

    return {
      ok: true,
      state: claimed.state,
      adoptSessionKey: prior.handover.sessionKey,
      todoId: prior.handover.todoId,
      taskDescription: prior.handover.taskDescription,
      note: "Handover claimed. Adopt the task with resume_session { adopt: adoptSessionKey }.",
      adoptionRequired: true,
    };
  }

  return { ok: false, code: "UNKNOWN_ACTION", note: `unknown action "${action}"` };
}
