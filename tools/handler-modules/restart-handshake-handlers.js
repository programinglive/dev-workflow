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
import { releaseWorktreeMutex, acquireWorktreeMutex } from "../../process-lock.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createLocalAdapters } from "../../session-controller-adapters.js";
import { handleCheckpointTask } from "./checkpoint-handlers.js";
import {
  STATES,
  applyTransition,
  restartReadiness,
  stateFingerprint,
} from "../../monitor-server/restart-handshake.cjs";
import { readHandshake, writeHandshake, tryClaimHandshake, readClaim, claimGeneration, retireClaim, handshakePath } from "../../monitor-server/restart-handshake-store.cjs";

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
 * Whether the sidecar path is the one its own record names.
 *
 * A caller supplies the path, so without this check it could point at any
 * reachable sidecar whose metadata happens to match. The record names its state
 * file, and the sidecar must be that file's sidecar.
 */
function handoverMatchesStateFile(handoverFile, record) {
  const recorded = record?.handover?.stateFile;
  if (!recorded) return false;
  try {
    const given = path.resolve(String(handoverFile));
    // Callers may name either the state file or its sidecar; both resolve to the
    // same handover, and nothing else does.
    return given === path.resolve(handshakePath(recorded)) || given === path.resolve(String(recorded));
  } catch {
    return false;
  }
}

/**
 * Capture this process's own identity so a later controller can prove it exited.
 *
 * The identity is recorded by the owner itself, not supplied by the caller of
 * `verify_exit`. A caller that could name the PID could name a dead one and
 * certify a live owner as gone.
 */
/**
 * Build the durable handover a successor needs. No credentials, no tokens.
 */
function buildHandover(workflowState, options, args = {}) {
  const file = stateFileOf(workflowState, options) || "";
  const base = file.split(/[\\/]/).pop() || "";
  const key = base.replace(/^workflow-state\./, "").replace(/\.json$/, "");
  return {
    // The canonical session key (the state-file key), because that is what
    // `resume_session { adopt }` looks up - not the raw MCP session id.
    sessionKey: key || workflowState.sessionId || null,
    rawSessionId: workflowState.sessionId || null,
    stateFile: stateFileOf(workflowState, options),
    machine: workflowState.state.machine || null,
    projectDir: workflowState.state.projectDir || null,
    taskDescription: workflowState.state.taskDescription || null,
    todoId: Number(workflowState.state.zettly?.todoId) || null,
    phase: workflowState.state.currentPhase || null,
    at: Number(args.at) || Date.now(),
    // The owner's own process identity, captured here so the controller can
    // prove this exact process exited. Never a credential.
    owner: captureProcessIdentity(options.adapters),
    // The task snapshot the successor must adopt. Binding it here means a
    // changed or stale JSON file with the same session key cannot supply a
    // different task than the one that was checkpointed.
    snapshot: {
      taskDescription: workflowState.state.taskDescription || null,
      workflowTaskId: workflowState.state.workflowTaskId || null,
      todoId: Number(workflowState.state.zettly?.todoId) || null,
      phase: workflowState.state.currentPhase || null,
      dodRevision: Number(workflowState.state.dodRevision) || 0,
      fingerprint: stateFingerprint(workflowState.state),
    },
  };
}

function captureProcessIdentity(adapters = null) {
  const identity = { pid: process.pid, startedAt: null, executable: null };
  try {
    const a = adapters || createLocalAdapters();
    const info = a.processInfo(process.pid);
    if (info) {
      identity.startedAt = info.startedAt || null;
      identity.executable = info.executable || null;
    }
  } catch {
    // Identity is best-effort at capture time; verify_exit fails closed when it
    // is missing rather than trusting a caller-supplied substitute.
  }
  return identity;
}

/**
 * Decide whether the recorded owner process is genuinely gone.
 *
 * The controller asserts the exit, but an assertion is not proof: recording
 * PROCESS_EXIT_VERIFIED for a process that is still running lets a successor
 * claim a handover while the old owner may still write, which is exactly the
 * two-writers condition the handover exists to prevent. The handler therefore
 * inspects the OS itself instead of trusting the caller's claim.
 *
 * A live PID is not automatically a live owner: PID reuse is real. When the
 * caller supplies the recorded creation time or executable and the live process
 * does not match it, the original owner is gone and the PID now belongs to an
 * unrelated process.
 *
 * @returns {{exited: boolean, code?: string, reason?: string, pid: number}}
 */
function verifyOwnerExit({ pid, startedAt, executable } = {}, { isAlive, processInfo } = {}) {
  const target = Number(pid);
  if (!Number.isFinite(target) || target <= 0) {
    return { exited: false, code: "PID_REQUIRED", reason: "verify_exit needs the recorded owner PID", pid: target };
  }

  // Fail closed: without a liveness probe nothing is proven.
  if (typeof isAlive !== "function") {
    return { exited: false, code: "LIVENESS_UNAVAILABLE", reason: "no process liveness probe is available", pid: target };
  }
  if (!isAlive(target)) {
    return { exited: true, pid: target };
  }

  // The PID is alive. It is only a different process when the recorded identity
  // decisively differs; an identity the live process cannot confirm is
  // unverifiable, not proof of reuse.
  if (typeof processInfo !== "function") {
    return { exited: false, code: "PROCESS_UNVERIFIABLE", reason: `PID ${target} is alive and cannot be inspected`, pid: target };
  }
  let info = null;
  try {
    info = processInfo(target);
  } catch {
    info = null;
  }
  if (!info) {
    return { exited: false, code: "PROCESS_UNVERIFIABLE", reason: `PID ${target} is alive and could not be inspected`, pid: target };
  }

  const recordedStart = startedAt ? String(startedAt) : "";
  const liveStart = info.startedAt ? String(info.startedAt) : "";
  const recordedExe = executable ? String(executable) : "";
  const liveExe = info.executable ? String(info.executable) : "";

  if (recordedStart && !liveStart) {
    return { exited: false, code: "PROCESS_UNVERIFIABLE", reason: `PID ${target} creation time could not be read`, pid: target };
  }
  if (recordedExe && !liveExe) {
    return { exited: false, code: "PROCESS_UNVERIFIABLE", reason: `PID ${target} executable could not be read`, pid: target };
  }

  // Creation time is compared as an instant, not as a string: the Windows CIM
  // and WMIC providers format the same instant differently, and a string
  // mismatch would otherwise certify a live owner as a reused PID.
  if (recordedStart && liveStart) {
    const a = parseProcessStart(recordedStart);
    const b = parseProcessStart(liveStart);
    if (a !== null && b !== null) {
      if (a !== b) return { exited: true, code: "PID_REUSED", pid: target };
    } else if (recordedStart !== liveStart) {
      // One side could not be parsed, so the difference is not decisive.
      return { exited: false, code: "PROCESS_UNVERIFIABLE", reason: `PID ${target} creation time could not be compared`, pid: target };
    }
  }
  if (recordedExe && liveExe && recordedExe !== liveExe) {
    return { exited: true, code: "PID_REUSED", pid: target };
  }

  return {
    exited: false,
    code: "PROCESS_STILL_ALIVE",
    reason: `PID ${target} is still running; a handover may only be verified after the owner has exited`,
    pid: target,
  };
}

/**
 * Parse a process creation time to epoch milliseconds.
 *
 * Accepts the DMTF form CIM returns (`20261116123456.123456+000`) and ISO 8601
 * (with or without a timezone). Returns null when the value is not a time, so
 * the caller can refuse instead of guessing.
 */
function parseProcessStart(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const dmtf = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?([+-]\d{3})?$/.exec(text);
  if (dmtf) {
    const [, y, mo, d, h, mi, s, frac, offset] = dmtf;
    const ms = frac ? Number(`0.${frac}`) * 1000 : 0;
    let epoch = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Math.round(ms));
    if (offset) {
      const sign = offset[0] === "-" ? -1 : 1;
      const minutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5));
      epoch -= sign * minutes * 60_000;
    }
    return Number.isFinite(epoch) ? epoch : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Advance the handshake.
 *
 * @param {object} args
 * @param {string} args.action status|checkpoint|release|cancel|claim|verify_exit
 */
export async function handleRestartHandshake(args = {}, workflowState = null, options = {}) {
  const action = String(args.action || "status");
  if (!workflowState?.state) return { ok: false, code: "NO_STATE", note: "No session state is loaded." };
  // The claim and the controller-side steps name the previous owner's handover
  // explicitly, so the caller does not need its own state file to start them.
  if (action !== "claim" && action !== "verify_exit" && action !== "recover_claim" && !stateFileOf(workflowState, options)) {
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

    // Persist the local state the successor will copy. A checkpoint that landed
    // in Zettly but not in the local state file would hand over an older task
    // than the one that was checkpointed.
    if (typeof workflowState.save === "function") {
      try {
        const saved = await workflowState.save();
        if (saved && (saved.verified === false || saved.conflict)) {
          return {
            ok: false,
            code: "CHECKPOINT_STATE_NOT_PERSISTED",
            note: "The checkpoint landed in Zettly but the local state reported a conflict; the controller must not proceed.",
            state: acknowledged.record.state,
          };
        }
        // The successor copies the JSON file, so a save that only updated the
        // store is not enough: the file must match the checkpointed state.
        const stateFile = stateFileOf(workflowState, options);
        if (stateFile) {
          let onDisk = null;
          try {
            onDisk = JSON.parse(readFileSync(stateFile, "utf8"));
          } catch {
            onDisk = null;
          }
          if (!onDisk || stateFingerprint(onDisk) !== stateFingerprint(workflowState.state)) {
            return {
              ok: false,
              code: "CHECKPOINT_STATE_NOT_PERSISTED",
              note: "The checkpoint landed in Zettly but the local state file does not match it; the controller must not proceed.",
              state: acknowledged.record.state,
            };
          }
        }
      } catch (error) {
        return {
          ok: false,
          code: "CHECKPOINT_STATE_NOT_PERSISTED",
          note: `The checkpoint landed in Zettly but the local state could not be saved (${error?.message || error}).`,
          state: acknowledged.record.state,
        };
      }
    }

    const next = {
      ...confirmed.record,
      checkpointConfirmedAt: Number(args.at) || Date.now(),
      checkpointNote: checkpoint.note,
    };
    const written = save(workflowState, options, next);
    return {
      ok: Boolean(written.ok),
      code: written.ok ? undefined : "CHECKPOINT_NOT_PERSISTED",
      state: next.state,
      persisted: Boolean(written.ok),
      checkpointNote: checkpoint.note,
      note: written.ok
        ? "Checkpoint confirmed and recorded."
        : "The checkpoint was confirmed in Zettly but the handshake record could not be written; the controller must not proceed.",
    };
  }

  if (action === "release") {
    // A release that failed after QUIESCED was persisted must be retryable;
    // otherwise a transient lock or write failure strands the handover.
    let quiesced;
    if (record.state === STATES.QUIESCED) {
      quiesced = { ok: true, record };
    } else if (record.state === STATES.CHECKPOINT_CONFIRMED) {
      quiesced = applyTransition(record, { next: STATES.QUIESCED, actor: "owner" });
      if (!quiesced.ok) return { ok: false, code: quiesced.code, note: quiesced.reason };
      save(workflowState, options, quiesced.record);
    } else {
      return {
        ok: false,
        code: "CHECKPOINT_REQUIRED",
        note: `ownership can only be released after a confirmed checkpoint; the handshake is at ${record.state}.`,
      };
    }

    // Mark the state itself as handed over while the mutex is still held, so a
    // deleted sidecar cannot silently downgrade a fenced handover to the generic
    // left-behind-session path.
    if (record.state === STATES.CHECKPOINT_CONFIRMED && typeof workflowState.save === "function") {
      try {
        const file = stateFileOf(workflowState, options) || "";
        const base = file.split(/[\\/]/).pop() || "";
        const key = base.replace(/^workflow-state\./, "").replace(/\.json$/, "");
        workflowState.state.handover = {
          at: Number(args.at) || Date.now(),
          sessionKey: key || workflowState.sessionId || null,
        };
        await workflowState.save();
      } catch (error) {
        // Without the marker a lost sidecar would downgrade the handover to the
        // generic path, so the release must not proceed.
        return {
          ok: false,
          code: "RELEASE_MARKER_NOT_PERSISTED",
          note: `the handover marker could not be saved (${error?.message || error}); ownership is still held.`,
          state: quiesced.record.state,
        };
      }
    }

    const projectDir = workflowState.state.projectDir || "";
    const releaseMutex = options.releaseMutex || releaseWorktreeMutex;
    // Release this session's own capability. Releasing by path would resolve to
    // whichever capability the process holds for the worktree, which could be
    // another session's mutex in a multi-session process.
    const ownCapability = workflowState.boundKernelCapability || null;
    if (!ownCapability) {
      // A retry after a successful release but a failed OWNER_RELEASED write
      // finds no capability. Prove the worktree is genuinely unheld by trying
      // to acquire it: a capability held by another process is a named pipe this
      // process cannot see, so a local lookup is not proof.
      const probe = await acquireWorktreeMutex({ projectDir, timeoutMs: 0 });
      if (record.state === STATES.QUIESCED && probe.ok) {
        try {
          await releaseWorktreeMutex(probe.capability);
        } catch {
          // The probe capability is released on process exit regardless.
        }
        const released2 = applyTransition(record, {
          next: STATES.OWNER_RELEASED,
          actor: "owner",
          at: Number(args.at) || Date.now(),
        });
        if (!released2.ok) return { ok: false, code: released2.code, note: released2.reason };
        const next = {
          ...released2.record,
          ownerReleasedAt: Number(args.at) || Date.now(),
          handover: buildHandover(workflowState, options, args),
          claimedBy: null,
        };
        const written = save(workflowState, options, next);
        const readBack = written.ok ? readHandshake(stateFileOf(workflowState, options)) : { status: "absent" };
        const persisted = readBack.status === "ok" && readBack.record?.state === STATES.OWNER_RELEASED;
        return {
          ok: persisted,
          code: persisted ? undefined : "RELEASE_NOT_PERSISTED",
          state: next.state,
          persisted,
          handover: next.handover,
          note: persisted
            ? "Ownership was already released; the durable receipt is now recorded."
            : "Ownership is released but the receipt could not be written; the controller must not proceed.",
          readiness: restartReadiness(next),
        };
      }
      return {
        ok: false,
        code: "NO_CAPABILITY",
        note: "this session holds no worktree capability to release; ownership cannot be confirmed.",
        state: quiesced.record.state,
      };
    }
    const released = await releaseMutex(ownCapability);
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
      handover: buildHandover(workflowState, options, args),
      claimedBy: null,
    };

    // The mutex is gone, so the record must be written by the store, not by
    // workflowState.save(). `persisted` is reported only when that write
    // actually succeeded and can be read back.
    const written = save(workflowState, options, next);
    const readBack = written.ok ? readHandshake(stateFileOf(workflowState, options)) : { status: "absent" };
    const persisted = readBack.status === "ok" && readBack.record?.state === STATES.OWNER_RELEASED;

    return {
      ok: persisted,
      code: persisted ? undefined : "RELEASE_NOT_PERSISTED",
      state: next.state,
      persisted,
      handover: next.handover,
      note: persisted
        ? "Checkpoint confirmed and ownership released. The controller may now stop this process."
        : "Ownership released in memory but the record could not be verified on disk; the controller must not proceed.",
      readiness: restartReadiness(next),
    };
  }

  if (action === "verify_exit") {
    // Controller-side. The old process is gone, proven by the controller, not
    // by the owner. This is what makes a successor eligible.
    const handoverFile = args.handover || options.stateFile || null;
    if (!handoverFile) return { ok: false, code: "HANDOVER_REQUIRED", note: "verify_exit needs the handover path" };
    const read = readHandshake(handoverFile);
    if (read.status !== "ok") return { ok: false, code: "HANDOVER_NOT_FOUND", note: `no readable handover at ${handoverFile}` };
    const prior = read.record;
    if (!handoverMatchesStateFile(handoverFile, prior)) {
      return { ok: false, code: "HANDOVER_PATH_MISMATCH", note: "the handover path is not the sidecar its record names" };
    }

    // The controller must name the project it is acting on, and it must be the
    // handover's project. The project comes from the session's own state, never
    // from the request: a fresh session with no project could otherwise declare
    // another project and act on its sidecar.
    const callerProject = workflowState.state.projectDir || null;
    if (!callerProject) {
      return { ok: false, code: "PROJECT_UNVERIFIED", note: "verify_exit needs the project it is acting on" };
    }
    if (!prior.handover?.projectDir || !samePath(prior.handover.projectDir, callerProject)) {
      return {
        ok: false,
        code: "PROJECT_MISMATCH",
        note: `the handover belongs to ${prior.handover?.projectDir || "(unknown)"}, not ${callerProject}`,
      };
    }
    // The machine must come from the process environment, never from the
    // caller: a caller on another machine could otherwise name the handover's
    // machine and have a local PID check certify a live remote owner.
    const callerMachine = process.env.DEVWF_MACHINE || null;
    if (!callerMachine || !prior.handover?.machine) {
      return { ok: false, code: "MACHINE_UNVERIFIED", note: "the handover and this controller must both name a machine" };
    }
    // The exit check inspects the LOCAL process table, so it is only meaningful
    // on the machine that owns the handover. A controller on another machine
    // would see the PID absent and certify a live remote owner as exited.
    if (callerMachine !== prior.handover.machine) {
      return {
        ok: false,
        code: "MACHINE_MISMATCH",
        note: `the handover belongs to ${prior.handover.machine}; exit must be verified on that machine, not ${callerMachine}`,
      };
    }

    // Only after the identity checks: an already-verified handover still has to
    // belong to this project and machine before it is reported as verified.
    if (prior.state === STATES.PROCESS_EXIT_VERIFIED || prior.state === STATES.RELAUNCHED) {
      return { ok: true, state: prior.state, alreadyVerified: true };
    }

    // Prove the owner is gone before recording anything. The identity comes
    // from the handover the owner wrote, never from the caller: a caller that
    // could name the PID could name a dead one and certify a live owner.
    const owner = prior.handover?.owner;
    if (!owner || !Number.isFinite(Number(owner.pid))) {
      return {
        ok: false,
        code: "OWNER_IDENTITY_MISSING",
        note: "the handover does not record the owner process identity; exit cannot be proven",
      };
    }
    if (args.pid != null && Number(args.pid) !== Number(owner.pid)) {
      return {
        ok: false,
        code: "OWNER_PID_MISMATCH",
        note: `the handover records owner PID ${owner.pid}, not ${args.pid}`,
      };
    }

    let adapters = null;
    if (typeof options.isAlive !== "function") {
      try {
        adapters = createLocalAdapters();
      } catch {
        adapters = null;
      }
    }
    const exit = verifyOwnerExit(
      { pid: owner.pid, startedAt: owner.startedAt, executable: owner.executable },
      {
        isAlive: options.isAlive || adapters?.isAlive,
        processInfo: options.processInfo || adapters?.processInfo,
      }
    );
    if (!exit.exited) {
      return { ok: false, code: exit.code, note: exit.reason, pid: exit.pid };
    }

    const step = applyTransition(prior, {
      next: STATES.PROCESS_EXIT_VERIFIED,
      actor: "controller",
      at: Number(args.at) || Date.now(),
      detail: { pid: Number(owner.pid), identity: exit.code || "PROCESS_EXITED" },
    });
    if (!step.ok) return { ok: false, code: step.code, note: step.reason };
    const written = writeHandshake(handoverFile, step.record);
    if (!written.ok) return { ok: false, code: "WRITE_FAILED", note: String(written.code) };
    const back = readHandshake(handoverFile);
    const persisted = back.status === "ok" && back.record.state === STATES.PROCESS_EXIT_VERIFIED;
    return { ok: persisted, state: step.record.state, persisted };
  }

  if (action === "claim") {
    // Successor-side. The new agent reads the previous owner's durable handover
    // and takes it over. It never touches the old process.
    //
    // The handover to claim is named explicitly: a fresh successor has its own
    // state file, so reading its own would find nothing. The path comes from the
    // controller, which got it from the release receipt.
    const handoverFile = args.handover || options.stateFile || null;
    if (!handoverFile) {
      return { ok: false, code: "HANDOVER_REQUIRED", note: "claim needs the previous owner's handover path" };
    }
    const read = readHandshake(handoverFile);
    if (read.status !== "ok") {
      return { ok: false, code: "HANDOVER_NOT_FOUND", note: `no readable handover at ${handoverFile}` };
    }
    const prior = read.record;
    if (!handoverMatchesStateFile(handoverFile, prior)) {
      return { ok: false, code: "HANDOVER_PATH_MISMATCH", note: "the handover path is not the sidecar its record names" };
    }

    const existing = readClaim(handoverFile);
    if (existing || prior.claimedBy) {
      const holder = existing || prior.claimedBy;
      return {
        ok: false,
        code: "ALREADY_CLAIMED",
        note: `the handover was already claimed by ${holder.sessionKey} at ${holder.at}`,
      };
    }

    // The owner releasing the mutex does NOT prove its process exited. A live
    // owner must never be claimed, so the controller has to have recorded that
    // the old process is gone.
    if (prior.state !== STATES.PROCESS_EXIT_VERIFIED && prior.state !== STATES.RELAUNCHED) {
      return {
        ok: false,
        code: "OWNER_NOT_EXITED",
        note: `the handover is at ${prior.state}; a successor may only claim after ${STATES.PROCESS_EXIT_VERIFIED}`,
      };
    }
    if (!prior.handover || !prior.handover.sessionKey) {
      return { ok: false, code: "HANDOVER_INCOMPLETE", note: "the handover does not name its session" };
    }

    // A fresh successor has no task yet, so its identity comes from the
    // environment the client launched it with, not from task state.
    const machine = process.env.DEVWF_MACHINE || null;
    if (!machine || !prior.handover.machine) {
      return { ok: false, code: "MACHINE_UNVERIFIED", note: "the handover and this session must both name a machine" };
    }
    if (prior.handover.machine !== machine) {
      return {
        ok: false,
        code: "MACHINE_MISMATCH",
        note: `handover belongs to ${prior.handover.machine}, this session is ${machine}`,
      };
    }
    const projectDir = workflowState.state.projectDir || process.cwd() || null;
    if (!projectDir || !prior.handover.projectDir) {
      return { ok: false, code: "PROJECT_UNVERIFIED", note: "the handover and this session must both name a project" };
    }
    if (!samePath(prior.handover.projectDir, projectDir)) {
      return {
        ok: false,
        code: "PROJECT_MISMATCH",
        note: `handover belongs to ${prior.handover.projectDir}, this session is ${projectDir}`,
      };
    }

    const claimant = String(workflowState.sessionId || "");
    if (!claimant) return { ok: false, code: "NO_SESSION_IDENTITY", note: "this session has no identity to record" };

    // True cross-process single winner: an OS-exclusive link, not a read then
    // replace. The loser gets ALREADY_CLAIMED and never touches the task.
    const generation = claimGeneration(handoverFile);
    if (generation == null) {
      return { ok: false, code: "GENERATION_UNAVAILABLE", note: "the claim generation could not be determined; refusing to claim" };
    }
    const self = captureProcessIdentity(options.adapters);
    const claim = {
      sessionKey: claimant,
      at: Date.now(),
      todoId: prior.handover.todoId || null,
      // Identity of the claiming process, captured by the claimant itself, so a
      // crashed successor can later be proven dead before its claim is retired.
      // Never a credential.
      pid: self.pid,
      startedAt: self.startedAt,
      executable: self.executable,
      machine,
      generation,
      // The claimant's own state file and the task it is about to adopt, so a
      // crash between the durable adoption and the adopted marker can still be
      // detected by recovery.
      stateFile: workflowState.stateFile || null,
      adoptedTask: {
        taskDescription: prior.handover.taskDescription || null,
        todoId: prior.handover.todoId || null,
        fingerprint: prior.handover.snapshot?.fingerprint || null,
      },
    };
    const won = tryClaimHandshake(handoverFile, claim);
    if (!won.ok) {
      if (won.code === "ALREADY_CLAIMED") {
        const holder = readClaim(handoverFile);
        return {
          ok: false,
          code: "ALREADY_CLAIMED",
          note: holder ? `the handover was claimed by ${holder.sessionKey} at ${holder.at}` : "another successor claimed the handover first",
        };
      }
      return { ok: false, code: "CLAIM_WRITE_FAILED", note: String(won.code) };
    }

    // The handover record itself is NOT rewritten: the claim file is the single
    // authoritative winner, and mutating the handover here would race the owner
    // and could report success while the record still says something else.
    return {
      ok: true,
      state: STATES.SESSION_RECOVERED,
      adoptSessionKey: prior.handover.sessionKey,
      todoId: prior.handover.todoId,
      taskDescription: prior.handover.taskDescription,
      generation,
      note: "Handover claimed. Adopt the task with resume_session { adopt: adoptSessionKey }.",
      adoptionRequired: true,
    };
  }

  if (action === "recover_claim") {
    // Controller-side recovery for a successor that claimed the handover and
    // then died before adopting it. Without this a crashed claim strands the
    // task forever, because the claim is immutable and must never be deleted
    // just because it looks old.
    //
    // The recovery is generation-fenced: the caller must present the exact
    // generation it observed, and the claimant must be proven dead. A live
    // claimant is never displaced, so two writers can never overlap.
    const handoverFile = args.handover || options.stateFile || null;
    if (!handoverFile) return { ok: false, code: "HANDOVER_REQUIRED", note: "recover_claim needs the handover path" };
    const read = readHandshake(handoverFile);
    if (read.status !== "ok") return { ok: false, code: "HANDOVER_NOT_FOUND", note: `no readable handover at ${handoverFile}` };
    const prior = read.record;
    if (!handoverMatchesStateFile(handoverFile, prior)) {
      return { ok: false, code: "HANDOVER_PATH_MISMATCH", note: "the handover path is not the sidecar its record names" };
    }
    if (prior.state !== STATES.PROCESS_EXIT_VERIFIED && prior.state !== STATES.RELAUNCHED) {
      return { ok: false, code: "OWNER_NOT_EXITED", note: `the handover is at ${prior.state}; recovery needs ${STATES.PROCESS_EXIT_VERIFIED}` };
    }

    const claim = readClaim(handoverFile);
    if (!claim) return { ok: false, code: "NO_CLAIM", note: "the handover has no claim to recover" };
    if (claim.adoptedAt) {
      return {
        ok: false,
        code: "CLAIM_ALREADY_ADOPTED",
        note: `the claim was adopted by ${claim.sessionKey} at ${claim.adoptedAt}; its progress must not be discarded`,
      };
    }
    // A crash between the durable adoption and the adopted marker leaves an
    // unmarked claim. The claimant's own state file proves the task was already
    // adopted, so recovery must not hand it to a second successor. Re-checked
    // under the recovery lock below, because adoption can commit in between.
    const claimantAlreadyAdopted = (candidate) => {
      if (!candidate?.stateFile || !candidate?.adoptedTask?.taskDescription) return false;
      try {
        const claimantState = JSON.parse(readFileSync(candidate.stateFile, "utf8"));
        return candidate.adoptedTask.fingerprint
          ? stateFingerprint(claimantState) === candidate.adoptedTask.fingerprint
          : (claimantState.taskDescription || "") === candidate.adoptedTask.taskDescription;
      } catch {
        return false;
      }
    };
    if (claimantAlreadyAdopted(claim)) {
      return {
        ok: false,
        code: "CLAIM_ALREADY_ADOPTED",
        note: `the claimant's state already holds the adopted task; recovery would discard its progress`,
      };
    }
    if (!Number.isFinite(Number(claim.pid))) {
      return {
        ok: false,
        code: "CLAIM_IDENTITY_MISSING",
        note: "the claim does not record the claimant process identity; recovery cannot prove it is safe",
      };
    }

    const expectedGeneration = Number(args.generation);
    if (!Number.isFinite(expectedGeneration) || expectedGeneration !== Number(claim.generation)) {
      return {
        ok: false,
        code: "GENERATION_MISMATCH",
        note: `the claim is at generation ${claim.generation}, not ${args.generation}`,
        currentGeneration: claim.generation,
      };
    }

    // Same machine and project contract as claiming: recovery must not move a
    // task across a boundary the claim itself could not cross.
    const machine = process.env.DEVWF_MACHINE || null;
    if (!machine || !prior.handover?.machine) {
      return { ok: false, code: "MACHINE_UNVERIFIED", note: "the handover and this session must both name a machine" };
    }
    if (prior.handover.machine !== machine) {
      return { ok: false, code: "MACHINE_MISMATCH", note: `handover belongs to ${prior.handover.machine}, this session is ${machine}` };
    }
    const projectDir = workflowState.state.projectDir || process.cwd() || null;
    if (!projectDir || !prior.handover.projectDir || !samePath(prior.handover.projectDir, projectDir)) {
      return { ok: false, code: "PROJECT_MISMATCH", note: "recovery must run in the handover's project" };
    }

    // Prove the claimant is gone using the identity the claimant recorded, not
    // anything the caller supplies. A live claimant keeps its claim however old
    // the record looks.
    let adapters = null;
    if (typeof options.isAlive !== "function") {
      try {
        adapters = createLocalAdapters();
      } catch {
        adapters = null;
      }
    }
    const verifyClaimant = () =>
      verifyOwnerExit(
        { pid: claim.pid, startedAt: claim.startedAt, executable: claim.executable },
        {
          isAlive: options.isAlive || adapters?.isAlive,
          processInfo: options.processInfo || adapters?.processInfo,
        }
      );
    const exit = verifyClaimant();
    if (!exit.exited) {
      return { ok: false, code: "CLAIMANT_STILL_ALIVE", note: exit.reason, pid: exit.pid };
    }

    const retired = retireClaim(handoverFile, {
      generation: expectedGeneration,
      expectedSessionKey: claim.sessionKey,
      // Re-prove under the recovery lock: the claimant could have been replaced
      // between the check above and the retirement.
      verify: (current) => {
        if (current.adoptedAt) return { ok: false, code: "CLAIM_ALREADY_ADOPTED" };
        if (claimantAlreadyAdopted(current)) return { ok: false, code: "CLAIM_ALREADY_ADOPTED" };
        const again = verifyOwnerExit(
          { pid: current.pid, startedAt: current.startedAt, executable: current.executable },
          {
            isAlive: options.isAlive || adapters?.isAlive,
            processInfo: options.processInfo || adapters?.processInfo,
          }
        );
        return again.exited ? { ok: true } : { ok: false, code: "CLAIMANT_STILL_ALIVE" };
      },
    });
    if (!retired.ok) {
      return { ok: false, code: retired.code, note: `claim recovery failed: ${retired.code}`, currentGeneration: retired.currentGeneration };
    }

    return {
      ok: true,
      state: STATES.PROCESS_EXIT_VERIFIED,
      retiredGeneration: expectedGeneration,
      nextGeneration: expectedGeneration + 1,
      retiredClaimant: claim.sessionKey,
      retiredFile: retired.retired,
      note: "Stale claim retired. A fresh successor may now claim the handover.",
    };
  }

  return { ok: false, code: "UNKNOWN_ACTION", note: `unknown action "${action}"` };
}