import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  REPLAY_WINDOW_MS,
  buildReaperSessionsQuery,
  verifyReaperRequest,
} from "../monitor-server/reaper-query.cjs";
import { buildSessionUpsert } from "../monitor-server/session-upsert.cjs";
import { fetchReaperSessions, REAPER_SIGNATURE_HEADER } from "../reaper-client.js";

function sign(payload, secret) {
  return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

test("reaper query selects owner and lease columns", () => {
  const { sql, params } = buildReaperSessionsQuery({ limit: 10 });
  assert.match(sql, /owner_pid/);
  assert.match(sql, /owner_started_at/);
  assert.match(sql, /owner_executable/);
  assert.match(sql, /lease_fencing_token/);
  assert.deepEqual(params, [10]);
});

test("reaper query bounds the limit", () => {
  assert.deepEqual(buildReaperSessionsQuery({ limit: 9999 }).params, [500]);
  assert.deepEqual(buildReaperSessionsQuery({ limit: 0 }).params, [200]);
});

test("reaper request accepts a valid signature", () => {
  const payload = { action: "list", at: new Date().toISOString() };
  const signature = sign(payload, "secret");
  assert.equal(verifyReaperRequest({ payload, signature, secret: "secret" }).ok, true);
});

test("reaper request rejects a tampered payload", () => {
  const payload = { action: "list", at: new Date().toISOString() };
  const signature = sign(payload, "secret");
  const tampered = { ...payload, action: "stop" };
  assert.equal(verifyReaperRequest({ payload: tampered, signature, secret: "secret" }).ok, false);
});

test("reaper request rejects an expired timestamp", () => {
  const payload = { action: "list", at: new Date(Date.now() - REPLAY_WINDOW_MS - 1000).toISOString() };
  const signature = sign(payload, "secret");
  const result = verifyReaperRequest({ payload, signature, secret: "secret" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLAY_WINDOW_EXCEEDED");
});

test("reaper request rejects a missing secret", () => {
  const payload = { action: "list", at: new Date().toISOString() };
  const result = verifyReaperRequest({ payload, signature: "x", secret: "" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REAPER_SECRET_MISSING");
});

test("the reaper client and the monitor verify with the same contract", async () => {
  // The client is ESM and signs with signControllerRequest; the monitor is CJS
  // and verifies with verifyReaperRequest. A drift between the two would make
  // every privileged read fail with 401, so the contract is pinned here.
  let received = null;
  const fetchImpl = async (url, init) => {
    assert.equal(url, "http://monitor/api/reaper/sessions");
    assert.equal(init.method, "POST");
    const payload = JSON.parse(init.body);
    received = {
      payload,
      signature: init.headers[REAPER_SIGNATURE_HEADER],
    };
    return { ok: true, json: async () => ({ sessions: [{ session_key: "ses_a" }] }) };
  };

  await fetchReaperSessions({ baseUrl: "http://monitor", secret: "shared-secret", fetchImpl });
  assert.ok(received, "the client must call the privileged endpoint");

  const verdict = verifyReaperRequest({
    payload: received.payload,
    signature: received.signature,
    secret: "shared-secret",
  });
  assert.equal(verdict.ok, true, "the monitor must accept the client signature");

  const rejected = verifyReaperRequest({
    payload: received.payload,
    signature: received.signature,
    secret: "another-secret",
  });
  assert.equal(rejected.ok, false, "a different credential must be refused");
});

test("session upsert persists owner and lease metadata", () => {
  const { sql, params } = buildSessionUpsert({
    sessionKey: "ses_a",
    machine: "MMCH",
    projectName: "demo",
    task: "t",
    phase: "coding",
    ownerPid: 123,
    ownerStartedAt: "2026-11-15T08:00:00Z",
    ownerExecutable: "node",
    leaseOwner: "o1",
    leaseGeneration: 4,
    leaseFencingToken: "f4",
  });
  assert.match(sql, /owner_started_at/);
  assert.match(sql, /lease_fencing_token/);
  assert.ok(params.includes("2026-11-15T08:00:00Z"));
  assert.ok(params.includes("node"));
  assert.ok(params.includes("o1"));
  assert.ok(params.includes(4));
  assert.ok(params.includes("f4"));
});
