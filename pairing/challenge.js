import crypto from "node:crypto";

/**
 * In-memory stores for pairing challenges and registered paired devices.
 */
let challenges = new Map();
let pairedDevices = new Map();

/**
 * Gets the current status of a pairing challenge.
 *
 * @param {string} challengeId
 * @returns {{ ok: boolean, status?: string, error?: string }}
 */
export function getChallengeStatus(challengeId) {
  if (!challengeId || !challenges.has(challengeId)) {
    return { ok: false, error: "Challenge not found." };
  }
  const ch = challenges.get(challengeId);
  if (ch.status === "pending" && Date.now() >= ch.expiresAt) {
    ch.status = "expired";
  }
  return { ok: true, status: ch.status, challengeId: ch.challengeId };
}

export function resetPairingStore() {
  challenges.clear();
  pairedDevices.clear();
}

/**
 * Generates an ephemeral cryptographic pairing challenge for a DevWorkflow server.
 *
 * @param {{ serverUrl: string, ttlSeconds?: number }} params
 * @returns {{
 *   challengeId: string,
 *   nonce: string,
 *   verificationCode: string,
 *   serverUrl: string,
 *   fingerprint: string,
 *   expiresAt: number,
 *   qrPayload: string,
 *   status: string
 * }}
 */
export function createPairingChallenge({ serverUrl, ttlSeconds = 180 } = {}) {
  if (!serverUrl || typeof serverUrl !== "string") {
    throw new Error("serverUrl is required to create a pairing challenge.");
  }

  let cleanUrl = serverUrl.trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    throw new Error("serverUrl must start with http:// or https://");
  }
  // Strip trailing slashes
  cleanUrl = cleanUrl.replace(/\/+$/, "");

  const challengeId = `ch_${crypto.randomBytes(8).toString("hex")}`;
  const nonce = crypto.randomBytes(16).toString("hex");

  // 6-digit human-readable verification code formatted as "XXX-XXX"
  const p1 = Math.floor(100 + Math.random() * 900);
  const p2 = Math.floor(100 + Math.random() * 900);
  const verificationCode = `${p1}-${p2}`;

  // Server fingerprint
  const fingerprint = crypto.createHash("sha256").update(cleanUrl).digest("hex").slice(0, 16);

  const expiresAt = Date.now() + ttlSeconds * 1000;

  // Canonical QR payload format: devwf://pair?v=1&url=...&nonce=...&fp=...&ch=...&code=...
  const params = new URLSearchParams({
    v: "1",
    url: cleanUrl,
    ch: challengeId,
    nonce,
    fp: fingerprint,
    code: verificationCode,
  });
  const qrPayload = `devwf://pair?${params.toString()}`;

  const challenge = {
    challengeId,
    nonce,
    verificationCode,
    serverUrl: cleanUrl,
    fingerprint,
    expiresAt,
    qrPayload,
    status: "pending",
    createdAt: Date.now(),
  };

  challenges.set(challengeId, challenge);
  return challenge;
}

/**
 * Verifies an incoming challenge response from an Android companion client.
 *
 * @param {{
 *   challengeId: string,
 *   nonce: string,
 *   deviceName?: string,
 *   clientPublicKey?: string,
 *   providedCode?: string
 * }} params
 * @returns {{
 *   ok: boolean,
 *   deviceId?: string,
 *   deviceToken?: string,
 *   deviceName?: string,
 *   error?: string
 * }}
 */
export function verifyPairingChallenge({
  challengeId,
  nonce,
  deviceName = "Android Companion",
  clientPublicKey = "",
  providedCode = "",
  identityClaims = null,
  requestedScopes = ["monitor:read"],
} = {}) {
  if (!challengeId || !challenges.has(challengeId)) {
    return { ok: false, error: "Invalid challenge or challenge not found." };
  }

  const ch = challenges.get(challengeId);

  // Check TTL expiration
  if (Date.now() >= ch.expiresAt) {
    ch.status = "expired";
    return { ok: false, error: "Pairing challenge has expired." };
  }

  // Single-use constraint: reject if already consumed
  if (ch.status === "consumed") {
    return { ok: false, error: "Pairing challenge already consumed." };
  }

  // Verify nonce match
  if (ch.nonce !== nonce) {
    return { ok: false, error: "Cryptographic nonce mismatch." };
  }

  // If code is provided, verify match
  if (providedCode && providedCode.trim() !== ch.verificationCode) {
    return { ok: false, error: "Verification code mismatch." };
  }

  // If identityClaims were supplied by an IdentityProvider, verify them before consuming challenge
  if (identityClaims !== null && typeof identityClaims === "object") {
    if (identityClaims.ok === false || !identityClaims.subjectId) {
      return {
        ok: false,
        error: identityClaims.error || "Developer identity verification failed.",
      };
    }
    if (identityClaims.subjectType === "service") {
      return {
        ok: false,
        error: "Service credentials cannot be used to pair a personal companion device.",
      };
    }
  }

  // Mark challenge as consumed
  ch.status = "consumed";

  // Register device with least-privilege monitoring scopes (never administrative by default)
  const deviceId = `dev_${crypto.randomBytes(8).toString("hex")}`;
  const deviceToken = `tok_${crypto.randomBytes(24).toString("hex")}`;
  const cleanDeviceName = (typeof deviceName === "string" && deviceName.trim().length > 0)
    ? deviceName.trim()
    : "Android Companion";

  const safeScopes = Array.isArray(requestedScopes)
    ? requestedScopes.filter((s) => s === "monitor:read" || s === "governance:approve")
    : ["monitor:read"];
  if (safeScopes.length === 0) safeScopes.push("monitor:read");

  const ownerId = identityClaims?.subjectId ? String(identityClaims.subjectId) : "local-owner";

  const device = {
    deviceId,
    deviceName: cleanDeviceName,
    deviceToken,
    clientPublicKey: String(clientPublicKey || ""),
    ownerId,
    scopes: safeScopes,
    pairedAt: Date.now(),
    lastSeenAt: Date.now(),
    revoked: false,
  };

  pairedDevices.set(deviceId, device);

  return {
    ok: true,
    deviceId,
    deviceToken,
    deviceName: cleanDeviceName,
    ownerId,
    scopes: safeScopes,
  };
}

/**
 * Returns a list of active and historical paired devices.
 */
export function getPairedDevices() {
  return Array.from(pairedDevices.values()).map((d) => ({
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    pairedAt: d.pairedAt,
    lastSeenAt: d.lastSeenAt,
    revoked: d.revoked,
  }));
}

/**
 * Revokes a paired device, immediately invalidating its access token.
 *
 * @param {string} deviceId
 * @returns {boolean}
 */
export function revokeDevice(deviceId) {
  if (!pairedDevices.has(deviceId)) return false;
  const d = pairedDevices.get(deviceId);
  d.revoked = true;
  return true;
}

/**
 * Validates a bearer device token.
 *
 * @param {string} token
 * @returns {{ ok: boolean, deviceId?: string, deviceName?: string, error?: string }}
 */
export function validateDeviceToken(token) {
  if (!token || typeof token !== "string") {
    return { ok: false, error: "Missing token" };
  }

  for (const device of pairedDevices.values()) {
    if (device.deviceToken === token) {
      if (device.revoked) {
        return { ok: false, error: "Device authorization has been revoked." };
      }
      device.lastSeenAt = Date.now();
      return { ok: true, deviceId: device.deviceId, deviceName: device.deviceName };
    }
  }

  return { ok: false, error: "Unknown or invalid device token." };
}
