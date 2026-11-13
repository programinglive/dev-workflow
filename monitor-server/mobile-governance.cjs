// @ts-check
'use strict';

const crypto = require('node:crypto');

const SUPPORTED_ACTIONS = new Set([
  'approve_gate',
  'reject_gate',
  'request_changes',
  'pause_task',
  'resume_task',
  'cancel_task',
  'emergency_stop',
  'waive_gate',
]);

const STEP_UP_ACTIONS = new Set([
  'emergency_stop',
  'cancel_task',
  'waive_gate',
]);

const ACTION_OUTCOMES = {
  approve_gate: 'APPROVED',
  reject_gate: 'REJECTED',
  request_changes: 'CHANGES_REQUESTED',
  pause_task: 'PAUSED',
  resume_task: 'RESUMED',
  cancel_task: 'CANCELLED',
  emergency_stop: 'STOP_DISPATCHED',
  waive_gate: 'WAIVED',
};

/**
 * Redacts inline tokens, bearer headers, and passwords from audit reasons and metadata.
 *
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\btok_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(password|secret|token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

/**
 * Computes a deterministic fingerprint of a governance request payload for idempotency checks.
 */
function fingerprintPayload({ sessionKey, action, contractRevision, evidenceDigest, policyDigest, reason }) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        sessionKey: String(sessionKey || ''),
        action: String(action || ''),
        contractRevision: String(contractRevision || ''),
        evidenceDigest: String(evidenceDigest || ''),
        policyDigest: String(policyDigest || ''),
        reason: String(reason || ''),
      })
    )
    .digest('hex');
}

/**
 * Creates a Mobile Governance, Emergency Stop, and Evidence Inspection Engine (Milestones M5 & M6).
 */
function createMobileGovernanceEngine({ maxAuditEntries = 500 } = {}) {
  const sessionStates = new Map();
  const idempotencyStore = new Map();
  const auditLog = [];
  let auditSeq = 0;

  function appendAudit({ eventType, actorId, deviceId, sessionKey, action, outcome, reason }) {
    auditSeq += 1;
    const entry = {
      id: `aud_${auditSeq}`,
      cursor: auditSeq,
      timestamp: new Date().toISOString(),
      eventType: String(eventType || 'governance_action'),
      actorId: String(actorId || 'unknown'),
      deviceId: String(deviceId || 'unknown'),
      sessionKey: String(sessionKey || ''),
      action: String(action || ''),
      outcome: String(outcome || ''),
      reason: redactSecrets(String(reason || '')),
    };
    auditLog.push(entry);
    if (auditLog.length > maxAuditEntries) {
      auditLog.shift();
    }
    return entry;
  }

  function registerSessionState(sessionKey, state = {}) {
    if (!sessionKey) return;
    const existing = sessionStates.get(sessionKey) || {};
    sessionStates.set(sessionKey, {
      ...existing,
      ...state,
      session_key: sessionKey,
      workerEpoch: typeof state.workerEpoch === 'number' ? state.workerEpoch : (existing.workerEpoch || 1),
      fencedBelowEpoch: existing.fencedBelowEpoch || 0,
      approvals: Array.isArray(state.approvals) ? state.approvals : (existing.approvals || []),
    });
  }

  function executeGovernanceAction({
    sessionKey,
    action,
    idempotencyKey,
    actor,
    device,
    contractRevision,
    evidenceDigest,
    policyDigest,
    stepUpConfirmed = false,
    reason = '',
  } = {}) {
    const cleanAction = String(action || '').trim();
    const cleanKey = String(sessionKey || '').trim();
    const cleanIdem = String(idempotencyKey || '').trim();

    if (!cleanKey || !SUPPORTED_ACTIONS.has(cleanAction)) {
      return {
        status: 400,
        body: { ok: false, error: `Invalid sessionKey or unsupported governance action '${cleanAction}'.` },
      };
    }

    if (!cleanIdem) {
      return {
        status: 400,
        body: { ok: false, error: 'idempotencyKey is required for all governance actions.' },
      };
    }

    // 1. Validate Actor Identity (strict separation: reject service and agent principals)
    if (!actor || typeof actor !== 'object' || !actor.subjectId) {
      appendAudit({
        eventType: 'authorization_denied',
        actorId: 'unauthenticated',
        deviceId: device?.deviceId,
        sessionKey: cleanKey,
        action: cleanAction,
        outcome: 'DENIED_UNAUTHENTICATED',
        reason: 'Missing authenticated human identity.',
      });
      return {
        status: 401,
        body: { ok: false, error: 'Authenticated human developer identity is required.' },
      };
    }

    if (actor.subjectType === 'service') {
      appendAudit({
        eventType: 'authorization_denied',
        actorId: actor.subjectId,
        deviceId: device?.deviceId,
        sessionKey: cleanKey,
        action: cleanAction,
        outcome: 'DENIED_SERVICE_PRINCIPAL',
        reason: 'Service identity attempted human governance action.',
      });
      return {
        status: 403,
        body: { ok: false, error: 'Forbidden: a service credential cannot satisfy human approval requirements.' },
      };
    }

    if (actor.subjectType === 'agent') {
      appendAudit({
        eventType: 'authorization_denied',
        actorId: actor.subjectId,
        deviceId: device?.deviceId,
        sessionKey: cleanKey,
        action: cleanAction,
        outcome: 'DENIED_AGENT_PRINCIPAL',
        reason: 'Coding agent attempted self-approval.',
      });
      return {
        status: 403,
        body: { ok: false, error: 'Forbidden: coding agent identities cannot authorize human governance actions.' },
      };
    }

    if (actor.subjectType !== 'human') {
      return {
        status: 403,
        body: { ok: false, error: 'Forbidden: verified human developer identity is required.' },
      };
    }

    // 2. Validate Device Identity & Scopes (monitor:read must remain strictly read-only)
    if (!device || typeof device !== 'object' || !device.deviceId || device.revoked) {
      appendAudit({
        eventType: 'authorization_denied',
        actorId: actor.subjectId,
        deviceId: device?.deviceId || 'unknown',
        sessionKey: cleanKey,
        action: cleanAction,
        outcome: 'DENIED_DEVICE_REVOKED_OR_INVALID',
        reason: 'Invalid or revoked companion device.',
      });
      return {
        status: 403,
        body: { ok: false, error: 'Forbidden: valid non-revoked companion device is required.' },
      };
    }

    const scopes = Array.isArray(device.scopes) ? device.scopes : [];
    if (!scopes.includes('governance:approve')) {
      appendAudit({
        eventType: 'authorization_denied',
        actorId: actor.subjectId,
        deviceId: device.deviceId,
        sessionKey: cleanKey,
        action: cleanAction,
        outcome: 'DENIED_INSUFFICIENT_SCOPE',
        reason: 'Device holds monitor:read only; missing governance:approve scope.',
      });
      return {
        status: 403,
        body: {
          ok: false,
          error: "Forbidden: device credential has read-only scope ('monitor:read'). 'governance:approve' scope is required.",
        },
      };
    }

    // 3. Check Idempotency & Replay Protection
    const fp = fingerprintPayload({
      sessionKey: cleanKey,
      action: cleanAction,
      contractRevision,
      evidenceDigest,
      policyDigest,
      reason,
    });

    if (idempotencyStore.has(cleanIdem)) {
      const prev = idempotencyStore.get(cleanIdem);
      if (prev.fingerprint !== fp) {
        appendAudit({
          eventType: 'replay_rejected',
          actorId: actor.subjectId,
          deviceId: device.deviceId,
          sessionKey: cleanKey,
          action: cleanAction,
          outcome: 'REJECTED_REPLAY_MISMATCH',
          reason: 'Idempotency key reused with mutated parameters.',
        });
        return {
          status: 409,
          body: {
            ok: false,
            code: 'IDEMPOTENCY_KEY_REUSE_MISMATCH',
            error: 'Idempotency key has already been used with different parameters.',
          },
        };
      }
      return {
        status: prev.status,
        body: {
          ...prev.body,
          idempotentReplay: true,
        },
      };
    }

    // 4. Step-Up Confirmation for High-Risk Actions
    if (STEP_UP_ACTIONS.has(cleanAction) && stepUpConfirmed !== true) {
      return {
        status: 400,
        body: {
          ok: false,
          error: `Action '${cleanAction}' requires explicit two-step confirmation (stepUpConfirmed: true).`,
        },
      };
    }

    // 5. Validate Session Revision & Digests
    const session = sessionStates.get(cleanKey) || { session_key: cleanKey, workerEpoch: 1, approvals: [] };
    if (
      (session.contractRevision && contractRevision && session.contractRevision !== contractRevision) ||
      (session.evidenceDigest && evidenceDigest && session.evidenceDigest !== evidenceDigest) ||
      (session.policyDigest && policyDigest && session.policyDigest !== policyDigest)
    ) {
      appendAudit({
        eventType: 'stale_revision_rejected',
        actorId: actor.subjectId,
        deviceId: device.deviceId,
        sessionKey: cleanKey,
        action: cleanAction,
        outcome: 'REJECTED_STALE_DIGEST',
        reason: 'Task contract revision or evidence digest has changed since inspection.',
      });
      return {
        status: 409,
        body: {
          ok: false,
          code: 'STALE_REVISION_OR_EVIDENCE',
          error: 'Task Contract revision, Evidence digest, or Policy digest is stale. Refresh evidence before approving.',
        },
      };
    }

    // 6. Handle Emergency Stop via Supervisor State Machine
    if (cleanAction === 'emergency_stop') {
      const nextEpoch = (session.workerEpoch || 1) + 1;
      session.workerEpoch = nextEpoch;
      session.fencedBelowEpoch = nextEpoch;
      session.stopState = 'STOP_DISPATCHED';
      session.stopHistory = ['STOP_REQUESTED', 'STOP_DISPATCHED'];
      sessionStates.set(cleanKey, session);

      const auditEntry = appendAudit({
        eventType: 'emergency_stop',
        actorId: actor.subjectId,
        deviceId: device.deviceId,
        sessionKey: cleanKey,
        action: cleanAction,
        outcome: 'STOP_DISPATCHED',
        reason,
      });

      const response = {
        status: 202,
        body: {
          ok: true,
          sessionKey: cleanKey,
          action: cleanAction,
          stopState: 'STOP_DISPATCHED',
          history: [...session.stopHistory],
          fencedEpoch: nextEpoch,
          auditId: auditEntry.id,
        },
      };
      idempotencyStore.set(cleanIdem, { fingerprint: fp, ...response });
      return response;
    }

    // 7. Standard Governance Actions
    const outcome = ACTION_OUTCOMES[cleanAction] || 'RECORDED';
    const auditEntry = appendAudit({
      eventType: 'governance_decision',
      actorId: actor.subjectId,
      deviceId: device.deviceId,
      sessionKey: cleanKey,
      action: cleanAction,
      outcome,
      reason,
    });

    session.approvals = Array.isArray(session.approvals) ? session.approvals : [];
    session.approvals.push({
      auditId: auditEntry.id,
      actorId: actor.subjectId,
      deviceId: device.deviceId,
      action: cleanAction,
      outcome,
      reason: redactSecrets(reason),
      timestamp: auditEntry.timestamp,
    });
    sessionStates.set(cleanKey, session);

    const response = {
      status: 200,
      body: {
        ok: true,
        sessionKey: cleanKey,
        action: cleanAction,
        outcome,
        auditId: auditEntry.id,
      },
    };
    idempotencyStore.set(cleanIdem, { fingerprint: fp, ...response });
    return response;
  }

  /**
   * Confirms emergency stop outcome from the execution supervisor.
   */
  function confirmEmergencyStop(sessionKey, { supervisorId = 'supervisor', outcome = 'STOP_CONFIRMED' } = {}) {
    const validOutcomes = new Set(['STOP_CONFIRMED', 'STOP_FAILED', 'STOP_UNCONFIRMED']);
    const finalState = validOutcomes.has(outcome) ? outcome : 'STOP_UNCONFIRMED';
    const session = sessionStates.get(sessionKey);
    if (!session) {
      return { ok: false, error: 'Session not found.' };
    }
    session.stopState = finalState;
    session.stopHistory = Array.isArray(session.stopHistory)
      ? [...session.stopHistory, finalState]
      : ['STOP_REQUESTED', 'STOP_DISPATCHED', finalState];
    sessionStates.set(sessionKey, session);

    appendAudit({
      eventType: 'supervisor_stop_confirmation',
      actorId: supervisorId,
      deviceId: 'supervisor',
      sessionKey,
      action: 'emergency_stop',
      outcome: finalState,
      reason: `Supervisor reported ${finalState}`,
    });

    return {
      ok: true,
      sessionKey,
      stopState: finalState,
      history: [...session.stopHistory],
    };
  }

  /**
   * Checks whether a worker epoch has been fenced by an Emergency Stop or Cancel operation.
   */
  function isWorkerFenced(sessionKey, workerEpoch = 1) {
    const session = sessionStates.get(sessionKey);
    if (!session || !session.fencedBelowEpoch) return false;
    return workerEpoch < session.fencedBelowEpoch;
  }

  /**
   * Milestone M6: Inspects structured evidence and evaluates revision binding integrity.
   * Never treats AI boolean claims as VERIFIED without verifiable execution digest & revision match.
   */
  function inspectSessionEvidence(sessionKey) {
    const s = sessionStates.get(sessionKey);
    if (!s) {
      return {
        sessionKey,
        evidenceStatus: 'UNAVAILABLE',
        taskContract: null,
        acceptanceCriteria: [],
        changedFiles: [],
        sourceRevision: null,
        testResults: null,
        buildVerification: null,
        scopeCompliance: { compliant: true, outOfScopeFiles: [] },
        policyDecisions: [],
        documentationStatus: { satisfied: false },
        approvalHistory: [],
      };
    }

    const ev = s.evidence;
    let evidenceStatus = 'UNAVAILABLE';

    if (!ev || typeof ev !== 'object' || !ev.executionId || !ev.stdoutDigest || !ev.sourceRevision) {
      // Never represent AI boolean assertions (e.g. s.testsPassed = true) as VERIFIED without digest + revision
      if (s.phase === 'coding' || s.phase === 'testing') {
        evidenceStatus = 'PENDING';
      } else {
        evidenceStatus = 'UNAVAILABLE';
      }
    } else if (s.currentRevision && ev.sourceRevision !== s.currentRevision) {
      evidenceStatus = 'STALE';
    } else if (ev.exitCode !== 0 || (typeof ev.failed === 'number' && ev.failed > 0)) {
      evidenceStatus = 'FAILED';
    } else {
      evidenceStatus = 'VERIFIED';
    }

    return {
      sessionKey,
      evidenceStatus,
      currentRevision: s.currentRevision || null,
      sourceRevision: ev?.sourceRevision || null,
      taskContract: {
        taskId: s.taskId || sessionKey,
        intent: s.task || '',
        contractRevision: s.contractRevision || 'rev_1',
        policyDigest: s.policyDigest || 'default_policy',
        allowedPaths: s.allowedPaths || ['**'],
        forbiddenPaths: s.forbiddenPaths || [],
      },
      acceptanceCriteria: Array.isArray(s.dod_json) ? s.dod_json : [],
      changedFiles: Array.isArray(s.changedFiles) ? s.changedFiles : [],
      testResults: ev
        ? {
            executionId: ev.executionId,
            command: ev.command,
            exitCode: ev.exitCode,
            passed: ev.passed || 0,
            failed: ev.failed || 0,
            skipped: ev.skipped || 0,
            sourceRevision: ev.sourceRevision,
            stdoutDigest: ev.stdoutDigest,
          }
        : null,
      buildVerification: s.active_build || null,
      scopeCompliance: s.scopeCompliance || { compliant: true, outOfScopeFiles: [] },
      policyDecisions: Array.isArray(s.policyDecisions) ? s.policyDecisions : [],
      documentationStatus: s.documentationStatus || { satisfied: Boolean(s.doc_ok) },
      approvalHistory: Array.isArray(s.approvals) ? s.approvals : [],
    };
  }

  /**
   * Returns paginated, secret-redacted audit timeline entries.
   */
  function getAuditTimeline({ limit = 25, cursor = null, sessionKey = null } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
    const filtered = sessionKey
      ? auditLog.filter((e) => e.sessionKey === sessionKey)
      : auditLog;

    const startIdx = cursor
      ? filtered.findIndex((e) => e.cursor > Number(cursor))
      : 0;

    if (startIdx === -1) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const slice = filtered.slice(startIdx, startIdx + safeLimit);
    const hasMore = startIdx + safeLimit < filtered.length;
    const nextCursor = hasMore && slice.length > 0 ? slice[slice.length - 1].cursor : null;

    return {
      items: slice,
      nextCursor,
      hasMore,
    };
  }

  return {
    registerSessionState,
    executeGovernanceAction,
    confirmEmergencyStop,
    isWorkerFenced,
    inspectSessionEvidence,
    getAuditTimeline,
  };
}

module.exports = {
  createMobileGovernanceEngine,
  redactSecrets,
};
