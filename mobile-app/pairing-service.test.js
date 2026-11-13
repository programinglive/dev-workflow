import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePairingPayload,
  executePairingHandshake,
  completePairingAndSaveProfile,
} from "./pairing-service.js";
import { ServerProfileStore } from "./server-profile.js";

describe("mobile-app pairing-service", () => {
  const sampleUri = "devwf://pair?v=1&url=http%3A%2F%2F127.0.0.1%3A3100&ch=ch_abc123&nonce=deadbeef0123456789abcdef&fp=fedcba9876543210&code=482-913";

  describe("parsePairingPayload", () => {
    it("successfully parses valid devwf://pair URI", () => {
      const res = parsePairingPayload(sampleUri);
      assert.equal(res.ok, true);
      assert.equal(res.data.version, "1");
      assert.equal(res.data.serverUrl, "http://127.0.0.1:3100");
      assert.equal(res.data.challengeId, "ch_abc123");
      assert.equal(res.data.nonce, "deadbeef0123456789abcdef");
      assert.equal(res.data.fingerprint, "fedcba9876543210");
      assert.equal(res.data.verificationCode, "482-913");
    });

    it("parses JSON payload format as fallback", () => {
      const jsonStr = JSON.stringify({
        url: "http://192.168.1.50:3100",
        ch: "ch_xyz999",
        nonce: "1122334455667788",
        code: "999-000",
      });
      const res = parsePairingPayload(jsonStr);
      assert.equal(res.ok, true);
      assert.equal(res.data.serverUrl, "http://192.168.1.50:3100");
      assert.equal(res.data.challengeId, "ch_xyz999");
      assert.equal(res.data.nonce, "1122334455667788");
      assert.equal(res.data.verificationCode, "999-000");
    });

    it("rejects invalid payloads with missing critical fields", () => {
      assert.equal(parsePairingPayload("").ok, false);
      assert.equal(parsePairingPayload("invalid-text").ok, false);
      assert.equal(parsePairingPayload("devwf://pair?url=http://localhost:3100").ok, false); // missing ch & nonce
      assert.equal(parsePairingPayload("http://example.com").ok, false);
    });
  });

  describe("executePairingHandshake", () => {
    it("performs successful POST handshake to /api/v1/mobile/pair/verify", async () => {
      const fakeFetch = async (url, options) => {
        assert.equal(url, "http://127.0.0.1:3100/api/v1/mobile/pair/verify");
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        assert.equal(body.challengeId, "ch_abc123");
        assert.equal(body.nonce, "deadbeef0123456789abcdef");
        assert.equal(body.providedCode, "482-913");
        assert.equal(body.deviceName, "Xiaomi Pad 6 Desk Cockpit");

        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            deviceId: "dev_9876",
            deviceToken: "tok_secret_access_token_123",
            deviceName: "Xiaomi Pad 6 Desk Cockpit",
          }),
        };
      };

      const result = await executePairingHandshake({
        qrPayload: sampleUri,
        deviceName: "Xiaomi Pad 6 Desk Cockpit",
        fetchFn: fakeFetch,
      });

      assert.equal(result.ok, true);
      assert.equal(result.deviceId, "dev_9876");
      assert.equal(result.deviceToken, "tok_secret_access_token_123");
      assert.equal(result.serverUrl, "http://127.0.0.1:3100");
    });

    it("returns error on server rejection (400)", async () => {
      const fakeFetch = async () => ({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error: "Pairing challenge has expired." }),
      });

      const result = await executePairingHandshake({
        qrPayload: sampleUri,
        fetchFn: fakeFetch,
      });

      assert.equal(result.ok, false);
      assert.match(result.error, /expired/i);
    });

    it("handles network failure cleanly", async () => {
      const fakeFetch = async () => {
        throw new Error("Network request failed: Connection refused");
      };

      const result = await executePairingHandshake({
        qrPayload: sampleUri,
        fetchFn: fakeFetch,
      });

      assert.equal(result.ok, false);
      assert.match(result.error, /Network request failed/i);
    });
  });

  describe("completePairingAndSaveProfile", () => {
    it("creates paired profile in ServerProfileStore and activates it", async () => {
      const store = new ServerProfileStore();
      const fakeFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          deviceId: "dev_mi_pad_6",
          deviceToken: "tok_paired_token_999",
          deviceName: "Xiaomi Pad 6",
        }),
      });

      const result = await completePairingAndSaveProfile({
        qrPayload: sampleUri,
        profileStore: store,
        profileName: "Office Server (Paired)",
        deviceName: "Xiaomi Pad 6",
        fetchFn: fakeFetch,
      });

      assert.equal(result.ok, true);
      assert.ok(result.profile.id);
      assert.equal(result.profile.token, "tok_paired_token_999");
      assert.equal(result.profile.deviceId, "dev_mi_pad_6");
      assert.equal(store.getActiveProfile().id, result.profile.id);
    });
  });
});
