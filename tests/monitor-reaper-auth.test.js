import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  REPLAY_WINDOW_MS,
  parseReaperSecrets,
  resolveReaperSecret,
  verifyReaperRequest,
} from "../monitor-server/reaper-query.cjs";
import { fetchReaperSessions, REAPER_SIGNATURE_HEADER } from "../reaper-client.js";
import { createMachineController } from "../session-reaper.js";

/**
 * Per-machine controller credentials.
 *
 * One shared secret means one leaked key compromises every machine and cannot be
 * rotated for a single host. These tests pin the per-machine contract and the
 * fallback that keeps an existing deployment working.
 */

const SECRETS = { MMCH: "mmch-secret", HELLOWORLD: "helloworld-secret", Mac: "mac-secret" };

function sign(payload, secret) {
  return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

function payloadFor(machine, at = new Date().toISOString()) {
  return { action: "list", at, machine };
}

test("the secret map parses a JSON object of machine to secret", () => {
  assert.deepEqual(parseReaperSecrets(JSON.stringify(SECRETS)), SECRETS);
});

test("a malformed secret map falls back instead of authorizing everyone", () => {
  assert.deepEqual(parseReaperSecrets("not json"), {});
  assert.deepEqual(parseReaperSecrets("[1,2]"), {});
  assert.deepEqual(parseReaperSecrets(""), {});
  assert.deepEqual(parseReaperSecrets('{"MMCH":""}'), {});
});

test("each machine resolves to its own secret", () => {
  for (const [machine, secret] of Object.entries(SECRETS)) {
    const resolved = resolveReaperSecret({ machine, secrets: SECRETS });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.secret, secret);
    assert.equal(resolved.machine, machine);
  }
});

test("a request without a machine is refused when per-machine secrets are configured", () => {
  const resolved = resolveReaperSecret({ machine: "", secrets: SECRETS });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "MACHINE_REQUIRED");
});

test("an unknown machine is refused", () => {
  const resolved = resolveReaperSecret({ machine: "UNKNOWN", secrets: SECRETS });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "MACHINE_NOT_AUTHORIZED");
});

test("the single shared secret still works as a fallback", () => {
  const resolved = resolveReaperSecret({ machine: "MMCH", secrets: {}, secret: "legacy" });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.secret, "legacy");
});

test("no credential at all is refused", () => {
  const resolved = resolveReaperSecret({ machine: "MMCH", secrets: {}, secret: "" });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "REAPER_SECRET_MISSING");
});

test("a machine is accepted only with its own secret", () => {
  const payload = payloadFor("MMCH");
  const good = verifyReaperRequest({
    payload,
    signature: sign(payload, SECRETS.MMCH),
    secrets: SECRETS,
  });
  assert.equal(good.ok, true);
  assert.equal(good.machine, "MMCH");

  const wrong = verifyReaperRequest({
    payload,
    signature: sign(payload, SECRETS.HELLOWORLD),
    secrets: SECRETS,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "SIGNATURE_MISMATCH");
});

test("a machine cannot speak for another machine", () => {
  const payload = payloadFor("Mac");
  const result = verifyReaperRequest({
    payload,
    signature: sign(payload, SECRETS.MMCH),
    secrets: SECRETS,
  });
  assert.equal(result.ok, false);
});

test("changing the machine invalidates the signature", () => {
  const payload = payloadFor("MMCH");
  const signature = sign(payload, SECRETS.MMCH);
  const tampered = { ...payload, machine: "Mac" };
  const result = verifyReaperRequest({ payload: tampered, signature, secrets: SECRETS });
  assert.equal(result.ok, false);
});

test("rotating one machine's secret revokes only that machine", () => {
  const payload = payloadFor("MMCH");
  const oldSignature = sign(payload, SECRETS.MMCH);
  const rotated = { ...SECRETS, MMCH: "mmch-secret-v2" };

  assert.equal(verifyReaperRequest({ payload, signature: oldSignature, secrets: rotated }).ok, false);
  assert.equal(
    verifyReaperRequest({ payload, signature: sign(payload, "mmch-secret-v2"), secrets: rotated }).ok,
    true,
  );
  // The other machines are untouched.
  const other = payloadFor("Mac");
  assert.equal(
    verifyReaperRequest({ payload: other, signature: sign(other, SECRETS.Mac), secrets: rotated }).ok,
    true,
  );
});

test("replay protection still applies with per-machine secrets", () => {
  const stale = payloadFor("MMCH", new Date(Date.now() - REPLAY_WINDOW_MS - 1000).toISOString());
  const result = verifyReaperRequest({
    payload: stale,
    signature: sign(stale, SECRETS.MMCH),
    secrets: SECRETS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLAY_WINDOW_EXCEEDED");
});

test("the client sends its machine identity inside the signed payload", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ sessions: [] }) };
  };

  await fetchReaperSessions({
    baseUrl: "http://monitor",
    secret: SECRETS.MMCH,
    machine: "MMCH",
    fetchImpl,
  });

  const payload = JSON.parse(seen.init.body);
  assert.equal(payload.machine, "MMCH");
  const verdict = verifyReaperRequest({
    payload,
    signature: seen.init.headers[REAPER_SIGNATURE_HEADER],
    secrets: SECRETS,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.machine, "MMCH");
});

test("the client omits the machine when it is not configured", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ sessions: [] }) };
  };
  await fetchReaperSessions({ baseUrl: "http://monitor", secret: "legacy", fetchImpl });
  assert.equal("machine" in JSON.parse(seen.init.body), false);
});

test("a controller refuses to act on another machine's session", async () => {
  let stopped = false;
  const controller = createMachineController({
    machine: "MMCH",
    adapters: {
      isAlive: () => true,
      processInfo: (pid) => ({ pid, startedAt: "2026-11-15T08:00:00Z", executable: "node" }),
      requestStop: async () => {
        stopped = true;
        return { ok: true };
      },
    },
  });
  const result = await controller.requestStop({
    session_key: "ses_remote",
    machine: "Mac",
    owner: { pid: 42, startedAt: "2026-11-15T08:00:00Z", executable: "node" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REMOTE_SESSION_REFUSED");
  assert.equal(stopped, false, "a remote session must never reach the OS adapter");
});
