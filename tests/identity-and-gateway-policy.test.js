import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalIdentityProvider,
  createPocketBaseIdentityProvider,
  createIdentityProviderFromEnv,
  evaluateGovernanceAuthorization,
  evaluateGatewayToolPolicy,
} from "../security/identity-provider.js";
import {
  createPairingChallenge,
  verifyPairingChallenge,
  validateDeviceToken,
  revokeDevice,
  resetPairingStore,
} from "../pairing/challenge.js";
import { sanitize } from "../security/sanitizer.js";

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig_test`;
}

test("Addendum #4 Suite: IdentityProvider, Gateway Policy, and Pairing Security", async (t) => {
  await t.test("1-3 & 20: Local profile starts and operates without PocketBase or Central Gateway", async () => {
    const provider = createIdentityProviderFromEnv({});
    const caps = await provider.getCapabilities();
    assert.equal(caps.provider, "local");
    assert.equal(caps.supportsOffline, true);

    const auth = await provider.authenticate({ subjectId: "local-dev", name: "Local Engineer" });
    assert.equal(auth.ok, true);
    assert.equal(auth.claims.subjectType, "human");
    assert.equal(auth.claims.provider, "local");
  });

  await t.test("4: Valid developer authentication via PocketBase activity_users", async () => {
    const validToken = makeJwt({
      id: "usr_pb_123",
      collectionId: "col_activity_users",
      collectionName: "activity_users",
      email: "dev@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const pbProvider = createPocketBaseIdentityProvider({
      pocketBaseUrl: "https://pb.example.test",
      fetchImpl: async (url, init) => {
        assert.match(url, /\/api\/collections\/activity_users\/auth-with-password$/);
        const body = JSON.parse(init.body);
        if (body.identity === "dev@example.com" && body.password === "valid-pass") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              token: validToken,
              record: { id: "usr_pb_123", email: "dev@example.com", name: "Dev User", role: "developer" },
            }),
          };
        }
        return { ok: false, status: 400, json: async () => ({ message: "Failed to authenticate." }) };
      },
    });

    const res = await pbProvider.authenticate({ email: "dev@example.com", password: "valid-pass" });
    assert.equal(res.ok, true);
    assert.equal(res.claims.subjectId, "usr_pb_123");
    assert.equal(res.claims.subjectType, "human");
    assert.equal(res.claims.collection, "activity_users");
  });

  await t.test("5: Rejects invalid, expired, or _superusers tokens", async () => {
    const expiredToken = makeJwt({
      id: "usr_pb_123",
      collectionName: "activity_users",
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const superuserToken = makeJwt({
      id: "adm_999",
      collectionName: "_superusers",
      type: "admin",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const pbProvider = createPocketBaseIdentityProvider({
      pocketBaseUrl: "https://pb.example.test",
    });

    const expRes = await pbProvider.validateToken(expiredToken);
    assert.equal(expRes.ok, false);
    assert.match(expRes.error, /expired/i);

    const supRes = await pbProvider.validateToken(superuserToken);
    assert.equal(supRes.ok, false);
    assert.match(supRes.error, /superuser/i);
  });

  await t.test("6: Revoked developer access is immediately rejected", async () => {
    const token = makeJwt({
      id: "usr_revoked_1",
      collectionName: "activity_users",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const pbProvider = createPocketBaseIdentityProvider({
      pocketBaseUrl: "https://pb.example.test",
    });
    pbProvider.revokeSubject("usr_revoked_1");

    const res = await pbProvider.validateToken(token);
    assert.equal(res.ok, false);
    assert.match(res.error, /revoked/i);
  });

  await t.test("7 & 8: Gateway policy enforces tool-level and collection-level restrictions", () => {
    const agentClaims = { subjectId: "agent_1", subjectType: "agent", roles: ["coding_agent"] };

    // Allowed read on shared metadata collection
    const allowedRead = evaluateGatewayToolPolicy({
      toolName: "pb_list_records",
      collection: "notification_logs",
      claims: agentClaims,
    });
    assert.equal(allowedRead.allowed, true);

    // Blocked access to _superusers
    const blockedSuperusers = evaluateGatewayToolPolicy({
      toolName: "pb_list_records",
      collection: "_superusers",
      claims: agentClaims,
    });
    assert.equal(blockedSuperusers.allowed, false);
    assert.match(blockedSuperusers.reason, /_superusers/i);

    // Blocked write to retired activity_tasks collection
    const blockedLegacyTasks = evaluateGatewayToolPolicy({
      toolName: "pb_create_record",
      collection: "activity_tasks",
      claims: agentClaims,
    });
    assert.equal(blockedLegacyTasks.allowed, false);
    assert.match(blockedLegacyTasks.reason, /activity_tasks.*retired/i);

    // Blocked mutation to activity_users by agent
    const blockedUserWrite = evaluateGatewayToolPolicy({
      toolName: "pb_update_record",
      collection: "activity_users",
      claims: agentClaims,
    });
    assert.equal(blockedUserWrite.allowed, false);

    // Blocked destructive delete without explicit human authorization
    const blockedDelete = evaluateGatewayToolPolicy({
      toolName: "pb_delete_record",
      collection: "notification_logs",
      claims: agentClaims,
    });
    assert.equal(blockedDelete.allowed, false);
  });

  await t.test("9: Service credential leakage prevention via runtime secret registration", async () => {
    const secretPass = " ultra_secret_pb_pass_9911 ";
    const pbProvider = createPocketBaseIdentityProvider({
      pocketBaseUrl: "https://pb.example.test",
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });
    await pbProvider.authenticate({ email: "svc@example.com", password: secretPass.trim() });
    const sanitizedText = sanitize(`Failed login with password ${secretPass.trim()} on server`);
    assert.ok(!sanitizedText.includes(secretPass.trim()), "Password must be redacted by sanitizer");
  });

  await t.test("10, 11 & 19: Outage isolation and recovery when PocketBase is unreachable", async () => {
    let isDown = true;
    const pbProvider = createPocketBaseIdentityProvider({
      pocketBaseUrl: "https://pb.example.test",
      fetchImpl: async () => {
        if (isDown) throw new Error("ECONNREFUSED PocketBase offline");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            token: makeJwt({
              id: "usr_recovered",
              collectionName: "activity_users",
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
            record: { id: "usr_recovered", email: "dev@example.com" },
          }),
        };
      },
    });

    const outageRes = await pbProvider.authenticate({ email: "dev@example.com", password: "pw" });
    assert.equal(outageRes.ok, false);
    assert.equal(outageRes.serviceUnavailable, true);

    // Sensitive governance action fails closed when identity cannot be verified
    const govDecision = evaluateGovernanceAuthorization({
      claims: null,
      action: "approve_gate",
    });
    assert.equal(govDecision.allowed, false);

    // Recovery after outage resolves
    isDown = false;
    const recoveredRes = await pbProvider.authenticate({ email: "dev@example.com", password: "pw" });
    assert.equal(recoveredRes.ok, true);
    assert.equal(recoveredRes.claims.subjectId, "usr_recovered");
  });

  await t.test("15, 16, 17 & 18: Android pairing with IdentityProvider, service token rejection, and device revocation", async () => {
    resetPairingStore();
    const challenge = createPairingChallenge({ serverUrl: "http://127.0.0.1:3100" });

    // 16: Pairing with unauthorized identity fails
    const unauthorizedVerify = verifyPairingChallenge({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      deviceName: "Xiaomi Pad 6",
      identityClaims: { ok: false, error: "Invalid developer identity" },
    });
    assert.equal(unauthorizedVerify.ok, false);
    assert.match(unauthorizedVerify.error, /identity/i);

    // Challenge was not consumed by failed identity check; now pair with valid human identity (15)
    const validVerify = verifyPairingChallenge({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      deviceName: "Xiaomi Pad 6",
      identityClaims: {
        ok: true,
        subjectId: "usr_pb_123",
        subjectType: "human",
        email: "dev@example.com",
        roles: ["developer"],
      },
    });
    assert.equal(validVerify.ok, true);
    assert.deepEqual(validVerify.scopes, ["monitor:read"]);
    assert.equal(validVerify.ownerId, "usr_pb_123");
    assert.equal(validVerify.serviceToken, undefined);

    // 12: Replay protection - second attempt on same challenge is rejected
    const replayAttempt = verifyPairingChallenge({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      deviceName: "Xiaomi Pad 6",
    });
    assert.equal(replayAttempt.ok, false);
    assert.match(replayAttempt.error, /consumed/i);

    // 17: Approval request using an automated service token instead of human authorization is rejected
    const serviceApproval = evaluateGovernanceAuthorization({
      claims: {
        subjectId: "svc_background_bot",
        subjectType: "service",
        roles: ["background_worker"],
      },
      action: "approve_gate",
    });
    assert.equal(serviceApproval.allowed, false);
    assert.match(serviceApproval.reason, /service.*human/i);

    // Human developer approval is allowed
    const humanApproval = evaluateGovernanceAuthorization({
      claims: {
        subjectId: "usr_pb_123",
        subjectType: "human",
        roles: ["developer"],
      },
      action: "approve_gate",
    });
    assert.equal(humanApproval.allowed, true);

    // 18: Device revocation immediately invalidates device token
    revokeDevice(validVerify.deviceId);
    const tokenCheck = validateDeviceToken(validVerify.deviceToken);
    assert.equal(tokenCheck.ok, false);
    assert.match(tokenCheck.error, /revoked/i);
  });
});
