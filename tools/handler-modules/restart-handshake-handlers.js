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
import { createLocalAdapters } from "../../session-controller-adapters.js";
import { handleCheckpointTask } from "./checkpoint-handlers.js";
import {
  STATES,
  applyTransition,
  restartReadiness,
} from "../../monitor-server/restart-handshake.cjs";
import { readHandshake, writeHandshake, tryClaimHandshake, readClaim, claimGeneration, retireClaim } from "../../monitor-server/restart-handshake-store.cjs";

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
 * Capture this process's own identity so a later controller can prove it exited.
 *
 * The identity is recorded by the owner itself, not supplied by the caller of
 * `verify_exit`. A caller that could name the PID could name a dead one and
 * certify a live owner as gone.
 */
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

  if (typeof isAlive !== "function" || !isAlive(target)) {
    return { exited: true, pid: target };
  }

  let info = null;
  if (typeof processInfo === "function") {
    try {
      info = processInfo(target);
    } catch {
      info = null;
    }
  }

  // The live process is not the recorded owner when its identity differs.
  if (info) {
    if (startedAt && info.startedAt && String(startedAt) !== String(info.startedAt)) {
      return { exited: true, code: "PID_REUSED", pid: target };
    }
    if (executable && info.executable && String(executable) !== String(info.executable)) {
      return { exited: true, code: "PID_REUSED", pid: target };
    }
  }

  return {
    exited: false,
    code: "PROCESS_STILL_ALIVE",
    reason: `PID ${target} is still running; a handover may only be verified after the owner has exited`,
    pid: target,
  };
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
        // The canonical session key (the state-file key), because that is what
        // `resume_session { adopt }` looks up — not the raw MCP session id.
        sessionKey: (() => {
          const file = stateFileOf(workflowState, options) || "";
          const base = file.split(/[\\/]/).pop() || "";
          const key = base.replace(/^workflow-state\./, "").replace(/\.json$/, "");
          return key || workflowState.sessionId || null;
        })(),
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
    const machine = workflowState.state.machine || process.env.DEVWF_MACHINE || null;
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
    const machine = workflowState.state.machine || process.env.DEVWF_MACHINE || null;
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