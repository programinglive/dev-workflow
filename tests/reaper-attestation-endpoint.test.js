import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attestOrphan, REAPER_SIGNATURE_HEADER } from "../reaper-client.js";
import { verifyReaperRequest } from "../monitor-server/reaper-query.cjs";
import { createMachineController } from "../session-reaper.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = { MMCH: "mmch-secret", HELLOWORLD: "helloworld-secret", Mac: "mac-secret" };

/**
 * Controller attestation contract.
 *
 * The controller signs with its own credential; the monitor verifies with the
 * same canonical payload. A drift between the two would make every attestation
 * fail with 401, so the contract is pinned here.
 */

function attestation(overrides = {}) {
  return {
    sessionKey: "ses_attested",
    projectName: "demo",
    pid: 4242,
    startedAt: "2026-11-15T08:00:00Z",
    executable: "node",
    leaseOwner: "owner-1",
    leaseGeneration: 3,
    leaseFencingToken: "fence-3",
    verifiedAt: new Date().toISOString(),
    nonce: "nonce-0123456789",
    ...overrides,
  };
}

test("the controller signs an attestation the monitor accepts", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 202, json: async () => ({ ok: true }) };
  };

  const result = await attestOrphan({
    baseUrl: "http://monitor",
    secret: SECRETS.MMCH,
    machine: "MMCH",
    attestation: attestation(),
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.match(seen.url, /\/api\/reaper\/attest$/);
  assert.equal(seen.init.method, "POST");

  const payload = JSON.parse(seen.init.body);
  assert.equal(payload.machine, "MMCH");
  assert.equal(payload.action, "attest");
  assert.equal(payload.nonce, "nonce-0123456789");

  const verdict = verifyReaperRequest({
    payload,
    signature: seen.init.headers[REAPER_SIGNATURE_HEADER],
    secrets: SECRETS,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.machine, "MMCH");
});

test("another machine's credential cannot sign this attestation", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: false, status: 401, json: async () => ({ error: "SIGNATURE_MISMATCH" }) };
  };

  const result = await attestOrphan({
    baseUrl: "http://monitor",
    secret: SECRETS.Mac,
    machine: "MMCH",
    attestation: attestation(),
    fetchImpl,
  });

  assert.equal(result.ok, false);
  const payload = JSON.parse(seen.init.body);
  const verdict = verifyReaperRequest({
    payload,
    signature: seen.init.headers[REAPER_SIGNATURE_HEADER],
    secrets: SECRETS,
  });
  assert.equal(verdict.ok, false);
});

test("a rejected attestation surfaces the monitor's reason", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: "LEASE_GENERATION_CHANGED" }),
  });
  const result = await attestOrphan({
    baseUrl: "http://monitor",
    secret: SECRETS.MMCH,
    machine: "MMCH",
    attestation: attestation(),
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "LEASE_GENERATION_CHANGED");
});

test("the controller still refuses another machine's session", async () => {
  let stopped = false;
  const controller = createMachineController({
    machine: "MMCH",
    adapters: {
      isAlive: () => false,
      processInfo: () => null,
      requestStop: async () => {
        stopped = true;
        return { ok: true };
      },
    },
  });
  const result = await controller.requestStop({
    session_key: "ses_remote",
    machine: "Mac",
    owner: { pid: 1, startedAt: "x", executable: "node" },
  });
  assert.equal(result.reason, "REMOTE_SESSION_REFUSED");
  assert.equal(stopped, false);
});

test("the monitor never exposes attestations or fencing tokens publicly", () => {
  const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");
  const publicPayload = dash.slice(dash.indexOf("reaper_actions: reaper"), dash.indexOf("reaper_actions: reaper") + 400);
  for (const field of ["attestation", "nonce", "lease_fencing_token"]) {
    assert.equal(publicPayload.includes(field), false, `${field} must not reach the public payload`);
  }
});

test("the attest endpoint is authenticated and never trusts a client label", () => {
  const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");
  const start = dash.indexOf("'/api/reaper/attest'");
  const end = dash.indexOf("'/api/reaper/action'", start);
  assert.ok(start > -1 && end > start, "the attest block must exist before the action block");
  const block = dash.slice(start, end);
  assert.match(block, /verifyReaperRequest/);
  assert.match(block, /revalidateAttestation/);
  assert.match(block, /MACHINE_MISMATCH/);
  assert.match(block, /ATTESTATION_REPLAYED/);
  // The endpoint must not accept a client-supplied state at all.
  assert.equal(/body\.state/.test(block), false);
});
