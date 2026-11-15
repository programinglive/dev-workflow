import test from "node:test";
import assert from "node:assert/strict";

import {
  SESSION_IDENTITY_REQUIRED_MESSAGE,
  resolveRequestSession,
  sessionKeyFromRequest,
} from "../session-scope.js";

/**
 * Session identity across the three real clients.
 *
 * The metadata keys below were captured from the installed clients, not
 * guessed:
 *   - OpenCode   `_meta["ai.opencode/sessionID"]`
 *   - Codex      `_meta.sessionId` (and `threadId`)
 *   - Antigravity `_meta["antigravity.google/conversation_id"]`
 *
 * The gate must accept each client's own key, refuse anything else, and never
 * let one client's identity stand in for another's.
 */

function call(meta, name = "get_workflow_status") {
  return { params: { name, _meta: meta } };
}

const OPENCODE = "ses_e22431916f4a4b0c";
const CODEX = "01a1e0eb-d479-7c22-b231-b043f8c76b09";
const ANTIGRAVITY = "aad5f565-9460-42df-a433-276005ac4c21";

test("OpenCode session identity is accepted", () => {
  const request = call({ "ai.opencode/sessionID": OPENCODE });
  assert.equal(sessionKeyFromRequest(request), OPENCODE);
  assert.equal(resolveRequestSession(request).ok, true);
});

test("Codex sessionId is accepted", () => {
  const request = call({ sessionId: CODEX, threadId: CODEX });
  assert.equal(sessionKeyFromRequest(request), CODEX);
  assert.equal(resolveRequestSession(request).ok, true);
});

test("Codex threadId is accepted when sessionId is absent", () => {
  const request = call({ threadId: CODEX });
  assert.equal(sessionKeyFromRequest(request), CODEX);
});

test("Antigravity conversation id is accepted", () => {
  const request = call({
    "antigravity.google/conversation_id": ANTIGRAVITY,
    "antigravity.google/root_conversation_id": ANTIGRAVITY,
  });
  assert.equal(sessionKeyFromRequest(request), ANTIGRAVITY);
  assert.equal(resolveRequestSession(request).ok, true);
});

test("Antigravity root conversation id alone is refused", () => {
  // Child conversations share a root, so falling back to it would let two
  // different conversations select the same state.
  const request = call({ "antigravity.google/root_conversation_id": ANTIGRAVITY });
  assert.equal(sessionKeyFromRequest(request), null);
  assert.equal(resolveRequestSession(request).ok, false);
});

test("conflicting identities in one request are refused", () => {
  const request = call({ sessionId: CODEX, threadId: "ffffffff-0000-0000-0000-000000000000" });
  assert.equal(sessionKeyFromRequest(request, { agent: "codex" }), null);
  assert.equal(resolveRequestSession(request).ok, false);
});

test("conflicting identities are refused even for an unknown agent", () => {
  const request = call({ "ai.opencode/sessionID": OPENCODE, sessionId: CODEX });
  assert.equal(sessionKeyFromRequest(request, { agent: "unknown" }), null);
});

test("a padded identity is refused rather than trimmed", () => {
  assert.equal(sessionKeyFromRequest(call({ "ai.opencode/sessionID": ` ${OPENCODE} ` })), null);
  assert.equal(sessionKeyFromRequest(call({ sessionId: `${CODEX}\n` })), null);
});

test("a Windows reserved device name is refused", () => {
  for (const name of ["con", "CON", "prn", "aux", "nul", "com1", "lpt9"]) {
    assert.equal(sessionKeyFromRequest(call({ sessionId: name })), null, `must refuse ${name}`);
  }
});

test("a request with no known identity is refused for a session-scoped tool", () => {
  const request = call({ progressToken: 1 });
  assert.equal(sessionKeyFromRequest(request), null);
  const gate = resolveRequestSession(request);
  assert.equal(gate.ok, false);
  assert.equal(gate.error, SESSION_IDENTITY_REQUIRED_MESSAGE);
});

test("a non-session tool is allowed without identity", () => {
  const gate = resolveRequestSession(call({}, "get_current_focus"));
  assert.equal(gate.ok, true);
  assert.equal(gate.sessionId, null);
});

test("an unsafe identity value is refused rather than used as a file name", () => {
  for (const bad of ["../../etc/passwd", "a b", "x".repeat(300), "", "   ", "a/b", "a\\b"]) {
    const request = call({ "ai.opencode/sessionID": bad });
    assert.equal(sessionKeyFromRequest(request), null, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(resolveRequestSession(request).ok, false);
  }
});

test("a non-string identity is refused", () => {
  assert.equal(sessionKeyFromRequest(call({ sessionId: 42 })), null);
  assert.equal(sessionKeyFromRequest(call({ sessionId: { id: CODEX } })), null);
});

test("an agent-scoped server only accepts that client's key", () => {
  // DEVWF_AGENT is set by device-entry.cjs for each client. A Codex server must
  // not accept an Antigravity conversation id, and vice versa.
  const antigravityRequest = call({ "antigravity.google/conversation_id": ANTIGRAVITY });
  assert.equal(sessionKeyFromRequest(antigravityRequest, { agent: "codex" }), null);
  assert.equal(sessionKeyFromRequest(antigravityRequest, { agent: "antigravity" }), ANTIGRAVITY);

  const codexRequest = call({ sessionId: CODEX });
  assert.equal(sessionKeyFromRequest(codexRequest, { agent: "antigravity" }), null);
  assert.equal(sessionKeyFromRequest(codexRequest, { agent: "codex" }), CODEX);

  const opencodeRequest = call({ "ai.opencode/sessionID": OPENCODE });
  assert.equal(sessionKeyFromRequest(opencodeRequest, { agent: "codex" }), null);
  assert.equal(sessionKeyFromRequest(opencodeRequest, { agent: "opencode" }), OPENCODE);
});

test("an unknown agent falls back to accepting any known key", () => {
  assert.equal(sessionKeyFromRequest(call({ sessionId: CODEX }), { agent: "unknown" }), CODEX);
  assert.equal(
    sessionKeyFromRequest(call({ "antigravity.google/conversation_id": ANTIGRAVITY }), { agent: "" }),
    ANTIGRAVITY,
  );
});

test("one client's key is never substituted for another's", () => {
  // A Codex request that also carries an OpenCode key must resolve to the Codex
  // identity, not silently borrow the other client's session.
  const request = call({ "ai.opencode/sessionID": OPENCODE, sessionId: CODEX });
  assert.equal(sessionKeyFromRequest(request, { agent: "codex" }), CODEX);
  assert.equal(sessionKeyFromRequest(request, { agent: "opencode" }), OPENCODE);
});
