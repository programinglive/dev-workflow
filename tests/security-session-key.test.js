import test from "node:test";
import assert from "node:assert/strict";

import { isSensitiveKey, scanSecrets } from "../security/scanner.js";

/**
 * A workload's session identifier is not a credential.
 *
 * `checkpoint.handover.sessionKey` holds the MCP session id, which is a routing
 * key written by `handoff_task` and `checkpoint_task`. The key normalizer turns
 * `sessionKey` into `session_Key`, and the sensitive-name pattern matches the
 * `session` segment with a trailing separator, so the whole checkpoint write was
 * refused with `SECRET_CONTENT_DENIED`. The handoff could never be persisted.
 *
 * The session id is not a bearer token: it selects a state row, and knowing it
 * grants nothing without the filesystem and the MCP process.
 */

test("a session identifier key is not treated as a credential", () => {
  for (const key of ["sessionKey", "session_key", "sessionId", "session_id"]) {
    assert.equal(isSensitiveKey(key), false, `${key} must not be classified as a secret`);
  }
});

test("real credential keys are still refused", () => {
  for (const key of [
    "password",
    "secret",
    "token",
    "apiKey",
    "api_key",
    "authorization",
    "cookie",
    "credential",
    "private_key",
    "connection_string",
  ]) {
    assert.equal(isSensitiveKey(key), true, `${key} must still be classified as a secret`);
  }
});

test("a handover checkpoint with a session id scans clean", () => {
  const checkpoint = {
    checkpointedAt: "2026-11-16T00:00:00.000Z",
    summary: "handoff to the other machine",
    baseSha: "7e2514936313a085d9dfe610337c53e5cc78071e",
    commits: [],
    handover: {
      from: "MMCH",
      to: "HELLOWORLD",
      reason: "resume elsewhere",
      at: "2026-11-16T00:00:00.000Z",
      sessionKey: "ses_e22431916ffeL1cHry9VlCHe8c",
    },
  };

  const findings = scanSecrets(checkpoint);
  assert.deepEqual(findings, [], `handover checkpoint must scan clean, got ${JSON.stringify(findings)}`);
});

test("a real secret in a handover is still caught", () => {
  const findings = scanSecrets({
    handover: {
      sessionKey: "ses_abc",
      note: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    },
  });
  assert.ok(findings.length > 0, "a token value must still be reported");
});
