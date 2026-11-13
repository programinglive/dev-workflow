import { normalizeServerUrl } from "./server-profile.js";

/**
 * Parses raw pairing payload string (devwf://pair URI or JSON string).
 *
 * @param {string} payloadStr
 * @returns {{
 *   ok: boolean,
 *   data?: {
 *     version: string,
 *     serverUrl: string,
 *     challengeId: string,
 *     nonce: string,
 *     fingerprint: string,
 *     verificationCode: string,
 *   },
 *   error?: string
 * }}
 */
export function parsePairingPayload(payloadStr) {
  if (!payloadStr || typeof payloadStr !== "string") {
    return { ok: false, error: "Pairing payload must be a non-empty string." };
  }

  const trimmed = payloadStr.trim();

  // Try JSON format first if starts with {
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      const serverUrl = parsed.url || parsed.serverUrl;
      const challengeId = parsed.ch || parsed.challengeId;
      const nonce = parsed.nonce;
      const verificationCode = parsed.code || parsed.verificationCode || "";
      const fingerprint = parsed.fp || parsed.fingerprint || "";
      const version = String(parsed.v || parsed.version || "1");

      if (!serverUrl || !challengeId || !nonce) {
        return { ok: false, error: "JSON payload missing url, ch, or nonce." };
      }

      const norm = normalizeServerUrl(serverUrl);
      if (!norm.ok) {
        return { ok: false, error: norm.error || "Invalid server URL." };
      }

      return {
        ok: true,
        data: {
          version,
          serverUrl: norm.url,
          challengeId,
          nonce,
          fingerprint,
          verificationCode,
        },
      };
    } catch {
      return { ok: false, error: "Invalid JSON format." };
    }
  }

  // devwf://pair?v=1&url=...&ch=...&nonce=...&fp=...&code=...
  if (!trimmed.startsWith("devwf://pair")) {
    return { ok: false, error: "Invalid pairing payload URI scheme. Expected devwf://pair" };
  }

  try {
    const qIdx = trimmed.indexOf("?");
    if (qIdx === -1) {
      return { ok: false, error: "Pairing URI query parameters missing." };
    }

    const qs = trimmed.slice(qIdx + 1);
    const params = new URLSearchParams(qs);

    const version = params.get("v") || "1";
    const rawUrl = params.get("url");
    const challengeId = params.get("ch");
    const nonce = params.get("nonce");
    const fingerprint = params.get("fp") || "";
    const verificationCode = params.get("code") || "";

    if (!rawUrl || !challengeId || !nonce) {
      return { ok: false, error: "Pairing URI missing url, ch, or nonce parameters." };
    }

    const norm = normalizeServerUrl(rawUrl);
    if (!norm.ok) {
      return { ok: false, error: norm.error || "Invalid server URL." };
    }

    return {
      ok: true,
      data: {
        version,
        serverUrl: norm.url,
        challengeId,
        nonce,
        fingerprint,
        verificationCode,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message || "Failed to parse pairing URI." };
  }
}

/**
 * Executes pairing handshake with the target DevWorkflow server.
 *
 * @param {{
 *   qrPayload: string,
 *   deviceName?: string,
 *   fetchFn?: Function,
 * }} params
 * @returns {Promise<{
 *   ok: boolean,
 *   serverUrl?: string,
 *   deviceId?: string,
 *   deviceToken?: string,
 *   deviceName?: string,
 *   error?: string
 * }>}
 */
export async function executePairingHandshake({
  qrPayload,
  deviceName = "Android Companion",
  fetchFn = fetch,
} = {}) {
  const parsed = parsePairingPayload(qrPayload);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const { serverUrl, challengeId, nonce, verificationCode } = parsed.data;

  try {
    const endpoint = `${serverUrl}/api/v1/mobile/pair/verify`;
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        challengeId,
        nonce,
        deviceName,
        providedCode: verificationCode,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      return {
        ok: false,
        error: (data && data.error) || `Handshake rejected with HTTP ${res.status}`,
      };
    }

    return {
      ok: true,
      serverUrl,
      deviceId: data.deviceId,
      deviceToken: data.deviceToken,
      deviceName: data.deviceName || deviceName,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Network request failed: ${err.message || String(err)}`,
    };
  }
}

/**
 * Handshakes, saves the paired profile into the store, and makes it active.
 *
 * @param {{
 *   qrPayload: string,
 *   profileStore: import("./server-profile.js").ServerProfileStore,
 *   profileName?: string,
 *   deviceName?: string,
 *   fetchFn?: Function,
 * }} params
 * @returns {Promise<{
 *   ok: boolean,
 *   profile?: import("./server-profile.js").ServerProfile,
 *   error?: string
 * }>}
 */
export async function completePairingAndSaveProfile({
  qrPayload,
  profileStore,
  profileName,
  deviceName = "Android Companion",
  fetchFn = fetch,
} = {}) {
  const handshake = await executePairingHandshake({
    qrPayload,
    deviceName,
    fetchFn,
  });

  if (!handshake.ok) {
    return { ok: false, error: handshake.error };
  }

  const name = (profileName && profileName.trim())
    ? profileName.trim()
    : `Paired (${handshake.deviceName})`;

  const profile = profileStore.addProfile({
    name,
    url: handshake.serverUrl,
    token: handshake.deviceToken,
    deviceId: handshake.deviceId,
  });

  return {
    ok: true,
    profile,
  };
}
