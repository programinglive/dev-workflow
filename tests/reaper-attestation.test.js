import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTESTATION_TTL_MS,
  buildArchiveQuery,
  buildLeaseReleaseQuery,
  parseAttestation,
  revalidateAttestation,
} from "../monitor-server/reaper-attestation.cjs";
import {
  attestationFromRow,
  buildAttestationQuery,
} from "../monitor-server/reaper-scheduler.cjs";

/**
 * Controller-to-monitor orphan attestation.
 *
 * The monitor cannot inspect another host's process table, so it accepts the
 * controller's evidence. These tests pin what makes that evidence trustworthy:
 * a fresh timestamp, a single-use nonce, and every bound field matching the
 * stored row.
 */

const NOW = 1_800_000_000_000;

function payload(overrides = {}) {
  return {
    action: "attest",
    at: new Date(NOW).toISOString(),
    machine: "MMCH",
    sessionKey: "ses_attested",
    projectName: "demo",
    pid: 4242,
    startedAt: "2026-11-15T08:00:00Z",
    executable: "C:\\Program Files\\nodejs\\node.exe",
    leaseOwner: "owner-1",
    leaseGeneration: 3,
    leaseFencingToken: "fence-3",
    verifiedAt: new Date(NOW).toISOString(),
    nonce: "nonce-0123456789",
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    session_key: "ses_attested",
    machine: "MMCH",
    project_name: "demo",
    owner_pid: 4242,
    owner_started_at: "2026-11-15T08:00:00Z",
    owner_executable: "C:\\Program Files\\nodejs\\node.exe",
    lease_owner: "owner-1",
    lease_generation: 3,
    lease_fencing_token: "fence-3",
    phase: "coding",
    ...overrides,
  };
}

// ------------------------------------------------------------------ shape

test("a complete attestation parses", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.machine, "MMCH");
  assert.equal(parsed.value.pid, 4242);
  assert.equal(parsed.value.leaseGeneration, 3);
});

test("a missing field is refused by name", () => {
  for (const field of ["machine", "sessionKey", "projectName", "pid", "startedAt", "executable", "verifiedAt", "nonce"]) {
    const parsed = parseAttestation(payload({ [field]: "" }), { now: NOW });
    assert.equal(parsed.ok, false, `${field} must be required`);
    assert.match(parsed.reason, /ATTESTATION_MISSING|ATTESTATION_PID_INVALID/);
  }
});

test("a non-numeric or zero PID is refused", () => {
  assert.equal(parseAttestation(payload({ pid: "abc" }), { now: NOW }).reason, "ATTESTATION_PID_INVALID");
  assert.equal(parseAttestation(payload({ pid: 0 }), { now: NOW }).reason, "ATTESTATION_PID_INVALID");
});

test("an expired attestation is refused", () => {
  const old = new Date(NOW - ATTESTATION_TTL_MS - 1000).toISOString();
  assert.equal(parseAttestation(payload({ verifiedAt: old }), { now: NOW }).reason, "ATTESTATION_EXPIRED");
});

test("an attestation from the future is refused", () => {
  const future = new Date(NOW + 120_000).toISOString();
  assert.equal(parseAttestation(payload({ verifiedAt: future }), { now: NOW }).reason, "ATTESTATION_FROM_FUTURE");
});

test("a short nonce is refused", () => {
  assert.equal(parseAttestation(payload({ nonce: "abc" }), { now: NOW }).reason, "ATTESTATION_NONCE_INVALID");
});

// ------------------------------------------------------------- revalidation

test("a valid attestation matches its row", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  assert.equal(revalidateAttestation(parsed.value, row()).ok, true);
});

test("a forged machine identity is refused", () => {
  const parsed = parseAttestation(payload({ machine: "Mac" }), { now: NOW });
  const verdict = revalidateAttestation(parsed.value, row());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "MACHINE_CHANGED");
});

test("a changed project binding is refused", () => {
  const parsed = parseAttestation(payload({ projectName: "other" }), { now: NOW });
  assert.equal(revalidateAttestation(parsed.value, row()).reason, "PROJECT_BINDING_CHANGED");
});

test("PID reuse is refused", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  assert.equal(revalidateAttestation(parsed.value, row({ owner_pid: 9999 })).reason, "PID_CHANGED");
});

test("a changed process creation time is refused", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  const verdict = revalidateAttestation(parsed.value, row({ owner_started_at: "2026-11-15T09:00:00Z" }));
  assert.equal(verdict.reason, "PROCESS_CREATION_TIME_CHANGED");
});

test("a changed executable is refused", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  assert.equal(revalidateAttestation(parsed.value, row({ owner_executable: "/usr/bin/node" })).reason, "EXECUTABLE_CHANGED");
});

test("a changed lease owner is refused", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  assert.equal(revalidateAttestation(parsed.value, row({ lease_owner: "owner-2" })).reason, "LEASE_OWNER_CHANGED");
});

test("a stale fencing generation is refused", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  assert.equal(revalidateAttestation(parsed.value, row({ lease_generation: 4 })).reason, "LEASE_GENERATION_CHANGED");
  assert.equal(revalidateAttestation(parsed.value, row({ lease_fencing_token: "fence-4" })).reason, "LEASE_FENCING_CHANGED");
});

test("a session with no owner cannot be attested", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  assert.equal(revalidateAttestation(parsed.value, row({ owner_pid: null })).reason, "OWNER_MISSING");
});

test("a missing session is refused", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  assert.equal(revalidateAttestation(parsed.value, null).reason, "SESSION_MISSING");
});

// ------------------------------------------------------------ write queries

test("the archive query repeats every identity check", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  const { sql, params } = buildArchiveQuery(parsed.value);
  for (const column of [
    "machine",
    "project_name",
    "owner_pid",
    "owner_started_at",
    "owner_executable",
    "lease_owner",
    "lease_generation",
    "lease_fencing_token",
  ]) {
    assert.match(sql, new RegExp(column));
  }
  assert.match(sql, /phase NOT IN/);
  assert.equal(params.length, 9);
  assert.equal(params[0], "ses_attested");
  assert.equal(params[3], 4242);
});

test("the archive query never deletes", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  assert.equal(/DELETE/i.test(buildArchiveQuery(parsed.value).sql), false);
});

test("lease release is a compare-and-swap that bumps the generation", () => {
  const parsed = parseAttestation(payload(), { now: NOW });
  const { sql, params } = buildLeaseReleaseQuery(parsed.value);
  assert.match(sql, /lease_generation = lease_generation \+ 1/);
  assert.match(sql, /lease_owner = \$3/);
  assert.match(sql, /lease_fencing_token = \$5/);
  assert.deepEqual(params, ["ses_attested", "MMCH", "owner-1", 3, "fence-3"]);
});

test("a session with no lease has nothing to release", () => {
  const parsed = parseAttestation(payload({ leaseOwner: "", leaseGeneration: 0, leaseFencingToken: "" }), { now: NOW });
  assert.equal(buildLeaseReleaseQuery(parsed.value), null);
});

// ------------------------------------------------------------- attestation rows

test("the scheduler reads only unconsumed attestations", () => {
  const { sql } = buildAttestationQuery({ limit: 10 });
  assert.match(sql, /consumed_at IS NULL/);
  assert.match(sql, /DISTINCT ON \(session_key\)/);
});

test("an attestation row maps back to the attestation shape", () => {
  const mapped = attestationFromRow({
    session_key: "ses_attested",
    machine: "MMCH",
    project_name: "demo",
    pid: 4242,
    process_started_at: "2026-11-15T08:00:00Z",
    process_executable: "node",
    lease_owner: "owner-1",
    lease_generation: 3,
    lease_fencing_token: "fence-3",
    verified_at: "2026-11-15T09:00:00Z",
    nonce: "nonce-1",
  });
  assert.equal(mapped.sessionKey, "ses_attested");
  assert.equal(mapped.pid, 4242);
  assert.equal(mapped.leaseGeneration, 3);
});
