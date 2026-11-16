import test from "node:test";
import assert from "node:assert/strict";

import { handleRestartHandshake } from "../tools/handler-modules/restart-handshake-handlers.js";
import { STATES } from "../monitor-server/restart-handshake.cjs";

/**
 * Owner-side handshake. The owner may only advance its own states, and may only
 * release ownership after the lock mechanism confirms it.
 */

function fakeState(overrides = {}) {
  return {
    state: {
      projectDir: "/tmp/project",
      taskDescription: "a task",
      restartHandshake: undefined,
      ...overrides,
    },
    saves: 0,
    async save() { this.saves += 1; },
  };
}

const confirmed = async () => ({ ok: true, confirmed: true, note: "confirmed in Todo #1" });
const unconfirmed = async () => ({ ok: true, confirmed: false, note: "written but not read back" });

test("status on a fresh session reports REQUESTED and not ready", async () => {
  const ws = fakeState();
  const result = await handleRestartHandshake({ action: "status" }, ws);
  assert.equal(result.ok, true);
  assert.equal(result.state, STATES.REQUESTED);
  assert.equal(result.readiness.ok, false);
  assert.equal(result.readiness.code, "OWNER_NOT_RELEASED");
});

test("a confirmed checkpoint advances to CHECKPOINT_CONFIRMED", async () => {
  const ws = fakeState();
  const result = await handleRestartHandshake({ action: "checkpoint" }, ws, { runCheckpoint: confirmed });
  assert.equal(result.ok, true);
  assert.equal(result.state, STATES.CHECKPOINT_CONFIRMED);
  assert.ok(result.checkpointNote);
  assert.equal(ws.state.restartHandshake.state, STATES.CHECKPOINT_CONFIRMED);
});

test("an unconfirmed checkpoint aborts and never records confirmation", async () => {
  const ws = fakeState();
  const result = await handleRestartHandshake({ action: "checkpoint" }, ws, { runCheckpoint: unconfirmed });
  assert.equal(result.ok, false);
  assert.equal(result.code, "CHECKPOINT_NOT_CONFIRMED");
  assert.equal(ws.state.restartHandshake.state, STATES.OWNER_ACKNOWLEDGED);
  assert.equal(ws.state.restartHandshake.checkpointConfirmedAt, undefined);
});

test("release is refused before a confirmed checkpoint", async () => {
  const ws = fakeState({
    restartHandshake: { state: STATES.OWNER_ACKNOWLEDGED, history: [] },
  });
  const result = await handleRestartHandshake({ action: "release" }, ws, { releaseMutex: async () => true });
  assert.equal(result.ok, false);
  assert.equal(result.code, "CHECKPOINT_REQUIRED");
});

test("a release the lock mechanism does not confirm is refused", async () => {
  const ws = fakeState();
  await handleRestartHandshake({ action: "checkpoint" }, ws, { runCheckpoint: confirmed });
  const result = await handleRestartHandshake({ action: "release" }, ws, { releaseMutex: async () => false });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RELEASE_NOT_CONFIRMED");
  assert.equal(ws.state.restartHandshake.state, STATES.QUIESCED);
  assert.equal(ws.state.restartHandshake.ownerReleasedAt, undefined);
});

test("a confirmed release reaches OWNER_RELEASED and reports ready", async () => {
  const ws = fakeState();
  await handleRestartHandshake({ action: "checkpoint" }, ws, { runCheckpoint: confirmed });
  const result = await handleRestartHandshake({ action: "release" }, ws, { releaseMutex: async () => true });
  assert.equal(result.ok, true);
  assert.equal(result.state, STATES.OWNER_RELEASED);
  assert.equal(result.readiness.ok, true);
  assert.equal(result.readiness.code, "READY");
});

test("the owner cannot cancel after the process was stopped", async () => {
  const ws = fakeState({
    restartHandshake: { state: STATES.PROCESS_EXIT_VERIFIED, history: [] },
  });
  const result = await handleRestartHandshake({ action: "cancel" }, ws);
  assert.equal(result.ok, false);
  assert.equal(result.code, "TOO_LATE_TO_CANCEL");
});

test("the owner cannot record a controller step", async () => {
  const ws = fakeState({ restartHandshake: { state: STATES.OWNER_RELEASED, history: [] } });
  const result = await handleRestartHandshake({ action: "release" }, ws, { releaseMutex: async () => true });
  // release is the owner's step but it is out of order now.
  assert.equal(result.ok, false);
  assert.equal(result.code, "CHECKPOINT_REQUIRED");
});

test("an unknown action is refused", async () => {
  const result = await handleRestartHandshake({ action: "explode" }, fakeState());
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNKNOWN_ACTION");
});
