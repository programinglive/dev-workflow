import crypto from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTask } from "./classifier.js";
import { validateCliFirstEvidence, validateDocumentationEvidence } from "./evidence-validator.js";
import { validatePolicyException } from "./exceptions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const POLICIES_PATH = path.join(here, "policies.json");

let cachedPolicyBundle = null;
let cachedPolicyStamp = "";

export function loadPolicies() {
  let stamp = cachedPolicyStamp;
  try {
    const st = statSync(POLICIES_PATH);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    if (cachedPolicyBundle) return cachedPolicyBundle;
  }
  if (cachedPolicyBundle && cachedPolicyStamp === stamp) return cachedPolicyBundle;
  const raw = readFileSync(POLICIES_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const digest = crypto.createHash("sha256").update(JSON.stringify(parsed.policies)).digest("hex").slice(0, 16);
  cachedPolicyBundle = { ...parsed, digest };
  cachedPolicyStamp = stamp;
  return cachedPolicyBundle;
}

export function normalizeRepoSlug(repo = "") {
  const s = String(repo || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!s) return "";
  // Keep local filesystem paths normalized as path-basename or posix-normalized slug,
  // while extracting org/repo from SSH/HTTPS git remotes.
  if (/^[a-z]:\//.test(s) || s.startsWith("/")) {
    return path.posix.basename(s);
  }
  const sshMatch = s.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  return s.replace(/\.git$/, "");
}

const MODE_RANK = Object.freeze({ audit: 0, warn: 1, enforce: 2 });

export function resolveEffectiveMode({ repository = "", governanceMode = "", env = process.env } = {}) {
  const bundle = loadPolicies();
  const isTestRuntime = Boolean(env.NODE_TEST_CONTEXT) || env.NODE_ENV === "test";
  const slug = normalizeRepoSlug(repository);
  const pilots = (bundle.rollout?.pilotRepositories || []).map((r) => normalizeRepoSlug(r));
  let baseMode = bundle.rollout?.defaultMode || "warn";
  if (!isTestRuntime && slug && pilots.includes(slug)) {
    baseMode = "enforce";
  }

  const explicit = String(env.DEVWF_GOVERNANCE_MODE || governanceMode || "").trim().toLowerCase();
  if (["enforce", "warn", "audit"].includes(explicit)) {
    // Allow raising strictness (e.g. warn -> enforce), never downgrading below baseMode
    // unless explicitly requested via server env DEVWF_GOVERNANCE_MODE.
    if (env.DEVWF_GOVERNANCE_MODE && ["enforce", "warn", "audit"].includes(String(env.DEVWF_GOVERNANCE_MODE).trim().toLowerCase())) {
      return String(env.DEVWF_GOVERNANCE_MODE).trim().toLowerCase();
    }
    if (MODE_RANK[explicit] >= MODE_RANK[baseMode]) {
      return explicit;
    }
  }
  return baseMode;
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

  // Legacy tasks started before central governance existed remain compatible,
  // unless explicitly flagged or started without governance after rollout.
  if (gov?.legacyExempt === true) {
    return {
      ok: true,
      mode: "legacy",
      violations: [],
      warnings: ["Task explicitly marked legacyExempt; legacy compatibility applied."],
    };
  }
  if (!gov) {
    const effectiveAt = Date.parse(bundle.rollout?.effectiveAt || "");
    const startedAt = Date.parse(state?.taskStartedAt || "");
    const isPreRollout = !Number.isFinite(startedAt) || (Number.isFinite(effectiveAt) && startedAt < effectiveAt);
    if (isPreRollout) {
      return {
        ok: true,
        mode: "legacy",
        violations: [],
        warnings: ["Task started without central governance metadata; legacy compatibility applied."],
      };
    }
    const repo = normalizeRepoSlug(currentRepo || state?.identityContract?.remote || state?.repository?.remote || state?.projectDir || "");
    const mode = resolveEffectiveMode({ repository: repo, env });
    const missingViolation = {
      policyId: "governance.metadata",
      code: "GOVERNANCE_METADATA_MISSING",
      reason: "Post-rollout task is missing governance metadata; re-resolve governance before completion.",
    };
    if (mode === "enforce") {
      return { ok: false, mode, violations: [missingViolation], warnings: [] };
    }
    return {
      ok: true,
      mode,
      violations: mode === "audit" ? [] : [missingViolation],
      warnings: [`[${mode.toUpperCase()}] ${missingViolation.code}: ${missingViolation.reason}`],
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
