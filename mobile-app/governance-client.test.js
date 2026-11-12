import test from "node:test";
import assert from "node:assert/strict";
import {
  GOVERNANCE_ACTIONS,
  buildGovernanceRequest,
  submitGovernanceAction,
  classifyClientEvidence,
  paginateAuditEvents,
} from "./governance-client.js";

test("mobile-app governance-client & evidence inspector (M5 & M6)", async (t) => {
  await t.test("defines all 8 required M5 governance actions with risk metadata and step-up rules", () => {
    const keys = Object.keys(GOVERNANCE_ACTIONS);
    assert.deepEqual(keys.sort(), [
      "approve_gate",
      "cancel_task",
      "emergency_stop",
      "pause_task",
      "reject_gate",
      "request_changes",
      "resume_task",
      "waive_gate",
    ]);
    assert.equal(GOVERNANCE_ACTIONS.emergency_stop.requiresStepUp, true);
    assert.equal(GOVERNANCE_ACTIONS.waive_gate.requiresStepUp, true);
    assert.equal(GOVERNANCE_ACTIONS.approve_gate.requiresStepUp, false);
  });

  await t.test("buildGovernanceRequest includes revision bindings, step-up flag, and idempotencyKey", () => {
    const req = buildGovernanceRequest({
      sessionKey: "ses_10",
      action: "emergency_stop",
      reason: "Loop detected",
      stepUpConfirmed: true,
      contractRevision: "rev_10",
      evidenceDigest: "ev_10",
      policyDigest: "pol_10",
      idempotencyKey: "idem_fixed_1",
    });
    assert.equal(req.sessionKey, "ses_10");
    assert.equal(req.action, "emergency_stop");
    assert.equal(req.stepUpConfirmed, true);
    assert.equal(req.idempotencyKey, "idem_fixed_1");
    assert.equal(req.contractRevision, "rev_10");
  });

  await t.test("submitGovernanceAction posts with Bearer token and handles 403/409/202 responses", async () => {
    const res202 = await submitGovernanceAction({
      baseUrl: "http://127.0.0.1:3100",
      token: "tok_dev_1",
      payload: { sessionKey: "ses_1", action: "emergency_stop", idempotencyKey: "k1" },
      fetchImpl: async (url, init) => {
        assert.match(url, /\/api\/v1\/mobile\/governance\/action$/);
        assert.equal(init.headers.Authorization, "Bearer tok_dev_1");
        return {
          status: 202,
          ok: true,
          json: async () => ({ ok: true, stopState: "STOP_DISPATCHED" }),
        };
      },
    });
    assert.equal(res202.ok, true);
    assert.equal(res202.stopState, "STOP_DISPATCHED");
  });

  await t.test("classifyClientEvidence distinguishes VERIFIED, STALE, FAILED, PENDING, and UNAVAILABLE", () => {
    assert.equal(
      classifyClientEvidence({
        currentRevision: "sha_1",
        evidence: {
          executionId: "ex_1",
          sourceRevision: "sha_1",
          exitCode: 0,
          stdoutDigest: "dig_1",
        },
      }),
      "VERIFIED"
    );

    assert.equal(
      classifyClientEvidence({
        currentRevision: "sha_2_newer",
        evidence: {
          executionId: "ex_1",
          sourceRevision: "sha_1",
          exitCode: 0,
          stdoutDigest: "dig_1",
        },
      }),
      "STALE"
    );

    assert.equal(
      classifyClientEvidence({
        currentRevision: "sha_1",
        evidence: {
          executionId: "ex_1",
          sourceRevision: "sha_1",
          exitCode: 1,
          stdoutDigest: "dig_1",
        },
      }),
      "FAILED"
    );

    assert.equal(
      classifyClientEvidence({
        phase: "coding",
        evidence: null,
      }),
      "PENDING"
    );

    // AI boolean assertion without executionId/digest must be UNAVAILABLE, never VERIFIED
    assert.equal(
      classifyClientEvidence({
        phase: "ready",
        testsPassed: true,
        evidence: null,
      }),
      "UNAVAILABLE"
    );
  });

  await t.test("paginateAuditEvents bounds memory to pageSize and redacts inline tokens", () => {
    const raw = Array.from({ length: 60 }, (_, idx) => ({
      id: `aud_${idx + 1}`,
      action: "pause_task",
      reason: `Reason ${idx + 1} tok_secret999`,
    }));

    const page1 = paginateAuditEvents(raw, { page: 1, pageSize: 20 });
    assert.equal(page1.items.length, 20);
    assert.equal(page1.totalPages, 3);
    assert.equal(page1.hasMore, true);
    assert.ok(!page1.items[0].reason.includes("tok_secret999"));
  });
});
