import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTESTATION_TTL_MS,
  revalidateAttestation,
} from "../monitor-server/reaper-attestation.cjs";
import {
  attestationFromRow,
  createReaperScheduler,
} from "../monitor-server/reaper-scheduler.cjs";

/**
 * Scheduler safety: an attestation must be re-checked for freshness when it is
 * consumed, not only when it arrives.
 *
 * The endpoint checks the TTL in `parseAttestation`. The scheduler reads the
 * stored row later, possibly much later, and revalidates identity only. Without
 * an age check a stored attestation stays actionable forever: a process that
 * was absent an hour ago, whose PID has since been reused by an unrelated
 * process, would still archive the session.
 */

const NOW = 1_800_000_000_000;

function row(overrides = {}) {
  return {
    session_key: "ses_stale",
    machine: "MMCH",
    project_name: "demo",
    owner_pid: 4242,
    owner_started_at: "2026-11-15T08:00:00Z",
    owner_executable: "node",
    lease_owner: "owner-1",
    lease_generation: 3,
    lease_fencing_token: "fence-3",
    phase: "coding",
    ...overrides,
  };
}

function attestationRow(verifiedAt) {
  return {
    session_key: "ses_stale",
    machine: "MMCH",
    project_name: "demo",
    pid: 4242,
    process_started_at: "2026-11-15T08:00:00Z",
    process_executable: "node",
    lease_owner: "owner-1",
    lease_generation: 3,
    lease_fencing_token: "fence-3",
    verified_at: verifiedAt,
    nonce: "nonce-stale-1",
  };
}

test("revalidateAttestation rejects an attestation older than the TTL", () => {
  const stale = attestationFromRow(attestationRow(new Date(NOW - ATTESTATION_TTL_MS - 60_000).toISOString()));
  const verdict = revalidateAttestation(stale, row(), { now: NOW });
  assert.equal(verdict.ok, false, "an expired attestation must not revalidate");
  assert.equal(verdict.reason, "ATTESTATION_EXPIRED");
});

test("revalidateAttestation accepts an attestation inside the TTL", () => {
  const fresh = attestationFromRow(attestationRow(new Date(NOW - 60_000).toISOString()));
  assert.equal(revalidateAttestation(fresh, row(), { now: NOW }).ok, true);
});

test("revalidateAttestation rejects an attestation from the future", () => {
  const future = attestationFromRow(attestationRow(new Date(NOW + 120_000).toISOString()));
  const verdict = revalidateAttestation(future, row(), { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "ATTESTATION_FROM_FUTURE");
});

test("a stale stored attestation never produces an actionable plan", async () => {
  const sessionRow = row();
  const staleAt = new Date(NOW - ATTESTATION_TTL_MS - 60_000).toISOString();

  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM reaper_attestations/.test(sql)) return { rows: [attestationRow(staleAt)] };
    if (/FROM sessions/.test(sql)) return { rows: [sessionRow] };
    return { rows: [], rowCount: 0 };
  };

  const scheduler = createReaperScheduler({
    query,
    reaper: { planCleanup: () => ({ action: "none", state: "ACTIVE", sessionKey: "ses_stale" }) },
    dryRun: false,
    now: () => NOW,
  });

  const result = await scheduler.runOnce();
  assert.equal(result.actionable, 0, "a stale attestation must not be actionable");
  assert.equal(result.applied.length, 0);
  assert.equal(
    calls.filter((call) => /SET phase = 'closed'/.test(call.sql)).length,
    0,
    "nothing may be archived from a stale attestation",
  );
  assert.equal(
    result.plans[0].state,
    "RECOVERY_REQUIRED",
    "a stale attestation holds the session instead of archiving it",
  );
  assert.match(result.plans[0].reason, /ATTESTATION_EXPIRED/);
});
