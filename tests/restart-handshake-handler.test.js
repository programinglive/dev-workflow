import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleRestartHandshake } from "../tools/handler-modules/restart-handshake-handlers.js";
import { STATES } from "../monitor-server/restart-handshake.cjs";
import { readHandshake, writeHandshake, claimPath } from "../monitor-server/restart-handshake-store.cjs";

/**
 * Owner-side handshake. The record lives beside the session state file, not in
 * workflow state, because workflow state is reloaded from SQLite and the save
 * path refuses once the mutex is gone.
 */

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handshake-'));
  return {
    dir,
    ws: {
      sessionId: 'ses_prev',
      stateFile: path.join(dir, 'workflow-state.ses_x.json'),
      state: { projectDir: '/tmp/project', taskDescription: 'a task', machine: 'CANARY', ...overrides },
    },
  };
}

const confirmed = async () => ({ ok: true, confirmed: true, note: 'confirmed in Todo #1' });
const unconfirmed = async () => ({ ok: true, confirmed: false, note: 'written but not read back' });

test('status on a fresh session reports REQUESTED and not ready', async () => {
  const { ws } = fixture();
  const result = await handleRestartHandshake({ action: 'status' }, ws);
  assert.equal(result.ok, true);
  assert.equal(result.state, STATES.REQUESTED);
  assert.equal(result.readiness.code, 'OWNER_NOT_RELEASED');
});

test('a confirmed checkpoint is persisted to disk', async () => {
  const { ws } = fixture();
  const result = await handleRestartHandshake({ action: 'checkpoint' }, ws, { runCheckpoint: confirmed });
  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
  const disk = readHandshake(ws.stateFile);
  assert.equal(disk.status, 'ok');
  assert.equal(disk.record.state, STATES.CHECKPOINT_CONFIRMED);
});

test('an unconfirmed checkpoint aborts and never records confirmation', async () => {
  const { ws } = fixture();
  const result = await handleRestartHandshake({ action: 'checkpoint' }, ws, { runCheckpoint: unconfirmed });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHECKPOINT_NOT_CONFIRMED');
  const disk = readHandshake(ws.stateFile);
  assert.equal(disk.record.state, STATES.OWNER_ACKNOWLEDGED);
  assert.equal(disk.record.checkpointConfirmedAt, undefined);
});

test('release is refused before a confirmed checkpoint', async () => {
  const { ws } = fixture();
  const result = await handleRestartHandshake({ action: 'release' }, ws, { releaseMutex: async () => true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHECKPOINT_REQUIRED');
});

test('a release the lock does not confirm leaves the record at QUIESCED', async () => {
  const { ws } = fixture();
  await handleRestartHandshake({ action: 'checkpoint' }, ws, { runCheckpoint: confirmed });
  const result = await handleRestartHandshake({ action: 'release' }, ws, { releaseMutex: async () => false });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RELEASE_NOT_CONFIRMED');
  const disk = readHandshake(ws.stateFile);
  assert.equal(disk.record.state, STATES.QUIESCED);
  assert.equal(disk.record.ownerReleasedAt, undefined);
});

test('a confirmed release is persisted and readable by a fresh read', async () => {
  const { ws } = fixture();
  await handleRestartHandshake({ action: 'checkpoint' }, ws, { runCheckpoint: confirmed });
  const result = await handleRestartHandshake({ action: 'release' }, ws, { releaseMutex: async () => true });
  assert.equal(result.ok, true);
  assert.equal(result.state, STATES.OWNER_RELEASED);
  assert.equal(result.persisted, true);
  assert.equal(result.readiness.code, 'READY');

  // A fresh read is exactly what the next process does: no in-memory state.
  const disk = readHandshake(ws.stateFile);
  assert.equal(disk.record.state, STATES.OWNER_RELEASED);
  assert.ok(disk.record.ownerReleasedAt);

  const fresh = await handleRestartHandshake({ action: 'status' }, { stateFile: ws.stateFile, state: {} });
  assert.equal(fresh.state, STATES.OWNER_RELEASED);
  assert.equal(fresh.readiness.code, 'READY');
});

test('a corrupted record is reported rather than treated as absent', async () => {
  const { ws } = fixture();
  writeHandshake(ws.stateFile, { state: STATES.CHECKPOINT_CONFIRMED });
  fs.writeFileSync(`${ws.stateFile}.restart-handshake.json`, '{ broken', 'utf8');
  const result = await handleRestartHandshake({ action: 'status' }, ws);
  assert.equal(result.corrupt, true);
  assert.equal(result.state, STATES.REQUESTED);
});

test('a repeated release after completion is refused', async () => {
  const { ws } = fixture();
  await handleRestartHandshake({ action: 'checkpoint' }, ws, { runCheckpoint: confirmed });
  await handleRestartHandshake({ action: 'release' }, ws, { releaseMutex: async () => true });
  const again = await handleRestartHandshake({ action: 'release' }, ws, { releaseMutex: async () => true });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'CHECKPOINT_REQUIRED');
});

test('the owner cannot cancel after the process was stopped', async () => {
  const { ws } = fixture();
  writeHandshake(ws.stateFile, { state: STATES.PROCESS_EXIT_VERIFIED, history: [] });
  const result = await handleRestartHandshake({ action: 'cancel' }, ws);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOO_LATE_TO_CANCEL');
});

test('an unknown action is refused', async () => {
  const { ws } = fixture();
  const result = await handleRestartHandshake({ action: 'explode' }, ws);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_ACTION');
});

// ------------------------------------------------------------ successor claim

const { writeHandshake: writeHs, readClaim } = await import("../monitor-server/restart-handshake-store.cjs");

async function exitedFixture() {
  const f = fixture();
  await handleRestartHandshake({ action: 'checkpoint' }, f.ws, { runCheckpoint: confirmed });
  await handleRestartHandshake({ action: 'release' }, f.ws, { releaseMutex: async () => true });
  // The controller records that the old process is gone. Claim requires it.
  const rec = readHandshake(f.ws.stateFile).record;
  writeHs(f.ws.stateFile, { ...rec, state: STATES.PROCESS_EXIT_VERIFIED });
  return { ...f, record: rec };
}

function successor(f, sessionId = 'ses_b1') {
  return { sessionId, state: { machine: 'CANARY', projectDir: '/tmp/project' } };
}

test('claim is refused before the old process is verified gone', async () => {
  const f = fixture();
  await handleRestartHandshake({ action: 'checkpoint' }, f.ws, { runCheckpoint: confirmed });
  await handleRestartHandshake({ action: 'release' }, f.ws, { releaseMutex: async () => true });
  const result = await handleRestartHandshake({ action: 'claim', handover: f.ws.stateFile }, successor(f));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OWNER_NOT_EXITED');
});

test('claim needs the handover path explicitly', async () => {
  const f = await exitedFixture();
  const result = await handleRestartHandshake({ action: 'claim' }, successor(f));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HANDOVER_REQUIRED');
});

test('claim succeeds once and fences out a second successor', async () => {
  const f = await exitedFixture();
  const first = await handleRestartHandshake({ action: 'claim', handover: f.ws.stateFile }, successor(f, 'ses_b1'));
  assert.equal(first.ok, true);
  assert.equal(first.adoptSessionKey, f.record.handover.sessionKey);

  const second = await handleRestartHandshake({ action: 'claim', handover: f.ws.stateFile }, successor(f, 'ses_b2'));
  assert.equal(second.ok, false);
  assert.equal(second.code, 'ALREADY_CLAIMED');
  assert.equal(readClaim(f.ws.stateFile).sessionKey, 'ses_b1');
});

test('claim refuses a different machine', async () => {
  const f = await exitedFixture();
  const result = await handleRestartHandshake({ action: 'claim', handover: f.ws.stateFile }, {
    sessionId: 'ses_b', state: { machine: 'OTHER', projectDir: '/tmp/project' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MACHINE_MISMATCH');
});

test('claim refuses a missing machine rather than reading it as a match', async () => {
  const f = await exitedFixture();
  const result = await handleRestartHandshake({ action: 'claim', handover: f.ws.stateFile }, {
    sessionId: 'ses_b', state: { projectDir: '/tmp/project' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MACHINE_UNVERIFIED');
});

test('claim refuses a different project', async () => {
  const f = await exitedFixture();
  const result = await handleRestartHandshake({ action: 'claim', handover: f.ws.stateFile }, {
    sessionId: 'ses_b', state: { machine: 'CANARY', projectDir: '/tmp/other' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROJECT_MISMATCH');
});

test('claim refuses a handover with no readable record', async () => {
  const f = fixture();
  const result = await handleRestartHandshake({ action: 'claim', handover: f.ws.stateFile }, successor(f));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HANDOVER_NOT_FOUND');
});

test('the release record carries the handover a successor needs', async () => {
  const f = await exitedFixture();
  assert.ok(f.record.handover.sessionKey);
  assert.ok(f.record.handover.stateFile);
  assert.equal(f.record.handover.machine, 'CANARY');
});

async function releasedFixture() {
  const f = fixture();
  await handleRestartHandshake({ action: 'checkpoint' }, f.ws, { runCheckpoint: confirmed });
  await handleRestartHandshake({ action: 'release' }, f.ws, { releaseMutex: async () => true });
  return f;
}

/** The owner identity the release recorded, so tests verify the real PID. */
function recordedOwner(f) {
  return readHandshake(f.ws.stateFile).record.handover.owner;
}

test('verify_exit refuses to record an exit while the owner is still alive', async () => {
  const f = await releasedFixture();
  const owner = recordedOwner(f);
  const result = await handleRestartHandshake(
    { action: 'verify_exit', handover: f.ws.stateFile },
    { state: { projectDir: '/tmp/project', machine: 'CANARY' } },
    { isAlive: () => true, processInfo: () => ({ pid: owner.pid, startedAt: owner.startedAt, executable: owner.executable }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROCESS_STILL_ALIVE');
  // The record must not advance: a live owner is not an eligible handover.
  assert.equal(readHandshake(f.ws.stateFile).record.state, STATES.OWNER_RELEASED);
});

test('verify_exit records the exit once the owner is gone', async () => {
  const f = await releasedFixture();
  const result = await handleRestartHandshake(
    { action: 'verify_exit', handover: f.ws.stateFile },
    { state: { projectDir: '/tmp/project', machine: 'CANARY' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, true);
  assert.equal(result.state, STATES.PROCESS_EXIT_VERIFIED);
  assert.equal(result.persisted, true);
  assert.equal(readHandshake(f.ws.stateFile).record.state, STATES.PROCESS_EXIT_VERIFIED);
});

test('verify_exit treats a reused PID as an exited owner', async () => {
  const f = await releasedFixture();
  const owner = recordedOwner(f);
  // The handover records the owner's real creation time; a live PID with a
  // different one is a different process.
  const rec = readHandshake(f.ws.stateFile).record;
  writeHs(f.ws.stateFile, { ...rec, handover: { ...rec.handover, owner: { ...owner, startedAt: 'OLD' } } });
  const result = await handleRestartHandshake(
    { action: 'verify_exit', handover: f.ws.stateFile },
    { state: { projectDir: '/tmp/project', machine: 'CANARY' } },
    { isAlive: () => true, processInfo: () => ({ pid: owner.pid, startedAt: 'NEW', executable: owner.executable }) }
  );
  assert.equal(result.ok, true);
  assert.equal(result.state, STATES.PROCESS_EXIT_VERIFIED);
});

test('verify_exit refuses a caller-supplied PID that is not the recorded owner', async () => {
  const f = await releasedFixture();
  const result = await handleRestartHandshake(
    { action: 'verify_exit', handover: f.ws.stateFile, pid: 999999 },
    { state: { projectDir: '/tmp/project', machine: 'CANARY' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OWNER_PID_MISMATCH');
  assert.equal(readHandshake(f.ws.stateFile).record.state, STATES.OWNER_RELEASED);
});

test('verify_exit refuses a handover with no recorded owner identity', async () => {
  const f = await releasedFixture();
  const rec = readHandshake(f.ws.stateFile).record;
  writeHs(f.ws.stateFile, { ...rec, handover: { ...rec.handover, owner: undefined } });
  const result = await handleRestartHandshake(
    { action: 'verify_exit', handover: f.ws.stateFile },
    { state: { projectDir: '/tmp/project', machine: 'CANARY' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OWNER_IDENTITY_MISSING');
  assert.equal(readHandshake(f.ws.stateFile).record.state, STATES.OWNER_RELEASED);
});
/**
 * Failed-claim recovery.
 *
 * A successor may claim a handover and then die before adopting it. The claim
 * is immutable and must never be deleted just because it looks old, so the only
 * way out is a generation-fenced recovery that proves the claimant is gone.
 */
function writeStaleClaim(f, { sessionKey = 'ses_crashed', generation = 1, pid = 919191, startedAt = 'S', executable = 'node' } = {}) {
  const file = claimPath(f.ws.stateFile);
  fs.writeFileSync(file, JSON.stringify({ sessionKey, at: Date.now() - 60_000, pid, startedAt, executable, generation }, null, 2));
}

test('recover_claim retires a claim whose successor died', async () => {
  const f = await exitedFixture();
  writeStaleClaim(f);
  const result = await handleRestartHandshake(
    { action: 'recover_claim', handover: f.ws.stateFile, generation: 1 },
    { state: { machine: 'CANARY', projectDir: '/tmp/project' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, true);
  assert.equal(result.retiredGeneration, 1);
  assert.equal(result.nextGeneration, 2);
  assert.equal(readClaim(f.ws.stateFile), null, 'the stale claim is gone');

  // A fresh successor can now claim, at the next generation.
  const claim = await handleRestartHandshake({ action: 'claim', handover: f.ws.stateFile }, successor(f, 'ses_b2'));
  assert.equal(claim.ok, true);
  assert.equal(claim.generation, 2);
});

test('recover_claim refuses while the claimant is alive', async () => {
  const f = await exitedFixture();
  writeStaleClaim(f, { pid: 4242, startedAt: 'S', executable: 'node' });
  const result = await handleRestartHandshake(
    { action: 'recover_claim', handover: f.ws.stateFile, generation: 1 },
    { state: { machine: 'CANARY', projectDir: '/tmp/project' } },
    { isAlive: () => true, processInfo: () => ({ pid: 4242, startedAt: 'S', executable: 'node' }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CLAIMANT_STILL_ALIVE');
  assert.equal(readClaim(f.ws.stateFile).sessionKey, 'ses_crashed');
});

test('recover_claim refuses a claim that was already adopted', async () => {
  const f = await exitedFixture();
  writeStaleClaim(f);
  const file = claimPath(f.ws.stateFile);
  const claim = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...claim, adoptedAt: Date.now() }, null, 2));
  const result = await handleRestartHandshake(
    { action: 'recover_claim', handover: f.ws.stateFile, generation: 1 },
    { state: { machine: 'CANARY', projectDir: '/tmp/project' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CLAIM_ALREADY_ADOPTED');
  assert.ok(readClaim(f.ws.stateFile), 'an adopted claim is never retired');
});

test('recover_claim refuses a claim with no recorded identity', async () => {
  const f = await exitedFixture();
  const file = claimPath(f.ws.stateFile);
  fs.writeFileSync(file, JSON.stringify({ sessionKey: 'ses_legacy', at: Date.now(), generation: 1 }, null, 2));
  const result = await handleRestartHandshake(
    { action: 'recover_claim', handover: f.ws.stateFile, generation: 1 },
    { state: { machine: 'CANARY', projectDir: '/tmp/project' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CLAIM_IDENTITY_MISSING');
  assert.ok(readClaim(f.ws.stateFile));
});

test('recover_claim is fenced by the observed generation', async () => {
  const f = await exitedFixture();
  writeStaleClaim(f, { generation: 3 });
  const result = await handleRestartHandshake(
    { action: 'recover_claim', handover: f.ws.stateFile, generation: 2 },
    { state: { machine: 'CANARY', projectDir: '/tmp/project' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GENERATION_MISMATCH');
  assert.equal(readClaim(f.ws.stateFile).generation, 3);
});

test('recover_claim needs a claim to recover', async () => {
  const f = await exitedFixture();
  const result = await handleRestartHandshake(
    { action: 'recover_claim', handover: f.ws.stateFile, generation: 1 },
    { state: { machine: 'CANARY', projectDir: '/tmp/project' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_CLAIM');
});

test('recover_claim proves a real crashed process is gone', async () => {
  const { spawn } = await import("node:child_process");
  const { createLocalAdapters } = await import("../session-controller-adapters.js");
  const f = await exitedFixture();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  try {
    // Record the child's real identity, exactly as a claimant would.
    const info = createLocalAdapters().processInfo(child.pid);
    writeStaleClaim(f, { pid: child.pid, generation: 1, startedAt: info?.startedAt || 'S', executable: info?.executable || 'node' });
    // The claimant is alive right now: recovery must refuse with the real OS check.
    const alive = await handleRestartHandshake(
      { action: "recover_claim", handover: f.ws.stateFile, generation: 1 },
      { state: { machine: "CANARY", projectDir: "/tmp/project" } }
    );
    assert.equal(alive.ok, false);
    assert.equal(alive.code, "CLAIMANT_STILL_ALIVE");

    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));

    const recovered = await handleRestartHandshake(
      { action: "recover_claim", handover: f.ws.stateFile, generation: 1 },
      { state: { machine: "CANARY", projectDir: "/tmp/project" } }
    );
    assert.equal(recovered.ok, true);
    assert.equal(recovered.retiredGeneration, 1);
    assert.equal(readClaim(f.ws.stateFile), null);
  } finally {
    try { child.kill(); } catch {}
  }
});

test('verify_exit refuses an alive PID it cannot inspect', async () => {
  const f = await releasedFixture();
  const result = await handleRestartHandshake(
    { action: 'verify_exit', handover: f.ws.stateFile },
    { state: { projectDir: '/tmp/project', machine: 'CANARY' } },
    { isAlive: () => true, processInfo: () => null }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROCESS_UNVERIFIABLE');
  assert.equal(readHandshake(f.ws.stateFile).record.state, STATES.OWNER_RELEASED);
});

test('verify_exit refuses a handover from another project', async () => {
  const f = await releasedFixture();
  const result = await handleRestartHandshake(
    { action: 'verify_exit', handover: f.ws.stateFile },
    { state: { projectDir: '/tmp/other-project', machine: 'CANARY' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROJECT_MISMATCH');
  assert.equal(readHandshake(f.ws.stateFile).record.state, STATES.OWNER_RELEASED);
});

test('verify_exit proves a real live owner cannot be certified exited', async () => {
  const { spawn } = await import("node:child_process");
  const { createLocalAdapters } = await import("../session-controller-adapters.js");
  const f = await releasedFixture();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  try {
    const info = createLocalAdapters().processInfo(child.pid);
    const rec = readHandshake(f.ws.stateFile).record;
    writeHs(f.ws.stateFile, {
      ...rec,
      handover: { ...rec.handover, owner: { pid: child.pid, startedAt: info?.startedAt || null, executable: info?.executable || null } },
    });
    const alive = await handleRestartHandshake(
      { action: 'verify_exit', handover: f.ws.stateFile },
      { state: { projectDir: '/tmp/project', machine: 'CANARY' } }
    );
    assert.equal(alive.ok, false);
    assert.equal(alive.code, 'PROCESS_STILL_ALIVE');

    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    const gone = await handleRestartHandshake(
      { action: 'verify_exit', handover: f.ws.stateFile },
      { state: { projectDir: '/tmp/project', machine: 'CANARY' } }
    );
    assert.equal(gone.ok, true);
    assert.equal(gone.state, STATES.PROCESS_EXIT_VERIFIED);
  } finally {
    try { child.kill(); } catch {}
  }
});

test('verify_exit refuses to verify a handover from another machine', async () => {
  const f = await releasedFixture();
  const result = await handleRestartHandshake(
    { action: 'verify_exit', handover: f.ws.stateFile },
    { state: { projectDir: '/tmp/project', machine: 'OTHER-MACHINE' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MACHINE_MISMATCH');
  assert.equal(readHandshake(f.ws.stateFile).record.state, STATES.OWNER_RELEASED);
});

test('a recovery lock left by a dead process is reclaimed', async () => {
  const f = await exitedFixture();
  writeStaleClaim(f);
  const { claimPath } = await import("../monitor-server/restart-handshake-store.cjs");
  const lock = `${claimPath(f.ws.stateFile)}.recovery`;
  // A dead PID holds the lock; recovery must not be blocked forever.
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() - 60_000 }));
  const result = await handleRestartHandshake(
    { action: 'recover_claim', handover: f.ws.stateFile, generation: 1 },
    { state: { machine: 'CANARY', projectDir: '/tmp/project' } },
    { isAlive: () => false }
  );
  assert.equal(result.ok, true);
  assert.equal(result.retiredGeneration, 1);
});
