'use strict';

/**
 * Privileged query and request verification for the session reaper.
 *
 * The public /api/sessions payload deliberately omits process ownership. This
 * module is the only place that selects owner_pid, owner_started_at,
 * owner_executable and the lease fields, and it is reachable only through the
 * HMAC-authenticated /api/reaper/sessions endpoint.
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
 * Verify an HMAC-signed reaper request.
 *
 * The payload must carry an ISO `at` timestamp inside the replay window. The
 * signature covers the canonical JSON of the whole payload, so changing the
 * action, the limit or the timestamp invalidates it.
 */
function verifyReaperRequest({ payload, signature, secret, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'REAPER_SECRET_MISSING' };

  const at = payload && payload.at ? Date.parse(payload.at) : NaN;
  if (!Number.isFinite(at) || Math.abs(now - at) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'REPLAY_WINDOW_EXCEEDED' };
  }

  const expected = createHmac('sha256', String(secret)).update(canonicalPayload(payload)).digest('hex');
  const provided = String(signature || '');
  if (expected.length !== provided.length) return { ok: false, reason: 'SIGNATURE_MISMATCH' };
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    return { ok: false, reason: 'SIGNATURE_MISMATCH' };
  }

  return { ok: true };
}

module.exports = { buildReaperSessionsQuery, verifyReaperRequest, REPLAY_WINDOW_MS };
