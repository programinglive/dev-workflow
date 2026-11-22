import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  writeTakeoverRequest,
  readTakeoverRequest,
  clearTakeoverRequest,
  TAKEOVER_REQUEST_FILENAME,
} from "../process-lock.js";
import { handleTakeOverTask } from "../tools/handler-modules/takeover-handlers.js";
import { WorkflowState } from "../workflow-state.js";

const text = (r) => r?.content?.[0]?.text || "";

test("takeover request survives a write/read/clear round trip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-takeover-"));
  try {
    assert.equal(readTakeoverRequest({ dir }), null);
    const written = writeTakeoverRequest({
      dir,
      ownerPid: 111,
      requesterPid: 222,
      reason: "owner stuck for hours",
    });
    assert.equal(written.ok, true);
    assert.equal(path.basename(written.path), TAKEOVER_REQUEST_FILENAME);

    const request = readTakeoverRequest({ dir });
    assert.equal(request.ownerPid, 111);
    assert.equal(request.requesterPid, 222);
    assert.match(request.reason, /stuck for hours/);

    assert.equal(clearTakeoverRequest({ dir }), true);
    assert.equal(readTakeoverRequest({ dir }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("takeover request refuses an empty reason", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-takeover-"));
  try {
    const result = writeTakeoverRequest({ dir, ownerPid: 1, requesterPid: 2, reason: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "reason_required");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("take_over_task refuses an unconfirmed request before touching state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-takeover-"));
  try {
    const state = new WorkflowState(path.join(dir, "state.json"));
    const response = handleTakeOverTask(
      { projectDir: process.cwd(), ownerPid: 4242, reason: "owner is stuck", confirmation: "nope" },
      state,
    );
    assert.match(text(response), /CONFIRM TAKE_OVER 4242/);
    assert.equal(state.state.currentPhase, "idle");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
