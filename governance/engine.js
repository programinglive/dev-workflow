import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTask } from "./classifier.js";
import { validateCliFirstEvidence, validateDocumentationEvidence } from "./evidence-validator.js";
import { validatePolicyException } from "./exceptions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const POLICIES_PATH = path.join(here, "policies.json");

let cachedPolicyBundle = null;

export function loadPolicies() {
  if (cachedPolicyBundle) return cachedPolicyBundle;
  const raw = readFileSync(POLICIES_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const digest = crypto.createHash("sha256").update(JSON.stringify(parsed.policies)).digest("hex").slice(0, 16);
  cachedPolicyBundle = { ...parsed, digest };
  return cachedPolicyBundle;
}

export function normalizeRepoSlug(repo = "") {
  const s = String(repo || "").trim().toLowerCase();
  if (!s) return "";
  const sshMatch = s.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  return s.replace(/\.git$/, "");
}

export function resolveEffectiveMode({ repository = "", governanceMode = "", env = process.env } = {}) {
  const explicit = String(governanceMode || env.DEVWF_GOVERNANCE_MODE || "").trim().toLowerCase();
  if (["enforce", "warn", "audit"].includes(explicit)) {
    return explicit;
  }
  const bundle = loadPolicies();
  const isTestRuntime = Boolean(env.NODE_TEST_CONTEXT) || env.NODE_ENV === "test";
  if (isTestRuntime) {
    return bundle.rollout?.defaultMode || "warn";
  }
  const slug = normalizeRepoSlug(repository);
  const pilots = (bundle.rollout?.pilotRepositories || []).map((r) => normalizeRepoSlug(r));
  if (slug && pilots.includes(slug)) {
    return "enforce";
  }
  return bundle.rollout?.defaultMode || "warn";
}

export function resolveInitialGovernance({
  repository = "",
  taskType = "other",
  description = "",
  changedPaths = [],
  governanceMode = "",
  env = process.env,
} = {}) {
  const bundle = loadPolicies();
  const classification = classifyTask({ taskType, description, changedPaths });
  const mode = resolveEffectiveMode({ repository, governanceMode, env });

  return {
    schemaVersion: bundle.schemaVersion,
    rolloutStage: bundle.rollout?.stage || "PILOT_BLOCKING",
    effectiveMode: mode,
    policyDigest: bundle.digest,
    policyVersions: {
      "architecture.cli_first": bundle.policies["architecture.cli_first"].version,
      "engineering.documentation_required": bundle.policies["engineering.documentation_required"].version,
    },
    repository: normalizeRepoSlug(repository),
    taskClass: classification.taskClass,
    cliFirstApplicability: classification.cliFirstApplicability,
    documentationApplicability: classification.documentationApplicability,
    cliFirstEvidence: null,
    documentationEvidence: null,
    exceptions: [],
    legacyExempt: false,
  };
}

export function evaluateGovernanceGate({
  state,
  changedPaths = [],
  docContents = {},
  currentRepo = "",
  currentRevision = null,
  ciStatus = null,
  env = process.env,
} = {}) {
  const bundle = loadPolicies();
  const gov = state?.governance;

  // Legacy tasks started before central governance existed remain compatible
  if (!gov || gov.legacyExempt === true) {
    return {
      ok: true,
      mode: "legacy",
      violations: [],
      warnings: ["Task started without central governance metadata; legacy compatibility applied."],
    };
  }

  const repo = normalizeRepoSlug(currentRepo || gov.repository || state?.repository?.remote || "");
  const mode = resolveEffectiveMode({ repository: repo, governanceMode: gov.effectiveMode, env });

  // Re-evaluate classification against actual diff so scope expansion is caught
  const classification = classifyTask({
    taskType: state?.taskType || "other",
    description: state?.taskDescription || "",
    changedPaths,
  });

  const violations = [];
  const warnings = [];
  const exceptions = Array.isArray(gov.exceptions) ? gov.exceptions : [];

  if (ciStatus === "failed") {
    violations.push({
      policyId: "ci.required",
      code: "REQUIRED_CI_FAILED",
      reason: "Required CI verification failed; task cannot be completed.",
    });
  }

  // 1. CLI-First Policy Evaluation
  const cliPolicyId = "architecture.cli_first";
  const cliExpectedVer = bundle.policies[cliPolicyId].version;
  const cliException = exceptions.find((e) => e && e.policyId === cliPolicyId);
  if (cliException) {
    const exRes = validatePolicyException(cliException, { policyId: cliPolicyId, repository: repo });
    if (!exRes.ok) {
      violations.push({ policyId: cliPolicyId, code: exRes.code, reason: exRes.reason });
    }
  } else {
    const cliRes = validateCliFirstEvidence({
      applicability: classification.cliFirstApplicability,
      evidence: gov.cliFirstEvidence,
      currentRepo: repo,
      currentRevision,
      expectedPolicyVersion: cliExpectedVer,
      expectedPolicyDigest: bundle.digest,
      changedPaths,
    });
    if (!cliRes.ok) {
      violations.push({ policyId: cliPolicyId, code: cliRes.code, reason: cliRes.reason });
    }
  }

  // 2. Documentation-as-Code Policy Evaluation
  const docPolicyId = "engineering.documentation_required";
  const docExpectedVer = bundle.policies[docPolicyId].version;
  const docException = exceptions.find((e) => e && e.policyId === docPolicyId);
  if (docException) {
    const exRes = validatePolicyException(docException, { policyId: docPolicyId, repository: repo });
    if (!exRes.ok) {
      violations.push({ policyId: docPolicyId, code: exRes.code, reason: exRes.reason });
    }
  } else {
    const docRes = validateDocumentationEvidence({
      applicability: classification.documentationApplicability,
      evidence: gov.documentationEvidence,
      changedPaths,
      docContents,
      diffSummary: classification.diffSummary,
      currentRepo: repo,
      currentRevision,
      expectedPolicyVersion: docExpectedVer,
      expectedPolicyDigest: bundle.digest,
    });
    if (!docRes.ok) {
      violations.push({ policyId: docPolicyId, code: docRes.code, reason: docRes.reason });
    }
  }

  if (mode === "audit" || mode === "warn") {
    for (const v of violations) {
      warnings.push(`[${mode.toUpperCase()}] ${v.code}: ${v.reason}`);
    }
    return {
      ok: true,
      mode,
      classification,
      violations: mode === "audit" ? [] : violations,
      warnings,
    };
  }

  return {
    ok: violations.length === 0,
    mode,
    classification,
    violations,
    warnings,
  };
}
