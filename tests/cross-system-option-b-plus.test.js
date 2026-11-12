import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createLocalIdentityProvider,
  createPocketBaseIdentityProvider,
  evaluateGatewayToolPolicy,
} from "../security/identity-provider.js";
import {
  createPairingChallenge,
  verifyPairingChallenge,
  validateDeviceToken,
  resetPairingStore,
} from "../pairing/challenge.js";
import { relasiFlow } from "../mobile-app/flow-relation.js";
import {
  computeCockpitKpis,
  selectFocusDiagrams,
  selectGovernanceItems,
} from "../mobile-app/cockpit-mode.js";
import {
  buildGovernanceRequest,
  classifyClientEvidence,
} from "../mobile-app/governance-client.js";

const require = createRequire(import.meta.url);
const { createMobileGovernanceEngine } = require("../monitor-server/mobile-governance.cjs");

test("Option B+ Cross-System Integration Verification (End-to-End 4-Pillar Lifecycle)", async (t) => {
  await t.test("End-to-end flow: Zettly Todo/Draw -> Task Contract -> Agent Execution -> Evidence Verification -> Xiaomi Pad 6 HITL Approval -> Guarded Integration", async () => {
    resetPairingStore();
    const engine = createMobileGovernanceEngine();

    // 1. Zettly Planning Plane (Todo #645 + Zettly Draw #290)
    const session = {
      session_key: "sess-e2e-bplus-1",
      project: "dev-workflow-mcp-server",
      task: "Option B+ Controlled Release Verification",
      title: "Option B+ Controlled Release Verification",
      phase: "ready",
      state: "live",
      contractRevision: "rev_4",
      evidenceDigest: "ev_sha256_1853_pass",
      policyDigest: "pol_sha256_v2",
      currentRevision: "f268cdd9",
      evidence: {
        executionId: "exec_bplus_1",
        sourceRevision: "f268cdd9",
        command: "npm test",
        exitCode: 0,
        passed: 1853,
        failed: 0,
        stdoutDigest: "ev_sha256_1853_pass",
      },
      task_relations_json: [
        { system: "zettly_todo", id: "645" },
        { system: "zettly_draw", id: "290", title: "Option B+ Architecture Flow" },
      ],
    };

    engine.registerSessionState(session.session_key, session);

    // Verify Zettly Draw relation extraction for Xiaomi Pad 6 Focus Mode
    const drawRel = relasiFlow(session);
    assert.ok(drawRel);
    assert.equal(drawRel.id, "290");
    assert.equal(selectFocusDiagrams([session]).length, 1);

    // 2. Central Gateway Tool Policy Guard (PocketBase pb_*, infra_*, notify_*)
    const readPerm = evaluateGatewayToolPolicy({
      toolName: "pb_list_records",
      collection: "activity_users",
    });
    assert.equal(readPerm.allowed, true);

    const legacyBlocked = evaluateGatewayToolPolicy({
      toolName: "pb_create_record",
      collection: "activity_tasks",
    });
    assert.equal(legacyBlocked.allowed, false);
    assert.match(legacyBlocked.reason, /activity_tasks.*retired/i);

    // 3. Cryptographic Device Pairing & Least-Privilege Default Scope
    const challenge = createPairingChallenge({ serverUrl: "http://100.77.138.14:3100" });
    const paired = verifyPairingChallenge({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      providedCode: challenge.verificationCode,
      deviceName: "Xiaomi Pad 6 (23043RP34G)",
    });
    assert.equal(paired.ok, true);
    assert.deepEqual(paired.scopes, ["monitor:read"]);
    const verifiedToken = validateDeviceToken(paired.deviceToken);
    assert.equal(verifiedToken.ok, true);

    // 4. Evidence Verification (M6) before Human Approval
    const evidenceReport = engine.inspectSessionEvidence(session.session_key);
    assert.equal(evidenceReport.evidenceStatus, "VERIFIED");
    assert.equal(classifyClientEvidence(session), "VERIFIED");

    // 5. Xiaomi Pad 6 Cockpit KPI & Governance Mode selection (M4 + M5)
    const kpis = computeCockpitKpis({ sessions: [session] });
    assert.equal(kpis.activeSessions, 1);
    assert.equal(kpis.governanceAttention, 1);
    assert.equal(selectGovernanceItems({ sessions: [session] }).length, 1);

    const reqBody = buildGovernanceRequest({
      sessionKey: session.session_key,
      action: "approve_gate",
      contractRevision: session.contractRevision,
      evidenceDigest: session.evidenceDigest,
      policyDigest: session.policyDigest,
      reason: "Verified 1,853+ tests and M5-M7 readiness on Xiaomi Pad 6",
      stepUpConfirmed: true,
      idempotencyKey: "idem_e2e_canary_1",
    });

    // Upgrade device scope for authorized human approval
    const approvalOutcome = engine.executeGovernanceAction({
      ...reqBody,
      actor: {
        subjectId: "usr_dhika_pb",
        subjectType: "human",
        roles: ["owner", "Maintainer"],
      },
      device: {
        deviceId: paired.deviceId,
        scopes: ["monitor:read", "governance:approve"],
        revoked: false,
      },
    });

    assert.equal(approvalOutcome.status, 200);
    assert.equal(approvalOutcome.body.ok, true);
    assert.equal(approvalOutcome.body.outcome, "APPROVED");

    // 6. Audit Timeline Verification (M6)
    const audit = engine.getAuditTimeline({ limit: 10 });
    assert.equal(audit.items.length, 1);
    assert.equal(audit.items[0].action, "approve_gate");
    assert.equal(audit.items[0].actorId, "usr_dhika_pb");
  });

  await t.test("Local-First Standalone Mode operates 100% offline without PocketBase, Zettly, or Central Gateway", async () => {
    const localIdp = createLocalIdentityProvider({
      defaultUserId: "local_oss_maintainer",
    });
    const resolved = await localIdp.authenticate({
      subjectId: "local_oss_maintainer",
      name: "Offline OSS Developer",
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.claims.subjectType, "human");
    assert.equal(resolved.claims.provider, "local");

    const engine = createMobileGovernanceEngine();
    engine.registerSessionState("sess-local-1", {
      session_key: "sess-local-1",
      contractRevision: "rev_1",
      workerEpoch: 1,
    });

    const stopRes = engine.executeGovernanceAction({
      sessionKey: "sess-local-1",
      action: "emergency_stop",
      contractRevision: "rev_1",
      stepUpConfirmed: true,
      idempotencyKey: "idem_local_stop_1",
      reason: "Offline emergency halt test",
      actor: {
        subjectId: resolved.claims.subjectId,
        subjectType: "human",
        roles: resolved.claims.roles,
      },
      device: {
        deviceId: "local-tablet-01",
        scopes: ["monitor:read", "governance:approve", "governance:emergency_stop"],
        revoked: false,
      },
    });

    assert.equal(stopRes.status, 202);
    assert.equal(stopRes.body.stopState, "STOP_DISPATCHED");
    assert.equal(engine.isWorkerFenced("sess-local-1", 1), true);

    const confirmed = engine.confirmEmergencyStop("sess-local-1", {
      supervisorId: "sup_local_1",
      outcome: "STOP_CONFIRMED",
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.stopState, "STOP_CONFIRMED");
  });

  await t.test("Internal Enterprise Mode supports PocketBase activity_users with zero Factory dependencies", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        id: "pb_usr_01",
        email: "dev@example.com",
        collectionName: "activity_users",
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString("base64url");
    const mockJwt = `${header}.${payload}.sig`;

    const pbIdp = createPocketBaseIdentityProvider({
      pocketBaseUrl: "https://pocketbase.programinglive.com",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          token: mockJwt,
          record: {
            id: "pb_usr_01",
            email: "dev@example.com",
            name: "Enterprise Dev",
          },
        }),
      }),
    });

    const auth = await pbIdp.authenticate({
      email: "dev@example.com",
      password: "mock-password-123",
    });
    assert.equal(auth.ok, true);
    assert.equal(auth.claims.collection, "activity_users");
    assert.equal(auth.claims.subjectType, "human");
  });
});
