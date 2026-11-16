/**
 * Privileged client for the monitor's internal reaper API.
 *
 * The public `/api/sessions` payload deliberately omits process ownership
 * (PID, creation time, executable). The reaper needs that evidence, so it uses
 * a separate endpoint authenticated with an HMAC signature. The signature is
 * computed over the request payload; the monitor verifies it with the same
 * shared secret and never returns the secret or the fencing token to a browser.
 */

import { signControllerRequest } from "./session-reaper.js";

export const REAPER_SIGNATURE_HEADER = "x-devwf-reaper-signature";

/**
 * Fetch the privileged session list.
 *
 * `machine` identifies the caller. When the monitor is configured with
 * per-machine secrets (`DEVWF_REAPER_SECRETS`), the request must name its
 * machine and is verified with that machine's secret only, so one host's
 * credential cannot speak for another.
 *
 * @param {object} options
 * @param {string} options.baseUrl monitor base URL
 * @param {string} options.secret this machine's HMAC secret
 * @param {string} [options.machine] this machine's name
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<Array<object>>}
 */
export async function fetchReaperSessions({ baseUrl, secret, machine, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!secret) throw new Error("secret is required");

  const payload = { action: "list", at: new Date().toISOString() };
  if (machine) payload.machine = String(machine);
  const signature = signControllerRequest(payload, secret);

  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/api/reaper/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [REAPER_SIGNATURE_HEADER]: signature,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`reaper API returned HTTP ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

/**
 * Report a locally verified orphan to the monitor.
 *
 * The controller is the only party that can inspect a process on its own host.
 * This sends the evidence — machine, session, PID, creation time, executable,
 * lease binding, verification time and a single-use nonce — signed with this
 * machine's credential. The monitor revalidates every field against its own row
 * before it archives anything.
 *
 * @param {object} options
 * @param {string} options.baseUrl monitor base URL
 * @param {string} options.secret this machine's HMAC secret
 * @param {string} options.machine this machine's name
 * @param {object} options.attestation the verified orphan evidence
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<{ok: boolean, status: number, error?: string}>}
 */
export async function attestOrphan({ baseUrl, secret, machine, attestation, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!secret) throw new Error("secret is required");
  if (!machine) throw new Error("machine is required");
  if (!attestation) throw new Error("attestation is required");

  const payload = {
    action: "attest",
    at: new Date().toISOString(),
    machine: String(machine),
    sessionKey: String(attestation.sessionKey),
    projectName: String(attestation.projectName),
    pid: Number(attestation.pid),
    startedAt: String(attestation.startedAt),
    executable: String(attestation.executable),
    leaseOwner: String(attestation.leaseOwner || ""),
    leaseGeneration: Number(attestation.leaseGeneration) || 0,
    leaseFencingToken: String(attestation.leaseFencingToken || ""),
    verifiedAt: String(attestation.verifiedAt || new Date().toISOString()),
    nonce: String(attestation.nonce),
  };

  const signature = signControllerRequest(payload, secret);
  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/api/reaper/attest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [REAPER_SIGNATURE_HEADER]: signature,
    },
    body: JSON.stringify(payload),
  });

  if (response.ok) return { ok: true, status: response.status };
  const data = await response.json().catch(() => ({}));
  return { ok: false, status: response.status, error: String(data?.error || `HTTP ${response.status}`) };
}

/**
 * Poll this machine's pending restart commands.
 *
 * Pull-based on purpose: no inbound access to a machine is needed, and the
 * signed credential stays the only authority. The Monitor filters by machine,
 * so one controller never sees another machine's commands.
 */
export async function fetchRestartCommands({ baseUrl, secret, machine, limit, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!secret) throw new Error("secret is required");
  if (!machine) throw new Error("machine is required");

  const payload = { action: "commands", at: new Date().toISOString(), machine: String(machine) };
  if (Number.isFinite(Number(limit))) payload.limit = Number(limit);
  const signature = signControllerRequest(payload, secret);

  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/api/reaper/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [REAPER_SIGNATURE_HEADER]: signature,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) throw new Error(`restart command API returned HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.commands) ? data.commands : [];
}

/**
 * Claim a restart command before executing it. Returns `claimed: false` when
 * another controller already owns it, in which case this controller must not
 * execute it.
 */
export async function claimRestartCommand({ baseUrl, secret, machine, id, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!secret) throw new Error("secret is required");
  if (!machine) throw new Error("machine is required");
  if (!Number.isSafeInteger(Number(id))) throw new Error("a numeric command id is required");

  const payload = { action: "claim", at: new Date().toISOString(), machine: String(machine), id: Number(id) };
  const signature = signControllerRequest(payload, secret);
  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/api/reaper/commands/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", [REAPER_SIGNATURE_HEADER]: signature },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`restart claim API returned HTTP ${response.status}`);
  const data = await response.json().catch(() => ({}));
  return { claimed: Boolean(data?.claimed) };
}

/**
 * Report the outcome of one restart command.
 *
 * The Monitor only applies the update while the command is still pending, so a
 * replayed report is a no-op rather than an overwrite.
 */
export async function reportRestartResult({ baseUrl, secret, machine, id, status, code, detail, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!secret) throw new Error("secret is required");
  if (!machine) throw new Error("machine is required");
  if (!Number.isSafeInteger(Number(id))) throw new Error("a numeric command id is required");

  const payload = {
    action: "result",
    at: new Date().toISOString(),
    machine: String(machine),
    id: Number(id),
    status: String(status),
    code: String(code || ""),
    detail: detail ?? null,
  };
  const signature = signControllerRequest(payload, secret);

  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/api/reaper/commands/result`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [REAPER_SIGNATURE_HEADER]: signature,
    },
    body: JSON.stringify(payload),
  });

  if (response.ok) {
    const data = await response.json().catch(() => ({}));
    return { ok: true, status: response.status, applied: Boolean(data?.applied) };
  }
  const data = await response.json().catch(() => ({}));
  return { ok: false, status: response.status, error: String(data?.error || `HTTP ${response.status}`) };
}

/**
 * Map a privileged reaper row to the shape `session-reaper.js` expects.
 */
export function toReaperSession(row) {
  return {
    session_key: String(row?.session_key || ""),
    machine: String(row?.machine || ""),
    project_name: String(row?.project_name || ""),
    phase: String(row?.phase || ""),
    state: String(row?.state || ""),
    updated_at: row?.updated_at || null,
    owner: row?.owner_pid
      ? {
          pid: Number(row.owner_pid),
          startedAt: String(row?.owner_started_at || ""),
          executable: String(row?.owner_executable || ""),
        }
      : null,
    lease: row?.lease_owner
      ? {
          owner: String(row.lease_owner),
          generation: Number(row.lease_generation) || 0,
          fencingToken: String(row.lease_fencing_token || ""),
        }
      : null,
  };
}
