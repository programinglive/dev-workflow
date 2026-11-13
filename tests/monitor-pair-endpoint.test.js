import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createPairingChallenge,
  verifyPairingChallenge,
  getChallengeStatus,
  resetPairingStore,
} from "../pairing/challenge.js";

const require = createRequire(import.meta.url);
const {
  handlePairVerify,
  handlePairStatus,
} = require("../monitor-server/mobile-pair-route.cjs");

describe("Mobile Pairing Route Handler", () => {
  beforeEach(() => {
    resetPairingStore();
  });

  describe("handlePairVerify", () => {
    test("successfully verifies valid pairing challenge and returns 200", async () => {
      const ch = createPairingChallenge({ serverUrl: "http://127.0.0.1:3100" });

      const result = await handlePairVerify({
        body: {
          challengeId: ch.challengeId,
          nonce: ch.nonce,
          deviceName: "Xiaomi Pad 6 Cockpit",
          providedCode: ch.verificationCode,
        },
        pairingEngine: { verifyPairingChallenge },
      });

      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.ok(result.body.deviceId.startsWith("dev_"));
      assert.ok(result.body.deviceToken.startsWith("tok_"));
      assert.equal(result.body.deviceName, "Xiaomi Pad 6 Cockpit");
    });

    test("returns 400 when challengeId or nonce is missing", async () => {
      const result = await handlePairVerify({
        body: { deviceName: "Test" },
        pairingEngine: { verifyPairingChallenge },
      });

      assert.equal(result.status, 400);
      assert.equal(result.body.ok, false);
      assert.match(result.body.error, /required/i);
    });

    test("returns 400 when challenge verification fails in pairing engine", async () => {
      const ch = createPairingChallenge({ serverUrl: "http://127.0.0.1:3100" });

      const result = await handlePairVerify({
        body: {
          challengeId: ch.challengeId,
          nonce: "wrong_nonce",
        },
        pairingEngine: { verifyPairingChallenge },
      });

      assert.equal(result.status, 400);
      assert.equal(result.body.ok, false);
      assert.match(result.body.error, /mismatch/i);
    });
  });

  describe("handlePairStatus", () => {
    test("returns 200 with status for active challenge", async () => {
      const ch = createPairingChallenge({ serverUrl: "http://127.0.0.1:3100" });

      const result = await handlePairStatus({
        queryParams: new URLSearchParams(`ch=${ch.challengeId}`),
        pairingEngine: { getChallengeStatus },
      });

      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.status, "pending");
    });

    test("returns 404 when challenge not found", async () => {
      const result = await handlePairStatus({
        queryParams: new URLSearchParams("ch=ch_unknown"),
        pairingEngine: { getChallengeStatus },
      });

      assert.equal(result.status, 404);
      assert.equal(result.body.ok, false);
    });

    test("returns 400 when ch query param is missing", async () => {
      const result = await handlePairStatus({
        queryParams: new URLSearchParams(""),
        pairingEngine: { getChallengeStatus },
      });

      assert.equal(result.status, 400);
      assert.equal(result.body.ok, false);
    });
  });

  describe("HTTP Server Endpoint Integration", () => {
    test("serves POST /api/v1/mobile/pair/verify and OPTIONS preflight over HTTP", async () => {
      const http = await import("node:http");
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname === "/api/v1/mobile/pair/verify") {
          res.setHeader("access-control-allow-origin", "*");
          res.setHeader("access-control-allow-methods", "POST, OPTIONS");
          res.setHeader("access-control-allow-headers", "content-type, authorization, x-device-token");
          if (req.method === "OPTIONS") {
            res.writeHead(204);
            return res.end();
          }
          if (req.method === "POST") {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const result = await handlePairVerify({ body, pairingEngine: { verifyPairingChallenge } });
            res.writeHead(result.status, { "content-type": "application/json" });
            return res.end(JSON.stringify(result.body));
          }
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        // Test OPTIONS preflight
        const optRes = await fetch(`${baseUrl}/api/v1/mobile/pair/verify`, {
          method: "OPTIONS",
        });
        assert.equal(optRes.status, 204);
        assert.equal(optRes.headers.get("access-control-allow-origin"), "*");

        // Create challenge and test POST verify
        const ch = createPairingChallenge({ serverUrl: baseUrl });
        const postRes = await fetch(`${baseUrl}/api/v1/mobile/pair/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            challengeId: ch.challengeId,
            nonce: ch.nonce,
            deviceName: "Xiaomi Pad 6 Companion",
            providedCode: ch.verificationCode,
          }),
        });
        assert.equal(postRes.status, 200);
        const data = await postRes.json();
        assert.equal(data.ok, true);
        assert.ok(data.deviceToken.startsWith("tok_"));
        assert.equal(data.deviceName, "Xiaomi Pad 6 Companion");
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
