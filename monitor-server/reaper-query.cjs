'use strict';

/**
 * Privileged query and request verification for the session reaper.
 *
 * The public /api/sessions payload deliberately omits process ownership. This
 * module is the only place that selects owner_pid, owner_started_at,
 * owner_executable and the lease fields, and it is reachable only through the
 * HMAC-authenticated /api/reaper/sessions endpoint.
 *
 * PER-MACHINE CREDENTIALS
 * -----------------------
 * A single shared secret means one leaked key compromises every machine and
 * cannot be rotated for one host without breaking the others. `DEVWF_REAPER_SECRETS`
 * is a JSON object of machine name to secret:
 *
 *   DEVWF_REAPER_SECRETS={"MMCH":"...","HELLOWORLD":"...","Mac":"..."}
 *
 * When that map is configured, the request must name its machine and is verified
 * with that machine's secret only. Removing an entry revokes exactly one machine.
 * `DEVWF_REAPER_SECRET` remains supported as a single-machine fallback so an
 * existing deployment keeps working while it migrates.
 */

const { createHmac, timingSafeEqual } = require('node:crypto');

const REPLAY_WINDOW_MS = 60_000;

function buildReaperSessionsQuery({ limit = 200 } = {}) {
  const bounded = Math.min(500, Math.max(1, Number(limit) || 200));
  return {
    sql: `SELECT session_key, task_id, machine, project_name, phase, updated_at,
                 owner_pid, owner_started_at, owner_executable,
                 lease_owner, lease_generation, lease_fencing_token
            FROM sessions
           WHERE phase NOT IN ('closed', 'done', 'cancelled', 'handed-off')
           ORDER BY updated_at DESC
           LIMIT $1`,
    params: [bounded],
  };
}

function canonicalPayload(payload) {
  return JSON.stringify(payload || {});
}

/**
 * Parse the per-machine secret map. A malformed value yields an empty map, which
 * falls back to the single secret instead of silently authorizing everyone.
 */
function parseReaperSecrets(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [machine, secret] of Object.entries(parsed)) {
    const name = String(machine || '').trim();
    const value = String(secret || '');
    if (name && value) out[name] = value;
  }
  return out;
}

/**
 * Pick the credential that is allowed to speak for this machine.
 *
 * @returns {{ok: boolean, reason?: string, secret?: string, machine?: string}}
 */
function resolveReaperSecret({ machine, secrets, secret } = {}) {
  const map = secrets && typeof secrets === 'object' ? secrets : {};
  const names = Object.keys(map);

  if (names.length > 0) {
    const name = String(machine || '').trim();
    if (!name) return { ok: false, reason: 'MACHINE_REQUIRED' };
    if (!map[name]) return { ok: false, reason: 'MACHINE_NOT_AUTHORIZED' };
    return { ok: true, secret: map[name], machine: name };
  }

  if (!secret) return { ok: false, reason: 'REAPER_SECRET_MISSING' };
  return { ok: true, secret: String(secret), machine: String(machine || '').trim() };
}

/**
 * Verify an HMAC-signed reaper request.
 *
 * The payload must carry an ISO `at` timestamp inside the replay window. The
 * signature covers the canonical JSON of the whole payload, so changing the
 * action, the machine, the limit or the timestamp invalidates it.
 */
function verifyReaperRequest({ payload, signature, secret, secrets, now = Date.now() } = {}) {
  const resolved = resolveReaperSecret({ machine: payload && payload.machine, secrets, secret });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const at = payload && payload.at ? Date.parse(payload.at) : NaN;
  if (!Number.isFinite(at) || Math.abs(now - at) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'REPLAY_WINDOW_EXCEEDED' };
  }

  const expected = createHmac('sha256', String(resolved.secret))
    .update(canonicalPayload(payload))
    .digest('hex');
  const provided = String(signature || '');
  if (expected.length !== provided.length) return { ok: false, reason: 'SIGNATURE_MISMATCH' };
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    return { ok: false, reason: 'SIGNATURE_MISMATCH' };
  }

  return { ok: true, machine: resolved.machine };
}

module.exports = {
  REPLAY_WINDOW_MS,
  buildReaperSessionsQuery,
  parseReaperSecrets,
  resolveReaperSecret,
  verifyReaperRequest,
};
