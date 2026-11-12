import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPairingChallenge,
  verifyPairingChallenge,
  getChallengeStatus,
  getPairedDevices,
  revokeDevice,
  validateDeviceToken,
  resetPairingStore,
} from "../pairing/challenge.js";

describe("Pairing Challenge Engine", () => {
  beforeEach(() => {
    resetPairingStore();
  });

  describe("createPairingChallenge", () => {
    it("generates a challenge with unique id, nonce, verification code, and 3-minute TTL", () => {
      const challenge = createPairingChallenge({ serverUrl: "http://100.77.138.14:3100" });
      assert.ok(challenge.challengeId.startsWith("ch_"));
      assert.equal(typeof challenge.nonce, "string");
      assert.equal(challenge.nonce.length >= 16, true);
      assert.match(challenge.verificationCode, /^\d{3}-\d{3}$/);
      assert.equal(challenge.serverUrl, "http://100.77.138.14:3100");
      assert.ok(challenge.expiresAt > Date.now());
      assert.ok(challenge.qrPayload.startsWith("devwf://pair?v=1"));
      assert.ok(challenge.qrPayload.includes("url="));
      assert.ok(challenge.qrPayload.includes("nonce="));
    });

    it("rejects invalid serverUrl on challenge creation", () => {
      assert.throws(() => createPairingChallenge({ serverUrl: "" }), /serverUrl/);
      assert.throws(() => createPairingChallenge({ serverUrl: "ftp://bad" }), /http/);
    });
  });

  describe("verifyPairingChallenge", () => {
    it("successfully verifies valid challenge, marks consumed, and issues device token", () => {
      const ch = createPairingChallenge({ serverUrl: "http://100.77.138.14:3100" });
      const res = verifyPairingChallenge({
        challengeId: ch.challengeId,
        nonce: ch.nonce,
        deviceName: "Xiaomi Pad 6 (Desk)",
        clientPublicKey: "test-pubkey-sample",
        providedCode: ch.verificationCode,
      });

      assert.equal(res.ok, true);
      assert.ok(res.deviceId.startsWith("dev_"));
      assert.ok(res.deviceToken.startsWith("tok_"));
      assert.equal(res.deviceName, "Xiaomi Pad 6 (Desk)");

      // Device is now in registry
      const devices = getPairedDevices();
      assert.equal(devices.length, 1);
      assert.equal(devices[0].deviceId, res.deviceId);
      assert.equal(devices[0].deviceName, "Xiaomi Pad 6 (Desk)");

      // Token validates
      const valid = validateDeviceToken(res.deviceToken);
      assert.equal(valid.ok, true);
      assert.equal(valid.deviceId, res.deviceId);
    });

    it("rejects challenge reuse (single-use constraint)", () => {
      const ch = createPairingChallenge({ serverUrl: "http://100.77.138.14:3100" });
      const first = verifyPairingChallenge({
        challengeId: ch.challengeId,
        nonce: ch.nonce,
        deviceName: "Device 1",
      });
      assert.equal(first.ok, true);

      const second = verifyPairingChallenge({
        challengeId: ch.challengeId,
        nonce: ch.nonce,
        deviceName: "Device 2",
      });
      assert.equal(second.ok, false);
      assert.match(second.error, /already consumed|invalid challenge/i);
    });

    it("rejects challenge when nonce does not match", () => {
      const ch = createPairingChallenge({ serverUrl: "http://100.77.138.14:3100" });
      const res = verifyPairingChallenge({
        challengeId: ch.challengeId,
        nonce: "wrong-nonce-value",
        deviceName: "Device",
      });
      assert.equal(res.ok, false);
      assert.match(res.error, /nonce mismatch/i);
    });

    it("rejects challenge when expired", () => {
      // Create challenge with -1s TTL
      const ch = createPairingChallenge({ serverUrl: "http://100.77.138.14:3100", ttlSeconds: -1 });
      const res = verifyPairingChallenge({
        challengeId: ch.challengeId,
        nonce: ch.nonce,
        deviceName: "Device",
      });
      assert.equal(res.ok, false);
      assert.match(res.error, /expired/i);
    });
  });

  describe("Device Revocation", () => {
    it("revokes an active device token", () => {
      const ch = createPairingChallenge({ serverUrl: "http://100.77.138.14:3100" });
      const paired = verifyPairingChallenge({
        challengeId: ch.challengeId,
        nonce: ch.nonce,
        deviceName: "Device",
      });

      assert.equal(validateDeviceToken(paired.deviceToken).ok, true);

      const revoked = revokeDevice(paired.deviceId);
      assert.equal(revoked, true);

      // Now invalid
      assert.equal(validateDeviceToken(paired.deviceToken).ok, false);
    });
  });

  describe("Challenge Status", () => {
    it("returns status for existing and non-existing challenges", () => {
      const ch = createPairingChallenge({ serverUrl: "http://100.77.138.14:3100" });
      const st1 = getChallengeStatus(ch.challengeId);
      assert.equal(st1.ok, true);
      assert.equal(st1.status, "pending");

      const notFound = getChallengeStatus("ch_nonexistent");
      assert.equal(notFound.ok, false);
    });
  });
});
