/**
 * Controlled policy exception validation.
 *
 * Exceptions require explicit policyId, repository, justification, scope, risk,
 * owner, distinct approver (separation of duties), and non-expired timestamp.
 * Exceptions can never bypass CI or security checks.
 */

export function validatePolicyException(exception, { policyId, repository, now = new Date() } = {}) {
  if (!exception || typeof exception !== "object") {
    return { ok: false, code: "POLICY_EXCEPTION_NOT_APPROVED", reason: "Policy exception record is missing." };
  }

  if (policyId && exception.policyId !== policyId) {
    return {
      ok: false,
      code: "POLICY_EXCEPTION_NOT_APPROVED",
      reason: `Exception policyId "${exception.policyId}" does not match "${policyId}".`,
    };
  }

  if (repository && exception.repository && exception.repository !== repository) {
    return {
      ok: false,
      code: "POLICY_EXCEPTION_NOT_APPROVED",
      reason: `Exception repository "${exception.repository}" does not match "${repository}".`,
    };
  }

  const requiredFields = ["justification", "scope", "risk", "owner", "approver"];
  for (const field of requiredFields) {
    if (typeof exception[field] !== "string" || exception[field].trim().length < 3) {
      return {
        ok: false,
        code: "POLICY_EXCEPTION_NOT_APPROVED",
        reason: `Policy exception is missing required field "${field}".`,
      };
    }
  }

  if (exception.owner.trim().toLowerCase() === exception.approver.trim().toLowerCase()) {
    return {
      ok: false,
      code: "POLICY_EXCEPTION_NOT_APPROVED",
      reason: "Separation of duties violation: exception owner cannot self-approve.",
    };
  }

  if (exception.expiresAt) {
    const exp = Date.parse(exception.expiresAt);
    if (!Number.isFinite(exp) || exp <= now.getTime()) {
      return {
        ok: false,
        code: "POLICY_EXCEPTION_NOT_APPROVED",
        reason: "Policy exception has expired or has an invalid expiration timestamp.",
      };
    }
  }

  if (exception.bypassCi === true || exception.bypassSecurity === true) {
    return {
      ok: false,
      code: "POLICY_EXCEPTION_NOT_APPROVED",
      reason: "Policy exceptions cannot bypass mandatory CI or security checks.",
    };
  }

  return { ok: true, exception };
}
