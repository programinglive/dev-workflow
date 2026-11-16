import { isDocumentationFile } from "./classifier.js";

/**
 * Governance evidence integrity, revision binding, and documentation quality validator.
 */

const FAKE_EVIDENCE_RE = /^(true|false|ok|done|yes|passed|verified|cli_first\s*=\s*(ok|true)|documentation_done\s*=\s*true|readme\s+updated|docs?\s+updated|n\/?a)$/i;

const CREDENTIAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|secret[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9/+=._-]{12,}["']?/i,
];

const PLACEHOLDER_ONLY_RE = /^(?:\s|#.*|\*.*|-\s*(?:TODO|TBD|FIXME|WIP|\.\.\.)\s*|<[^>]+>)*$/i;

const MEANINGFUL_CLI_EVIDENCE_RE = /(?:test|paratest|phpunit|pytest|node\s+--test|npm\s+test|cargo\s+test|artisan\s+|cli|headless|service|contract|pass(?:ed|ing)?|\d+\s+assertions?)/i;

const GENERIC_RATIONALE_RE = /^(not\s+needed|no\s+changes?|none|n\/?a|skip|skipped|internal\s+only|done)\.?$/i;

export function containsCredentials(text) {
  const content = String(text || "");
  return CREDENTIAL_PATTERNS.some((re) => re.test(content));
}

export function isPlaceholderOrEmptyDoc(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.length < 30) return true;
  if (PLACEHOLDER_ONLY_RE.test(trimmed)) return true;
  const nonTrivialLines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^#+\s*$/.test(l) && !/^(TODO|TBD|FIXME)[:\s]/i.test(l));
  return nonTrivialLines.length < 2;
}

export function validateBinding({ evidence, currentRepo, currentRevision, expectedPolicyVersion, expectedPolicyDigest, changedPaths = [] }) {
  if (!evidence || typeof evidence !== "object") {
    return { ok: false, code: "EVIDENCE_MISSING", reason: "Evidence object is missing." };
  }

  if (currentRepo && evidence.repository && evidence.repository !== currentRepo) {
    return {
      ok: false,
      code: "WRONG_REPOSITORY_EVIDENCE",
      reason: `Evidence repository "${evidence.repository}" does not match active repository "${currentRepo}".`,
    };
  }

  if (expectedPolicyVersion && evidence.policyVersion && evidence.policyVersion !== expectedPolicyVersion) {
    return {
      ok: false,
      code: "POLICY_VERSION_MISMATCH",
      reason: `Evidence policy version "${evidence.policyVersion}" does not match active policy version "${expectedPolicyVersion}".`,
    };
  }

  if (expectedPolicyDigest && evidence.policyDigest && evidence.policyDigest !== expectedPolicyDigest) {
    return {
      ok: false,
      code: "POLICY_DIGEST_MISMATCH",
      reason: "Evidence policy digest does not match active central policy digest.",
    };
  }

  if (currentRevision !== undefined && currentRevision !== null && evidence.revision !== undefined && evidence.revision !== null) {
    if (String(evidence.revision) !== String(currentRevision)) {
      // Allow preserving evidence only if verifier explicitly proves no source/contract files changed
      const sourceChanged = changedPaths.some((p) => !isDocumentationFile(p));
      if (sourceChanged || evidence.commitSha !== currentRevision) {
        return {
          ok: false,
          code: "POLICY_EVIDENCE_STALE",
          reason: `Evidence revision "${evidence.revision}" is stale compared to current revision "${currentRevision}".`,
        };
      }
    }
  }

  if (evidence.commitSha && currentRevision && typeof currentRevision === "string" && typeof evidence.commitSha === "string") {
    if (evidence.commitSha.length >= 7 && currentRevision.length >= 7 && !currentRevision.startsWith(evidence.commitSha) && !evidence.commitSha.startsWith(currentRevision)) {
      return {
        ok: false,
        code: "WRONG_COMMIT_EVIDENCE",
        reason: `Evidence commit "${evidence.commitSha}" does not match current commit "${currentRevision}".`,
      };
    }
  }

  return { ok: true };
}

export function validateCliFirstEvidence({
  applicability,
  evidence,
  currentRepo,
  currentRevision,
  expectedPolicyVersion,
  expectedPolicyDigest,
  changedPaths = [],
}) {
  if (applicability === "NOT_APPLICABLE") {
    return { ok: true, status: "NOT_APPLICABLE" };
  }

  if (!evidence) {
    return {
      ok: false,
      code: "CLI_FIRST_ASSESSMENT_MISSING",
      reason: "CLI-First architecture assessment and headless/service evidence are required before completion.",
    };
  }

  const binding = validateBinding({
    evidence,
    currentRepo,
    currentRevision,
    expectedPolicyVersion,
    expectedPolicyDigest,
    changedPaths,
  });
  if (!binding.ok) {
    return {
      ok: false,
      code: binding.code === "POLICY_EVIDENCE_STALE" ? "POLICY_EVIDENCE_STALE" : "CLI_FIRST_EVIDENCE_INVALID",
      reason: binding.reason,
      detailCode: binding.code,
    };
  }

  const summary = String(evidence.summary || evidence.proof || "").trim();
  if (!summary || summary.length < 10 || FAKE_EVIDENCE_RE.test(summary)) {
    return {
      ok: false,
      code: "CLI_FIRST_EVIDENCE_INVALID",
      reason: "CLI-First evidence cannot be a bare declaration; provide headless/service test command output or contract verification.",
    };
  }

  // Reject existence-only claims ("Services folder exists", "Artisan command exists")
  if (/^(?:services?\s+(?:folder|dir|directory)\s+exists?|artisan\s+command\s+exists?)\.?$/i.test(summary)) {
    return {
      ok: false,
      code: "CLI_FIRST_EVIDENCE_INVALID",
      reason: "Directory or command existence alone is not CLI-First proof; verify shared domain behavior and headless test execution.",
    };
  }

  const hasVerifiedTests = Boolean(evidence.headlessTestsPassed) || MEANINGFUL_CLI_EVIDENCE_RE.test(summary);
  if (!hasVerifiedTests) {
    return {
      ok: false,
      code: "CLI_FIRST_EVIDENCE_INVALID",
      reason: "CLI-First evidence must reference verified headless/service tests or CLI execution results.",
    };
  }

  if (evidence.behavioralDivergenceDetected === true) {
    return {
      ok: false,
      code: "CLI_FIRST_EVIDENCE_INVALID",
      reason: "CLI/UI behavioral divergence detected; align adapters to shared domain logic before completion.",
    };
  }

  return { ok: true, status: "VERIFIED" };
}

export function validateDocumentationEvidence({
  applicability,
  evidence,
  changedPaths = [],
  docContents = {},
  diffSummary = {},
  currentRepo,
  currentRevision,
  expectedPolicyVersion,
  expectedPolicyDigest,
}) {
  if (!evidence) {
    if (applicability === "REQUIRED") {
      return {
        ok: false,
        code: "DOCUMENTATION_REQUIRED",
        reason: "Documentation-as-Code is required for this task, but no documentation evidence was recorded.",
      };
    }
    return {
      ok: false,
      code: "DOCUMENTATION_ASSESSMENT_MISSING",
      reason: "Documentation applicability assessment is required before completion.",
    };
  }

  const binding = validateBinding({
    evidence,
    currentRepo,
    currentRevision,
    expectedPolicyVersion,
    expectedPolicyDigest,
    changedPaths,
  });
  if (!binding.ok) {
    return {
      ok: false,
      code: binding.code === "POLICY_EVIDENCE_STALE" ? "POLICY_EVIDENCE_STALE" : "DOCUMENTATION_EVIDENCE_INVALID",
      reason: binding.reason,
      detailCode: binding.code,
    };
  }

  const status = String(evidence.status || "").toUpperCase();
  if (status === "NOT_REQUIRED_WITH_REASON") {
    if (applicability === "REQUIRED") {
      return {
        ok: false,
        code: "DOCUMENTATION_REQUIRED",
        reason: "Documentation is REQUIRED for new features, CLI commands, API changes, or migrations and cannot be waived without an approved exception.",
      };
    }
    const rationale = String(evidence.rationale || "").trim();
    if (rationale.length < 15 || GENERIC_RATIONALE_RE.test(rationale)) {
      return {
        ok: false,
        code: "DOCUMENTATION_EVIDENCE_INVALID",
        reason: "NOT_REQUIRED_WITH_REASON requires a specific, verifiable rationale (>= 15 chars) explaining why no documented contract changed.",
      };
    }
    return { ok: true, status: "NOT_REQUIRED_WITH_REASON" };
  }

  const files = Array.isArray(evidence.files) ? evidence.files.filter(Boolean) : [];
  if (files.length === 0) {
    return {
      ok: false,
      code: applicability === "REQUIRED" ? "DOCUMENTATION_REQUIRED" : "DOCUMENTATION_EVIDENCE_INVALID",
      reason: "Documentation evidence must declare at least one verified documentation file.",
    };
  }

  const nonDoc = files.filter((f) => !isDocumentationFile(f));
  if (nonDoc.length > 0) {
    return {
      ok: false,
      code: "DOCUMENTATION_EVIDENCE_INVALID",
      reason: `Declared files are not recognized documentation artifacts: ${nonDoc.join(", ")}.`,
    };
  }

  if (changedPaths.length > 0) {
    const changedSet = new Set(changedPaths.map((p) => String(p).replace(/\\/g, "/").toLowerCase()));
    const missingFromDiff = files.filter((f) => !changedSet.has(String(f).replace(/\\/g, "/").toLowerCase()));
    if (missingFromDiff.length > 0) {
      return {
        ok: false,
        code: "DOCUMENTATION_EVIDENCE_INVALID",
        reason: `Declared documentation files did not change in the repository diff: ${missingFromDiff.join(", ")}.`,
      };
    }
  }

  let combinedContent = "";
  for (const file of files) {
    if (Object.prototype.hasOwnProperty.call(docContents, file)) {
      const content = String(docContents[file] ?? "");
      if (containsCredentials(content)) {
        return {
          ok: false,
          code: "DOCUMENTATION_SECURITY_VIOLATION",
          reason: `Documentation file "${file}" appears to contain credentials or secret material.`,
        };
      }
      if (isPlaceholderOrEmptyDoc(content)) {
        return {
          ok: false,
          code: "DOCUMENTATION_EVIDENCE_INVALID",
          reason: `Documentation file "${file}" is empty or contains only placeholder text.`,
        };
      }
      combinedContent += `\n${content}`;
    }
  }

  // Contract checks when content is available
  if (combinedContent.length > 0) {
    if (diffSummary.hasCliCommand && !/(usage|options?|--[a-z0-9-]+|command|exit code|example)/i.test(combinedContent)) {
      return {
        ok: false,
        code: "DOCUMENTATION_EVIDENCE_INVALID",
        reason: "New/modified CLI command requires usage, arguments/options, or examples in documentation.",
      };
    }
    if (diffSummary.hasApiChange && !/(endpoint|GET|POST|PUT|PATCH|DELETE|request|response|schema|auth)/i.test(combinedContent)) {
      return {
        ok: false,
        code: "DOCUMENTATION_EVIDENCE_INVALID",
        reason: "API changes require endpoint, method, auth, or request/response schema documentation.",
      };
    }
  }

  return { ok: true, status: status === "CREATED" ? "CREATED" : "UPDATED" };
}
