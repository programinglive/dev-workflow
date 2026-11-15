import test from "node:test";
import assert from "node:assert/strict";

import {
  authorizedActions,
  planReaperAction,
} from "../monitor-server/reaper-actions.cjs";

/**
 * The Monitor may only offer actions that the verified reaper state allows.
 * These tests pin the table both endpoints and the UI read.
 */

test("read-only actions are always allowed", () => {
  for (const state of ["ACTIVE", "IDLE", "SUSPECTED_STALE", "UNREACHABLE", "ORPHANED", "RECOVERY_REQUIRED", "ARCHIVED", "UNKNOWN"]) {
    for (const action of ["verify", "checkpoint", "evidence"]) {
      const decision = planReaperAction(state, action);
      assert.equal(decision.ok, true, `${action} must be allowed in ${state}`);
      assert.equal(decision.mutate, false);
    }
  }
});

test("archiving is allowed only for a confirmed orphan", () => {
  assert.equal(planReaperAction("ORPHANED", "archive").ok, true);
  for (const state of ["ACTIVE", "IDLE", "SUSPECTED_STALE", "UNREACHABLE", "RECOVERY_REQUIRED", "ARCHIVED", "UNKNOWN"]) {
    const decision = planReaperAction(state, "archive");
    assert.equal(decision.ok, false, `archive must be refused in ${state}`);
    assert.equal(decision.reason, "NOT_ORPHANED");
    assert.equal(decision.mutate, false);
  }
});

test("a graceful stop always needs the machine controller", () => {
  const idle = planReaperAction("IDLE", "stop");
  assert.equal(idle.ok, false);
  assert.equal(idle.reason, "CONTROLLER_REQUIRED");
  assert.equal(idle.controllerRequired, true);

  for (const state of ["ACTIVE", "ORPHANED", "RECOVERY_REQUIRED"]) {
    assert.equal(planReaperAction(state, "stop").reason, "NOT_STOPPABLE");
  }
});

test("an unknown or empty action is refused", () => {
  assert.equal(planReaperAction("ACTIVE", "").reason, "ACTION_REQUIRED");
  assert.equal(planReaperAction("ACTIVE", "rm -rf").reason, "UNKNOWN_ACTION");
});

test("the control set matches the decision table", () => {
  assert.deepEqual(authorizedActions("ORPHANED"), ["verify", "checkpoint", "evidence", "archive"]);
  assert.deepEqual(authorizedActions("IDLE"), ["verify", "checkpoint", "evidence", "stop"]);
  assert.deepEqual(authorizedActions("ACTIVE"), ["verify", "checkpoint", "evidence"]);
  assert.deepEqual(authorizedActions("RECOVERY_REQUIRED"), ["verify", "checkpoint", "evidence"]);
  for (const action of authorizedActions("ORPHANED")) {
    assert.equal(planReaperAction("ORPHANED", action).ok, true);
  }
});
