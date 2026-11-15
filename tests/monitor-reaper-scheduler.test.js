import test from "node:test";
import assert from "node:assert/strict";

import { createReaperScheduler, toReaperSession } from "../monitor-server/reaper-scheduler.cjs";

function makeQuery(rows) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM sessions/.test(sql)) return { rows };
    return { rows: [] };
  };
  return { query, calls };
}

const reaper = {
  planCleanup: (session) => ({
    sessionKey: session.session_key,
    action: session.session_key === "ses_orphan" ? "recover_orphan" : "none",
    state: session.session_key === "ses_orphan" ? "ORPHANED" : "ACTIVE",
  }),
};

test("dry-run reconciliation plans without mutating", async () => {
  const { query, calls } = makeQuery([
    { session_key: "ses_orphan", machine: "MMCH", project_name: "demo", phase: "coding", updated_at: new Date().toISOString() },
  ]);
  const scheduler = createReaperScheduler({ query, reaper, dryRun: true });
  const result = await scheduler.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.actionable, 1);
  assert.equal(calls.filter((c) => /UPDATE sessions/.test(c.sql)).length, 0);
});

test("non-dry-run archives only confirmed orphans", async () => {
  const { query, calls } = makeQuery([
    { session_key: "ses_orphan", machine: "MMCH", project_name: "demo", phase: "coding", updated_at: new Date().toISOString() },
    { session_key: "ses_live", machine: "MMCH", project_name: "demo", phase: "coding", updated_at: new Date().toISOString() },
  ]);
  const scheduler = createReaperScheduler({ query, reaper, dryRun: false });
  const result = await scheduler.runOnce();
  assert.equal(result.actionable, 1);
  const updates = calls.filter((c) => /UPDATE sessions/.test(c.sql));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params, ["ses_orphan"]);
});

test("a second concurrent run is refused", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const query = async (sql) => {
    if (/FROM sessions/.test(sql)) { await gate; return { rows: [] }; }
    return { rows: [] };
  };
  const scheduler = createReaperScheduler({ query, reaper, dryRun: true });
  const first = scheduler.runOnce();
  const second = await scheduler.runOnce();
  assert.equal(second.ok, false);
  assert.equal(second.reason, "ALREADY_RUNNING");
  release();
  await first;
});

test("start is idempotent and stop clears the timer", () => {
  const { query } = makeQuery([]);
  const scheduler = createReaperScheduler({ query, reaper, dryRun: true, intervalMs: 60_000 });
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  assert.equal(scheduler.stop(), true);
  assert.equal(scheduler.stop(), false);
});

test("toReaperSession maps owner and lease metadata", () => {
  const mapped = toReaperSession({
    session_key: "ses_a",
    machine: "MMCH",
    project_name: "demo",
    phase: "coding",
    updated_at: "2026-11-15T09:00:00Z",
    owner_pid: 123,
    owner_started_at: "2026-11-15T08:00:00Z",
    owner_executable: "node",
    lease_owner: "o1",
    lease_generation: 4,
    lease_fencing_token: "f4",
  });
  assert.equal(mapped.owner.pid, 123);
  assert.equal(mapped.lease.generation, 4);
  assert.equal(mapped.lease.fencingToken, "f4");
});
