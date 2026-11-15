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

test("non-dry-run archives nothing without a controller attestation", async () => {
  // The monitor cannot see another host's process table, so a plan alone is not
  // evidence. Without an attestation the cycle must not archive.
  const { query, calls } = makeQuery([
    { session_key: "ses_orphan", machine: "MMCH", project_name: "demo", phase: "coding", updated_at: new Date().toISOString() },
    { session_key: "ses_live", machine: "MMCH", project_name: "demo", phase: "coding", updated_at: new Date().toISOString() },
  ]);
  const scheduler = createReaperScheduler({ query, reaper, dryRun: false });
  const result = await scheduler.runOnce();
  assert.equal(result.actionable, 1);
  assert.equal(result.attested, 0);
  assert.equal(calls.filter((c) => /UPDATE sessions/.test(c.sql)).length, 0);
  assert.deepEqual(result.applied, []);
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

test("a transient failure is retried with bounded backoff", async () => {
  let calls = 0;
  const delays = [];
  const query = async (sql) => {
    if (/FROM sessions/.test(sql)) {
      calls += 1;
      if (calls < 3) throw new Error("connection reset");
      return { rows: [] };
    }
    return { rows: [] };
  };
  const scheduler = createReaperScheduler({
    query,
    reaper,
    dryRun: true,
    retries: 3,
    baseDelayMs: 1,
    sleep: async (ms) => { delays.push(ms); },
  });
  const result = await scheduler.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [1, 2], "backoff must double and stay bounded");
});

test("the retry budget is finite and the failure is audited", async () => {
  const query = async (sql) => {
    if (/FROM sessions/.test(sql)) throw new Error("database is down");
    return { rows: [] };
  };
  const scheduler = createReaperScheduler({
    query,
    reaper,
    dryRun: false,
    retries: 2,
    baseDelayMs: 1,
    sleep: async () => {},
    log: { error: () => {} },
  });
  const result = await scheduler.runOnce();
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.match(result.reason, /database is down/);
  assert.equal(scheduler.audit.length, 1);
  assert.equal(scheduler.audit[0].ok, false);
});

test("a failed cycle releases ownership so the next cycle can run", async () => {
  let fail = true;
  const query = async (sql) => {
    if (/FROM sessions/.test(sql)) {
      if (fail) throw new Error("temporary");
      return { rows: [] };
    }
    return { rows: [] };
  };
  const scheduler = createReaperScheduler({
    query,
    reaper,
    dryRun: true,
    retries: 0,
    sleep: async () => {},
    log: { error: () => {} },
  });
  assert.equal((await scheduler.runOnce()).ok, false);
  assert.equal(scheduler.isRunning(), false);
  fail = false;
  assert.equal((await scheduler.runOnce()).ok, true, "a failed run must not wedge the scheduler");
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
