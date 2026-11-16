import crypto from "node:crypto";

/**
 * Controlled policy exception validation.
 *
 * Exceptions require explicit policyId, repository, justification, scope, risk,
 * owner, distinct approver (separation of duties), and non-expired timestamp.
 * Exceptions can never bypass CI or security checks.
 */

const AGENT_IDENTITIES = new Set(["codex", "antigravity", "opencode", "agent", "assistant", "bot", "ai"]);

export function validateForceOverrideAuthorization({
  approvedBy = "",
  approvalTicket = "",
  overrideToken = "",
  actor = "",
  env = process.env,
} = {}) {
  const approver = String(approvedBy || "").trim();
  const ticket = String(approvalTicket || "").trim();
  const actorNorm = String(actor || "").trim().toLowerCase();

  if (approver.length < 3) {
    return {
      ok: false,
      code: "POLICY_OVERRIDE_UNAUTHORIZED",
      reason: "Privileged override requires 'approvedBy' naming a human/owner approver (>= 3 chars); a reason alone is not authorization.",
    };
  }

  if (AGENT_IDENTITIES.has(approver.toLowerCase()) || (actorNorm && approver.toLowerCase() === actorNorm)) {
    return {
      ok: false,
      code: "POLICY_OVERRIDE_UNAUTHORIZED",
      reason: `Agent or self-approval ("${approver}") is not permitted for governance policy overrides.`,
    };
  }

  if (ticket.length < 6) {
    return {
      ok: false,
      code: "POLICY_OVERRIDE_UNAUTHORIZED",
      reason: "Privileged override requires 'approvalTicket' (>= 6 chars, e.g. owner approval reference or incident ticket).",
    };
  }

  const expectedToken = String(env.DEVWF_GOVERNANCE_OVERRIDE_TOKEN || "").trim();
  if (!expectedToken) {
    return {
      ok: false,
      code: "POLICY_OVERRIDE_UNAUTHORIZED",
      reason: "Privileged governance override is disabled: DEVWF_GOVERNANCE_OVERRIDE_TOKEN is not configured on the MCP server.",
    };
  }

  const provided = String(overrideToken || "").trim();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expectedToken, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return {
      ok: false,
      code: "POLICY_OVERRIDE_UNAUTHORIZED",
      reason: "Invalid or missing 'overrideToken' for configured DEVWF_GOVERNANCE_OVERRIDE_TOKEN.",
    };
  }

  return { ok: true, approvedBy: approver, approvalTicket: ticket };
}

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
