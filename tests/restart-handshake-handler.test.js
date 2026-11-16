import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleRestartHandshake } from "../tools/handler-modules/restart-handshake-handlers.js";
import { STATES } from "../monitor-server/restart-handshake.cjs";
import { readHandshake, writeHandshake } from "../monitor-server/restart-handshake-store.cjs";

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