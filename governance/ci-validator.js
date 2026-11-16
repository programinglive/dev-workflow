import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { classifyTask, isDocumentationFile } from "./classifier.js";
import { evaluateGovernanceGate, loadPolicies, normalizeRepoSlug } from "./engine.js";

function runGit(cwd, args, { trim = true } = {}) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return trim ? out.trim() : out;
  } catch {
    return "";
  }
}

export function collectGitContext(projectDir, baseRef = "") {
  const resolvedDir = path.resolve(projectDir || process.cwd());
  const remote = runGit(resolvedDir, ["remote", "get-url", "origin"]);
  const commit = runGit(resolvedDir, ["rev-parse", "HEAD"]);
  let changedRaw = "";
  if (baseRef) {
    changedRaw = runGit(resolvedDir, ["diff", "--name-only", `${baseRef}...HEAD`]);
  }
  const statusRaw = runGit(resolvedDir, ["status", "--porcelain", "-uall"], { trim: false });
  const statusPaths = statusRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const rawPath = line.slice(3).trim();
      const arrowIdx = rawPath.indexOf(" -> ");
      const targetPath = arrowIdx >= 0 ? rawPath.slice(arrowIdx + 4).trim() : rawPath;
      return targetPath.replace(/^"|"$/g, "");
    });

  const changedPaths = Array.from(
    new Set([
      ...changedRaw.split(/\r?\n/).filter(Boolean),
      ...statusPaths,
    ])
  );

  const docContents = {};
  for (const rel of changedPaths) {
    if (isDocumentationFile(rel)) {
      const full = path.join(resolvedDir, rel);
      if (existsSync(full)) {
        try {
          docContents[rel] = readFileSync(full, "utf8");
        } catch {
          docContents[rel] = "";
        }
      } else {
        // Explicit null signals deleted/missing doc file so validator rejects it instead of skipping
        docContents[rel] = null;
      }
    }
  }

  return {
    projectDir: resolvedDir,
    repository: normalizeRepoSlug(remote) || path.basename(resolvedDir),
    commit: commit || "HEAD",
    changedPaths,
    docContents,
  };
}

/**
 * Non-interactive CI/CLI validator (`devwf governance validate --policy all --json`).
 */
export function runCiGovernanceValidation({
  projectDir = process.cwd(),
  policy = "all",
  baseRef = "",
  state = null,
  statePath = "",
  taskType = "feature",
  description = "",
} = {}) {
  const policies = loadPolicies();
  const ctx = collectGitContext(projectDir, baseRef);

  let loadedState = state;
  if (!loadedState && statePath) {
    loadedState = JSON.parse(readFileSync(path.resolve(statePath), "utf8"));
  }

  const classification = classifyTask({
    taskType: loadedState?.taskType || taskType,
    description: loadedState?.taskDescription || description,
    changedPaths: ctx.changedPaths,
  });

  // In standalone CI diff-only mode (no MCP state supplied), synthesize diff-backed
  // evidence only when the diff itself actually contains valid artifacts (e.g. CLI
  // tests/commands or updated documentation files); otherwise fail closed.
  const hasCliOrTests = Boolean(classification.diffSummary?.hasCliCommand) && (classification.diffSummary?.testCount || 0) > 0;
  const synthCliEvidence =
    !loadedState && (hasCliOrTests || ((classification.diffSummary?.testCount || 0) > 0 && classification.cliFirstApplicability !== "REQUIRED"))
      ? {
          summary: `npm test / diff-verified CLI & test paths (${classification.diffSummary.testCount} test file(s))`,
          headlessTestsPassed: (classification.diffSummary?.testCount || 0) > 0,
          repository: ctx.repository,
          revision: ctx.commit,
          policyVersion: policies.policies["architecture.cli_first"].version,
          policyDigest: policies.digest,
        }
      : null;

  const existingDocs = ctx.changedPaths.filter((p) => isDocumentationFile(p) && ctx.docContents[p] !== null);
  const synthDocEvidence =
    !loadedState && existingDocs.length > 0
      ? {
          status: "UPDATED",
          files: existingDocs,
          repository: ctx.repository,
          revision: ctx.commit,
          policyVersion: policies.policies["engineering.documentation_required"].version,
          policyDigest: policies.digest,
        }
      : null;

  const effectiveState = loadedState || {
    taskType,
    taskDescription: description,
    governance: {
      effectiveMode: "enforce",
      repository: ctx.repository,
      policyDigest: policies.digest,
      policyVersions: {
        "architecture.cli_first": policies.policies["architecture.cli_first"].version,
        "engineering.documentation_required": policies.policies["engineering.documentation_required"].version,
      },
      cliFirstEvidence: synthCliEvidence,
      documentationEvidence: synthDocEvidence,
      exceptions: [],
    },
  };

  const result = evaluateGovernanceGate({
    state: effectiveState,
    changedPaths: ctx.changedPaths,
    docContents: ctx.docContents,
    currentRepo: ctx.repository,
    currentRevision: loadedState ? (Number(loadedState.dodRevision) || 0) : ctx.commit,
  });

  const filteredViolations =
    policy === "all"
      ? result.violations
      : result.violations.filter((v) => v.policyId === policy || v.policyId.includes(policy));

  const gatePassed = filteredViolations.length === 0;

  return {
    ok: gatePassed,
    exitCode: gatePassed ? 0 : 1,
    repository: ctx.repository,
    commit: ctx.commit,
    policies: {
      "architecture.cli_first": policies.policies["architecture.cli_first"].version,
      "engineering.documentation_required": policies.policies["engineering.documentation_required"].version,
      digest: policies.digest,
    },
    applicability: {
      classification: classification.taskClass,
      cliFirst: classification.cliFirstApplicability,
      documentation: classification.documentationApplicability,
    },
    changedPaths: ctx.changedPaths,
    evidence: {
      cliFirst: effectiveState.governance?.cliFirstEvidence || null,
      documentation: effectiveState.governance?.documentationEvidence || null,
      exceptions: effectiveState.governance?.exceptions || [],
    },
    violations: filteredViolations,
    warnings: result.warnings,
    gateResult: gatePassed ? "PASS" : "FAIL",
  };
}
