'use strict';

/**
 * Controller-to-monitor orphan attestation.
 *
 * A machine controller is the only party that can inspect a process on its own
 * host. The monitor cannot, so it must accept the controller's word — but only
 * a word that is authenticated, fresh, single-use, and bound to the exact
 * session, process identity and lease generation the monitor already holds.
 *
 * WHAT IS BOUND
 * -------------
 * An attestation is worthless unless it describes the same thing the database
 * describes. `revalidateAttestation()` compares every field against the current
 * row: machine, PID, process creation time, executable, lease owner, lease
 * generation and fencing token. A row that changed since the attestation was
 * produced invalidates it.
 *
 * REPLAY
 * ------
 * Each attestation carries a nonce. The nonce is unique per machine in the
 * database, so a captured request cannot be replayed. The attestation also
 * carries `verifiedAt` and expires after ATTESTATION_TTL_MS.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a kill order and not a lease release. It says "this process is
 * gone". Archiving and lease reconciliation are separate decisions the caller
 * makes after revalidation.
 */

const ATTESTATION_TTL_MS = 15 * 60 * 1000;

/** The fields an attestation must carry to be considered complete. */
const REQUIRED_FIELDS = [
  'machine',
  'sessionKey',
  'projectName',
  'pid',
  'startedAt',
  'executable',
  'verifiedAt',
  'nonce',
];

/**
 * Validate the shape of a submitted attestation.
 *
 * @returns {{ok: boolean, reason?: string, value?: object}}
 */
function parseAttestation(payload, { now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'ATTESTATION_INVALID' };

  for (const field of REQUIRED_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      return { ok: false, reason: `ATTESTATION_MISSING_${field.toUpperCase()}` };
    }
  }

  const pid = Number(payload.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'ATTESTATION_PID_INVALID' };

  const verifiedAt = Date.parse(payload.verifiedAt);
  if (!Number.isFinite(verifiedAt)) return { ok: false, reason: 'ATTESTATION_TIMESTAMP_INVALID' };

  // A timestamp in the future is as untrustworthy as an old one: it would let a
  // controller keep an attestation valid by lying about when it observed.
  if (verifiedAt - now > 60_000) return { ok: false, reason: 'ATTESTATION_FROM_FUTURE' };
  if (now - verifiedAt > ATTESTATION_TTL_MS) return { ok: false, reason: 'ATTESTATION_EXPIRED' };

  const nonce = String(payload.nonce).trim();
  if (nonce.length < 8 || nonce.length > 200) return { ok: false, reason: 'ATTESTATION_NONCE_INVALID' };

  return {
    ok: true,
    value: {
      machine: String(payload.machine).trim(),
      sessionKey: String(payload.sessionKey).trim(),
      projectName: String(payload.projectName).trim(),
      pid,
      startedAt: String(payload.startedAt).trim(),
      executable: String(payload.executable).trim(),
      leaseOwner: String(payload.leaseOwner || '').trim(),
      leaseGeneration: Number(payload.leaseGeneration) || 0,
      leaseFencingToken: String(payload.leaseFencingToken || '').trim(),
      verifiedAt: new Date(verifiedAt).toISOString(),
      nonce,
    },
  };
}

/**
 * Compare an attestation with the current database row.
 *
 * Every mismatch is a distinct reason, because the operator needs to know
 * whether the process came back, the PID was reused, or the lease moved.
 *
 * Freshness is checked here as well as at the endpoint. The endpoint checks the
 * TTL when the report arrives; the scheduler reads the stored row later, and
 * without this check a stored attestation would stay actionable forever. A
 * process that was absent an hour ago may have had its PID reused since.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function revalidateAttestation(attestation, row, { now = Date.now() } = {}) {
  if (!attestation) return { ok: false, reason: 'ATTESTATION_MISSING' };
  if (!row) return { ok: false, reason: 'SESSION_MISSING' };

  const verifiedAt = Date.parse(attestation.verifiedAt);
  if (!Number.isFinite(verifiedAt)) return { ok: false, reason: 'ATTESTATION_TIMESTAMP_INVALID' };
  if (verifiedAt - now > 60_000) return { ok: false, reason: 'ATTESTATION_FROM_FUTURE' };
  if (now - verifiedAt > ATTESTATION_TTL_MS) return { ok: false, reason: 'ATTESTATION_EXPIRED' };

  if (String(row.machine || '') !== attestation.machine) {
    return { ok: false, reason: 'MACHINE_CHANGED' };
  }
  if (String(row.project_name || '') !== attestation.projectName) {
    return { ok: false, reason: 'PROJECT_BINDING_CHANGED' };
  }

  const rowPid = Number(row.owner_pid);
  if (!Number.isInteger(rowPid) || rowPid <= 0) return { ok: false, reason: 'OWNER_MISSING' };
  if (rowPid !== attestation.pid) return { ok: false, reason: 'PID_CHANGED' };

  if (String(row.owner_started_at || '') !== attestation.startedAt) {
    return { ok: false, reason: 'PROCESS_CREATION_TIME_CHANGED' };
  }
  if (String(row.owner_executable || '') !== attestation.executable) {
    return { ok: false, reason: 'EXECUTABLE_CHANGED' };
  }

  // Lease binding. An empty lease on either side must match an empty lease on
  // the other, so a session that gained a lease since the attestation is
  // rejected instead of silently cleaned.
  const rowLeaseOwner = String(row.lease_owner || '');
  const rowGeneration = Number(row.lease_generation) || 0;
  const rowFencing = String(row.lease_fencing_token || '');

  if (rowLeaseOwner !== attestation.leaseOwner) return { ok: false, reason: 'LEASE_OWNER_CHANGED' };
  if (rowGeneration !== attestation.leaseGeneration) return { ok: false, reason: 'LEASE_GENERATION_CHANGED' };
  if (rowFencing !== attestation.leaseFencingToken) return { ok: false, reason: 'LEASE_FENCING_CHANGED' };

  return { ok: true };
}

/**
 * Build the SQL that archives a session only when its identity is unchanged.
 *
 * This is deliberately conditional. The attestation was revalidated against a
 * read; the row could still change before the write, so the write repeats the
 * identity check and reports zero rows updated when it lost the race.
 */
function buildArchiveQuery(attestation) {
  return {
    sql: `UPDATE sessions
             SET phase = 'closed', updated_at = now()
           WHERE session_key = $1
             AND machine = $2
             AND project_name = $3
             AND owner_pid = $4
             AND owner_started_at = $5
             AND owner_executable = $6
             AND lease_owner = $7
             AND lease_generation = $8
             AND lease_fencing_token = $9
             AND phase NOT IN ('closed', 'done', 'cancelled', 'handed-off')`,
    params: [
      attestation.sessionKey,
      attestation.machine,
      attestation.projectName,
      attestation.pid,
      attestation.startedAt,
      attestation.executable,
      attestation.leaseOwner,
      attestation.leaseGeneration,
      attestation.leaseFencingToken,
    ],
  };
}

/**
 * Build the SQL that releases a lease by compare-and-swap.
 *
 * Archival and lease release are separate. This only runs when the session
 * actually holds a lease, and it only succeeds when the stored owner,
 * generation and fencing token still equal the attested ones. A successful
 * release bumps the generation so a stale holder cannot re-use the old token.
 */
function buildLeaseReleaseQuery(attestation) {
  if (!attestation.leaseOwner) return null;
  return {
    sql: `UPDATE sessions
             SET lease_owner = '',
                 lease_generation = lease_generation + 1,
                 lease_fencing_token = '',
                 updated_at = now()
           WHERE session_key = $1
             AND machine = $2
             AND lease_owner = $3
             AND lease_generation = $4
             AND lease_fencing_token = $5`,
    params: [
      attestation.sessionKey,
      attestation.machine,
      attestation.leaseOwner,
      attestation.leaseGeneration,
      attestation.leaseFencingToken,
    ],
  };
}

/**
 * Build one atomic reconciliation statement for a single attested session.
 *
 * ARCHIVE, LEASE RELEASE AND CONSUMPTION MUST NOT BE SEPARATE WRITES
 * ------------------------------------------------------------------
 * Running them as three statements leaves recoverable-but-wrong states:
 *
 *   - crash after archive, before release -> session archived, lease still
 *     held by a dead process, and the attestation is never consumed;
 *   - archive loses the compare-and-swap -> the attestation stays unconsumed,
 *     so the next cycle re-plans the same session forever;
 *   - two schedulers interleave -> one archives, the other releases, and both
 *     write a consumption outcome that contradicts the other.
 *
 * A single statement with data-modifying CTEs makes the whole decision one
 * transaction. The attestation is always consumed, and the recorded outcome
 * says exactly what happened, including the "nothing was archived" case.
 *
 * @returns {{sql: string, params: Array}}
 */
function buildReconcileQuery(attestation) {
  const params = [
    attestation.sessionKey,
    attestation.machine,
    attestation.projectName,
    attestation.pid,
    attestation.startedAt,
    attestation.executable,
    attestation.leaseOwner,
    attestation.leaseGeneration,
    attestation.leaseFencingToken,
    attestation.nonce,
  ];

  // A session with no attested lease has nothing to release, so the release CTE
  // is replaced by an empty result rather than matching rows it should not.
  const releaseCte = attestation.leaseOwner
    ? `released AS (
         UPDATE sessions
            SET lease_owner = '',
                lease_generation = lease_generation + 1,
                lease_fencing_token = '',
                updated_at = now()
          WHERE session_key IN (SELECT session_key FROM archived)
            AND machine = $2
            AND lease_owner = $7
            AND lease_generation = $8
            AND lease_fencing_token = $9
          RETURNING session_key
       )`
    : `released AS (
         SELECT NULL::text AS session_key WHERE false
       )`;

  return {
    sql: `WITH archived AS (
             UPDATE sessions
                SET phase = 'closed', updated_at = now()
              WHERE session_key = $1
                AND machine = $2
                AND project_name = $3
                AND owner_pid = $4
                AND owner_started_at = $5
                AND owner_executable = $6
                AND lease_owner = $7
                AND lease_generation = $8
                AND lease_fencing_token = $9
                AND phase NOT IN ('closed', 'done', 'cancelled', 'handed-off')
              RETURNING session_key
           ),
           ${releaseCte},
           consumed AS (
             UPDATE reaper_attestations
                SET consumed_at = now(),
                    outcome = CASE
                      WHEN (SELECT count(*) FROM archived) = 0 THEN 'identity_changed'
                      WHEN (SELECT count(*) FROM released) = 0 AND $7 <> '' THEN 'archived_lease_unresolved'
                      WHEN (SELECT count(*) FROM released) = 0 THEN 'archived_no_lease'
                      ELSE 'archived_and_released'
                    END
              WHERE machine = $2 AND nonce = $10 AND consumed_at IS NULL
              RETURNING outcome
           )
           SELECT (SELECT count(*) FROM archived)::int AS archived,
                  (SELECT count(*) FROM released)::int AS released,
                  COALESCE((SELECT outcome FROM consumed), 'already_consumed') AS outcome`,
    params,
  };
}

module.exports = {
  ATTESTATION_TTL_MS,
  REQUIRED_FIELDS,
  buildArchiveQuery,
  buildLeaseReleaseQuery,
  buildReconcileQuery,
  parseAttestation,
  revalidateAttestation,
};
