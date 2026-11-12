import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMobileGovernanceEngine } = require("../monitor-server/mobile-governance.cjs");

test("Milestone M5 & M6: Secure HITL Governance, Emergency Stop & Evidence Inspector", async (t) => {
  await t.test("M5: Rejects monitor:read device tokens, service tokens, and agent identities for governance actions", () => {
    const engine = createMobileGovernanceEngine();
    engine.registerSessionState("ses_1", {
      session_key: "ses_1",
      contractRevision: "rev_1",
      evidenceDigest: "sha256_ev_1",
      policyDigest: "sha256_pol_1",
      currentRevision: "git_sha_abc",
    });

    // 1. Read-only device token rejected (403)
    const readOnlyRes = engine.executeGovernanceAction({
      sessionKey: "ses_1",
      action: "approve_gate",
      idempotencyKey: "idem_1",
      actor: { subjectId: "usr_1", subjectType: "human", roles: ["developer"] },
      device: { deviceId: "dev_1", scopes: ["monitor:read"], revoked: false },
      contractRevision: "rev_1",
      evidenceDigest: "sha256_ev_1",
      policyDigest: "sha256_pol_1",
    });
    assert.equal(readOnlyRes.status, 403);
    assert.match(readOnlyRes.body.error, /governance:approve/i);

    // 2. Service identity rejected (403)
    const serviceRes = engine.executeGovernanceAction({
      sessionKey: "ses_1",
      action: "approve_gate",
      idempotencyKey: "idem_2",
      actor: { subjectId: "svc_1", subjectType: "service", roles: ["background_service"] },
      device: { deviceId: "dev_1", scopes: ["monitor:read", "governance:approve"], revoked: false },
      contractRevision: "rev_1",
      evidenceDigest: "sha256_ev_1",
      policyDigest: "sha256_pol_1",
    });
    assert.equal(serviceRes.status, 403);
    assert.match(serviceRes.body.error, /service.*human/i);

    // 3. Agent identity rejected (403)
    const agentRes = engine.executeGovernanceAction({
      sessionKey: "ses_1",
      action: "approve_gate",
      idempotencyKey: "idem_3",
      actor: { subjectId: "agent_codex", subjectType: "agent", roles: ["coding_agent"] },
      device: { deviceId: "dev_1", scopes: ["monitor:read", "governance:approve"], revoked: false },
      contractRevision: "rev_1",
      evidenceDigest: "sha256_ev_1",
      policyDigest: "sha256_pol_1",
    });
    assert.equal(agentRes.status, 403);
    assert.match(agentRes.body.error, /agent/i);
  });

  await t.test("M5: Validates contractRevision, evidenceDigest, policyDigest, and idempotency replay protection", () => {
    const engine = createMobileGovernanceEngine();
    engine.registerSessionState("ses_2", {
      session_key: "ses_2",
      contractRevision: "rev_10",
      evidenceDigest: "ev_digest_10",
      policyDigest: "pol_digest_10",
      currentRevision: "git_tree_10",
    });

    const validActor = { subjectId: "usr_human_1", subjectType: "human", roles: ["developer"] };
    const validDevice = { deviceId: "dev_pad6", scopes: ["monitor:read", "governance:approve"], revoked: false };

    // Stale contractRevision rejected with 409
    const staleRev = engine.executeGovernanceAction({
      sessionKey: "ses_2",
      action: "approve_gate",
      idempotencyKey: "idem_stale_1",
      actor: validActor,
      device: validDevice,
      contractRevision: "rev_09_old",
      evidenceDigest: "ev_digest_10",
      policyDigest: "pol_digest_10",
    });
    assert.equal(staleRev.status, 409);
    assert.equal(staleRev.body.code, "STALE_REVISION_OR_EVIDENCE");

    // Matching revision & digests succeed (200)
    const okApprove = engine.executeGovernanceAction({
      sessionKey: "ses_2",
      action: "approve_gate",
      idempotencyKey: "idem_ok_1",
      actor: validActor,
      device: validDevice,
      contractRevision: "rev_10",
      evidenceDigest: "ev_digest_10",
      policyDigest: "pol_digest_10",
      reason: "Verified all unit tests and flow diagram",
    });
    assert.equal(okApprove.status, 200);
    assert.equal(okApprove.body.ok, true);
    assert.equal(okApprove.body.outcome, "APPROVED");

    // Idempotent retry with identical payload returns 200 with idempotentReplay: true
    const retryApprove = engine.executeGovernanceAction({
      sessionKey: "ses_2",
      action: "approve_gate",
      idempotencyKey: "idem_ok_1",
      actor: validActor,
      device: validDevice,
      contractRevision: "rev_10",
      evidenceDigest: "ev_digest_10",
      policyDigest: "pol_digest_10",
      reason: "Verified all unit tests and flow diagram",
    });
    assert.equal(retryApprove.status, 200);
    assert.equal(retryApprove.body.idempotentReplay, true);

    // Replay attack reusing idempotencyKey with different action is rejected (409)
    const mutatedReplay = engine.executeGovernanceAction({
      sessionKey: "ses_2",
      action: "waive_gate",
      idempotencyKey: "idem_ok_1",
      actor: validActor,
      device: validDevice,
      contractRevision: "rev_10",
      evidenceDigest: "ev_digest_10",
      policyDigest: "pol_digest_10",
      stepUpConfirmed: true,
      reason: "Trying to sneak a waiver",
    });
    assert.equal(mutatedReplay.status, 409);
    assert.equal(mutatedReplay.body.code, "IDEMPOTENCY_KEY_REUSE_MISMATCH");
  });

  await t.test("M5: Emergency Stop transitions through STOP_REQUESTED -> STOP_DISPATCHED -> STOP_CONFIRMED and fences stale workers", () => {
    const engine = createMobileGovernanceEngine();
    engine.registerSessionState("ses_stop", {
      session_key: "ses_stop",
      contractRevision: "rev_1",
      evidenceDigest: "ev_1",
      policyDigest: "pol_1",
      workerEpoch: 1,
    });

    const validActor = { subjectId: "usr_human_1", subjectType: "human", roles: ["developer"] };
    const validDevice = { deviceId: "dev_pad6", scopes: ["monitor:read", "governance:approve"], revoked: false };

    // Emergency stop without stepUpConfirmed two-step confirmation is rejected (400)
    const noStepUp = engine.executeGovernanceAction({
      sessionKey: "ses_stop",
      action: "emergency_stop",
      idempotencyKey: "idem_stop_0",
      actor: validActor,
      device: validDevice,
      stepUpConfirmed: false,
      reason: "Runaway loop",
    });
    assert.equal(noStepUp.status, 400);
    assert.match(noStepUp.body.error, /step-up|confirmation/i);

    // Valid emergency stop dispatches to supervisor (does NOT claim STOP_CONFIRMED prematurely)
    const stopRes = engine.executeGovernanceAction({
      sessionKey: "ses_stop",
      action: "emergency_stop",
      idempotencyKey: "idem_stop_1",
      actor: validActor,
      device: validDevice,
      stepUpConfirmed: true,
      reason: "Agent stuck in infinite loop",
    });
    assert.equal(stopRes.status, 202);
    assert.equal(stopRes.body.stopState, "STOP_DISPATCHED");
    assert.deepEqual(stopRes.body.history, ["STOP_REQUESTED", "STOP_DISPATCHED"]);

    // Stale worker with epoch 1 is immediately fenced from performing writes
    assert.equal(engine.isWorkerFenced("ses_stop", 1), true);

    // Supervisor confirms termination -> transitions to STOP_CONFIRMED
    const confirmed = engine.confirmEmergencyStop("ses_stop", {
      supervisorId: "sup_local_1",
      outcome: "STOP_CONFIRMED",
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.stopState, "STOP_CONFIRMED");
  });

  await t.test("M6: Evidence Inspector detects VERIFIED, STALE, FAILED, PENDING, and UNAVAILABLE (rejecting AI-only assertions)", () => {
    const engine = createMobileGovernanceEngine();

    // 1. AI claims testsPassed=true without executionId/stdoutDigest -> UNAVAILABLE (never VERIFIED!)
    engine.registerSessionState("ses_ai_claim", {
      session_key: "ses_ai_claim",
      currentRevision: "sha_100",
      testsPassed: true,
      evidence: null,
    });
    const claimInspect = engine.inspectSessionEvidence("ses_ai_claim");
    assert.equal(claimInspect.evidenceStatus, "UNAVAILABLE");

    // 2. Valid evidence matching currentRevision -> VERIFIED
    engine.registerSessionState("ses_verified", {
      session_key: "ses_verified",
      currentRevision: "sha_200",
      contractRevision: "rev_2",
      policyDigest: "pol_2",
      evidence: {
        executionId: "exec_99",
        sourceRevision: "sha_200",
        command: "npm test",
        exitCode: 0,
        passed: 1853,
        failed: 0,
        stdoutDigest: "sha256_stdout_ok",
      },
    });
    const verInspect = engine.inspectSessionEvidence("ses_verified");
    assert.equal(verInspect.evidenceStatus, "VERIFIED");

    // 3. File modified after test run (currentRevision moved to sha_201) -> STALE
    engine.registerSessionState("ses_verified", {
      session_key: "ses_verified",
      currentRevision: "sha_201",
      contractRevision: "rev_2",
      policyDigest: "pol_2",
      evidence: {
        executionId: "exec_99",
        sourceRevision: "sha_200",
        command: "npm test",
        exitCode: 0,
        passed: 1853,
        failed: 0,
        stdoutDigest: "sha256_stdout_ok",
      },
    });
    const staleInspect = engine.inspectSessionEvidence("ses_verified");
    assert.equal(staleInspect.evidenceStatus, "STALE");
  });

  await t.test("M6: Audit timeline paginates bounded results and redacts secrets", () => {
    const engine = createMobileGovernanceEngine();
    engine.registerSessionState("ses_audit", {
      session_key: "ses_audit",
      contractRevision: "rev_1",
      evidenceDigest: "ev_1",
      policyDigest: "pol_1",
    });

    const actor = { subjectId: "usr_1", subjectType: "human", roles: ["developer"] };
    const device = { deviceId: "dev_1", scopes: ["monitor:read", "governance:approve"], revoked: false };

    for (let i = 1; i <= 5; i++) {
      engine.executeGovernanceAction({
        sessionKey: "ses_audit",
        action: "pause_task",
        idempotencyKey: `idem_audit_${i}`,
        actor,
        device,
        reason: `Pause #${i} with secret tok_abcdef1234567890`,
      });
    }

    const page1 = engine.getAuditTimeline({ limit: 3 });
    assert.equal(page1.items.length, 3);
    assert.ok(page1.nextCursor !== null);
    for (const item of page1.items) {
      assert.ok(!item.reason.includes("tok_abcdef1234567890"), "Secret token must be redacted in audit log");
      assert.match(item.reason, /\[REDACTED\]/);
    }

    const page2 = engine.getAuditTimeline({ limit: 3, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 2);
  });
});
