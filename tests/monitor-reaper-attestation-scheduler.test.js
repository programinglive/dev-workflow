import test from "node:test";
import assert from "node:assert/strict";

import { createReaperScheduler } from "../monitor-server/reaper-scheduler.cjs";

/**
 * Scheduler integration with controller attestations.
 *
 * The monitor cannot inspect another host's process table, so the only path to
 * ORPHANED is a signed attestation from the machine that owns the process. These
 * tests drive the scheduler with a fake database that records every statement.
 */

const NOW = Date.now();

function sessionRow(overrides = {}) {
  return {
    session_key: "ses_attested",
    machine: "MMCH",
    project_name: "demo",
    phase: "coding",
    updated_at: new Date(NOW).toISOString(),
    owner_pid: 4242,
    owner_started_at: "2026-11-15T08:00:00Z",
    owner_executable: "node",
    lease_owner: "owner-1",
    lease_generation: 3,
    lease_fencing_token: "fence-3",
    ...overrides,
  };
}

function attestationRow(overrides = {}) {
  return {
    session_key: "ses_attested",
    machine: "MMCH",
    project_name: "demo",
    pid: 4242,
    process_started_at: "2026-11-15T08:00:00Z",
    process_executable: "node",
    lease_owner: "owner-1",
    lease_generation: 3,
    lease_fencing_token: "fence-3",
    verified_at: new Date(NOW).toISOString(),
    nonce: "nonce-1",
    ...overrides,
  };
}

function makeDb({ sessions, attestations = [], archived = 1, released = 1, outcome }) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM reaper_attestations/.test(sql)) return { rows: attestations };
    if (/FROM sessions/.test(sql)) return { rows: sessions };
    // Arbitration is one statement now: it reports what it actually did.
    if (/WITH archived AS/.test(sql)) {
      const decided = outcome || (archived === 0
        ? "identity_changed"
        : released === 0 && params[6]
          ? "archived_lease_unresolved"
          : released === 0
            ? "archived_no_lease"
            : "archived_and_released");
      return { rows: [{ archived, released, outcome: decided }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, calls };
}

const reaper = { planCleanup: () => ({ action: "none", state: "ACTIVE" }) };

test("a valid attestation produces an ORPHANED plan", async () => {
  const { query } = makeDb({ sessions: [sessionRow()], attestations: [attestationRow()] });
  const scheduler = createReaperScheduler({ query, reaper, dryRun: true });
  const result = await scheduler.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.attested, 1);
  assert.equal(result.actionable, 1);
  assert.equal(result.plans[0].state, "ORPHANED");
  assert.match(result.plans[0].reason, /attested by MMCH/);
});

test("dry-run never archives or releases", async () => {
  const { query, calls } = makeDb({ sessions: [sessionRow()], attestations: [attestationRow()] });
  const scheduler = createReaperScheduler({ query, reaper, dryRun: true });
  await scheduler.runOnce();
  assert.equal(calls.filter((c) => /UPDATE sessions/.test(c.sql)).length, 0);
  assert.equal(calls.filter((c) => /UPDATE reaper_attestations/.test(c.sql)).length, 0);
});

test("a valid attestation archives and releases the lease", async () => {
  const { query, calls } = makeDb({ sessions: [sessionRow()], attestations: [attestationRow()] });
  const scheduler = createReaperScheduler({ query, reaper, dryRun: false });
  const result = await scheduler.runOnce();
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].archived, true);
  assert.equal(result.applied[0].leaseReleased, true);
  assert.equal(result.applied[0].outcome, "archived_and_released");
  // One statement carries archive, release and consumption together.
  assert.equal(calls.filter((c) => /WITH archived AS/.test(c.sql)).length, 1);
  assert.equal(calls.filter((c) => /UPDATE sessions[\s\S]*UPDATE reaper_attestations/.test(c.sql)).length, 1);
});

test("a changed lease generation rejects the attestation and holds", async () => {
  const { query, calls } = makeDb({
    sessions: [sessionRow({ lease_generation: 4 })],
    attestations: [attestationRow()],
  });
  const scheduler = createReaperScheduler({ query, reaper, dryRun: false });
  const result = await scheduler.runOnce();
  assert.equal(result.actionable, 0);
  assert.equal(result.plans[0].state, "RECOVERY_REQUIRED");
  assert.match(result.plans[0].reason, /LEASE_GENERATION_CHANGED/);
  assert.equal(calls.filter((c) => /SET phase = 'closed'/.test(c.sql)).length, 0);
});

test("a changed PID rejects the attestation", async () => {
  const { query } = makeDb({ sessions: [sessionRow({ owner_pid: 9999 })], attestations: [attestationRow()] });
  const scheduler = createReaperScheduler({ query, reaper, dryRun: false });
  const result = await scheduler.runOnce();
  assert.equal(result.plans[0].state, "RECOVERY_REQUIRED");
  assert.match(result.plans[0].reason, /PID_CHANGED/);
});

test("a lost archive race archives nothing and releases nothing", async () => {
  const { query } = makeDb({
    sessions: [sessionRow()],
    attestations: [attestationRow()],
    archived: 0,
    released: 0,
  });
  const scheduler = createReaperScheduler({ query, reaper, dryRun: false });
  const result = await scheduler.runOnce();
  assert.equal(result.applied[0].archived, false);
  assert.equal(result.applied[0].leaseReleased, false);
  assert.equal(result.applied[0].outcome, "identity_changed");
});

test("a lost lease race archives but reports the lease unresolved", async () => {
  const { query } = makeDb({
    sessions: [sessionRow()],
    attestations: [attestationRow()],
    archived: 1,
    released: 0,
  });
  const scheduler = createReaperScheduler({ query, reaper, dryRun: false });
  const result = await scheduler.runOnce();
  assert.equal(result.applied[0].archived, true);
  assert.equal(result.applied[0].leaseReleased, false);
  assert.equal(result.applied[0].leaseReason, "LEASE_OWNERSHIP_CHANGED");
  assert.equal(result.applied[0].outcome, "archived_lease_unresolved");
});

test("a session without a lease archives without a release attempt", async () => {
  const { query } = makeDb({
    sessions: [sessionRow({ lease_owner: "", lease_generation: 0, lease_fencing_token: "" })],
    attestations: [attestationRow({ lease_owner: "", lease_generation: 0, lease_fencing_token: "" })],
    archived: 1,
    released: 0,
    outcome: "archived_no_lease",
  });
  const scheduler = createReaperScheduler({ query, reaper, dryRun: false });
  const result = await scheduler.runOnce();
  assert.equal(result.applied[0].archived, true);
  assert.equal(result.applied[0].leaseReason, "NO_LEASE");
  assert.equal(result.applied[0].outcome, "archived_no_lease");
});

test("a missing attestation table does not break the cycle", async () => {
  const query = async (sql) => {
    if (/FROM reaper_attestations/.test(sql)) throw new Error('relation "reaper_attestations" does not exist');
    if (/FROM sessions/.test(sql)) return { rows: [sessionRow()] };
    return { rows: [], rowCount: 0 };
  };
  const scheduler = createReaperScheduler({ query, reaper, dryRun: true, log: { warn: () => {}, error: () => {} } });
  const result = await scheduler.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.attested, 0);
});

test("duplicate reconciliation is idempotent", async () => {
  const { query } = makeDb({ sessions: [sessionRow()], attestations: [attestationRow()] });
  const scheduler = createReaperScheduler({ query, reaper, dryRun: true });
  const first = await scheduler.runOnce();
  const second = await scheduler.runOnce();
  assert.deepEqual(second.plans, first.plans);
});

test("a shared process across project bindings is attested per binding", async () => {
  const shared = { owner_pid: 4242, owner_started_at: "2026-11-15T08:00:00Z", owner_executable: "node" };
  const { query } = makeDb({
    sessions: [
      sessionRow({ session_key: "ses_a", project_name: "alpha", ...shared }),
      sessionRow({ session_key: "ses_b", project_name: "beta", ...shared }),
    ],
    attestations: [
      attestationRow({ session_key: "ses_a", project_name: "alpha" }),
      attestationRow({ session_key: "ses_b", project_name: "beta", nonce: "nonce-2" }),
    ],
  });
  const scheduler = createReaperScheduler({ query, reaper, dryRun: true });
  const result = await scheduler.runOnce();
  assert.equal(result.actionable, 2);
  assert.deepEqual(result.plans.map((plan) => plan.project).sort(), ["alpha", "beta"]);
});
