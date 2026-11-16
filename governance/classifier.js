/**
 * Deterministic task classification and policy applicability evaluator.
 *
 * Classifies tasks using both declared intent (`taskType`, `description`) and
 * actual working-tree / commit diff paths (`changedPaths`). When a task starts
 * as PRESENTATION_ONLY or DOCUMENTATION_ONLY and later modifies business logic,
 * re-evaluation upgrades its applicability automatically.
 */

export const TASK_CLASSES = Object.freeze([
  "NEW_FEATURE",
  "BUG_FIX",
  "REFACTOR",
  "PRESENTATION_ONLY",
  "INTEGRATION",
  "INFRASTRUCTURE",
  "DOCUMENTATION_ONLY",
  "SECURITY_FIX",
  "MAINTENANCE",
]);

export const CLI_FIRST_APPLICABILITY = Object.freeze({
  REQUIRED: "REQUIRED",
  ASSESSMENT_REQUIRED: "ASSESSMENT_REQUIRED",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

export const DOC_APPLICABILITY = Object.freeze({
  REQUIRED: "REQUIRED",
  UPDATED: "UPDATED",
  CREATED: "CREATED",
  NOT_REQUIRED_WITH_REASON: "NOT_REQUIRED_WITH_REASON",
  BLOCKED: "BLOCKED",
});

const DOC_PATH_RE = /(^|\/)(README|CHANGELOG|CONTRIBUTING|AGENTS|CLAUDE|GEMINI|PRD)([^/]*)\.(md|mdx|txt)$|(^|\/)(docs?|documentation)\/.*\.(md|mdx|rst|adoc|txt)$/i;
const PRESENTATION_PATH_RE = /\.(css|scss|sass|less|svg|png|jpg|jpeg|webp|ico|woff2?|ttf)$/i;
const VIEW_PATH_RE = /(^|\/)(resources\/views|views|components|styles|public\/css)\//i;
const INFRA_PATH_RE = /(^|\/)(\.gitlab-ci\.yml|\.github\/workflows\/|Dockerfile|docker-compose|scripts\/ops\/|terraform\/|ansible\/|managed\/)/i;
const CLI_COMMAND_PATH_RE = /(^|\/)(app\/Console\/Commands\/|bin\/|cli\/|cmd\/)/i;
const API_PATH_RE = /(^|\/)(routes\/api|app\/Http\/Controllers\/Api|api\/)/i;
const MIGRATION_PATH_RE = /(^|\/)database\/migrations\//i;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__)\//i;

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function isDocumentationFile(filePath) {
  return DOC_PATH_RE.test(normalizePath(filePath));
}

export function isTestFile(filePath) {
  const norm = normalizePath(filePath);
  return TEST_PATH_RE.test(norm) || /\.(test|spec)\.[a-z0-9]+$/i.test(norm);
}

export function isPresentationOnlyFile(filePath) {
  const norm = normalizePath(filePath);
  if (isDocumentationFile(norm) || isTestFile(norm)) return false;
  return PRESENTATION_PATH_RE.test(norm) || (VIEW_PATH_RE.test(norm) && /\.(blade\.php|html|css|scss)$/i.test(norm));
}

export function inspectChangedPaths(changedPaths = []) {
  const normalized = changedPaths.map(normalizePath).filter(Boolean);
  const docs = normalized.filter(isDocumentationFile);
  const tests = normalized.filter(isTestFile);
  const nonDocNonTest = normalized.filter((p) => !isDocumentationFile(p) && !isTestFile(p));
  const presentationOnly = nonDocNonTest.length > 0 && nonDocNonTest.every(isPresentationOnlyFile);
  const hasCliCommand = nonDocNonTest.some((p) => CLI_COMMAND_PATH_RE.test(p));
  const hasApiChange = nonDocNonTest.some((p) => API_PATH_RE.test(p));
  const hasMigration = nonDocNonTest.some((p) => MIGRATION_PATH_RE.test(p));
  const hasInfra = nonDocNonTest.some((p) => INFRA_PATH_RE.test(p));
  const hasBusinessLogic = nonDocNonTest.some((p) => !isPresentationOnlyFile(p) && !INFRA_PATH_RE.test(p));

  return {
    all: normalized,
    docs,
    tests,
    nonDocNonTest,
    presentationOnly,
    hasCliCommand,
    hasApiChange,
    hasMigration,
    hasInfra,
    hasBusinessLogic,
  };
}

/**
 * Classify a task based on declared type, description, and actual changed paths.
 */
export function classifyTask({ taskType = "other", description = "", changedPaths = [] } = {}) {
  const type = String(taskType || "other").toLowerCase().trim();
  const desc = String(description || "").toLowerCase();
  const diff = inspectChangedPaths(changedPaths);

  let taskClass = "MAINTENANCE";

  if (diff.all.length > 0 && diff.nonDocNonTest.length === 0 && diff.docs.length > 0) {
    taskClass = "DOCUMENTATION_ONLY";
  } else if (diff.all.length > 0 && diff.presentationOnly) {
    taskClass = "PRESENTATION_ONLY";
  } else if (/\b(security|cve|xss|sqli|csrf|ssrf|injection|auth bypass)\b/i.test(desc)) {
    taskClass = "SECURITY_FIX";
  } else if (type === "feature" || /\b(new feature|implement|add .* command|add .* endpoint)\b/i.test(desc)) {
    taskClass = "NEW_FEATURE";
  } else if (type === "bugfix" || /\b(fix|bug|regression|error|broken|crash)\b/i.test(desc)) {
    taskClass = "BUG_FIX";
  } else if (type === "refactor" || /\b(refactor|extract|cleanup|restructure)\b/i.test(desc)) {
    taskClass = "REFACTOR";
  } else if (diff.hasInfra && !diff.hasBusinessLogic) {
    taskClass = "INFRASTRUCTURE";
  } else if (/\b(integrat|webhook|sync|mcp|api client)\b/i.test(desc)) {
    taskClass = "INTEGRATION";
  } else if (/\b(css|styling|color|layout|typo|docs only|documentation only)\b/i.test(desc) && diff.all.length === 0) {
    taskClass = /\b(docs? only|documentation)\b/i.test(desc) ? "DOCUMENTATION_ONLY" : "PRESENTATION_ONLY";
  }

  // Scope expansion guard: if initial intent was presentation/docs-only or maintenance
  // and actual diff touches business logic, upgrade to NEW_FEATURE or BUG_FIX.
  if ((taskClass === "PRESENTATION_ONLY" || taskClass === "DOCUMENTATION_ONLY" || taskClass === "MAINTENANCE") && diff.hasBusinessLogic) {
    taskClass = type === "bugfix" ? "BUG_FIX" : "NEW_FEATURE";
  }

  let cliFirstApplicability = CLI_FIRST_APPLICABILITY.ASSESSMENT_REQUIRED;
  if (taskClass === "PRESENTATION_ONLY" || taskClass === "DOCUMENTATION_ONLY") {
    cliFirstApplicability = CLI_FIRST_APPLICABILITY.NOT_APPLICABLE;
  } else if (
    taskClass === "NEW_FEATURE" ||
    taskClass === "INTEGRATION" ||
    diff.hasCliCommand
  ) {
    cliFirstApplicability = CLI_FIRST_APPLICABILITY.REQUIRED;
  }

  let documentationApplicability = DOC_APPLICABILITY.NOT_REQUIRED_WITH_REASON;
  if (
    taskClass === "NEW_FEATURE" ||
    taskClass === "DOCUMENTATION_ONLY" ||
    taskClass === "INFRASTRUCTURE" ||
    diff.hasCliCommand ||
    diff.hasApiChange ||
    diff.hasMigration
  ) {
    documentationApplicability = DOC_APPLICABILITY.REQUIRED;
  } else if (taskClass === "BUG_FIX" || taskClass === "REFACTOR" || taskClass === "SECURITY_FIX" || taskClass === "INTEGRATION") {
    documentationApplicability = DOC_APPLICABILITY.NOT_REQUIRED_WITH_REASON;
  }

  return {
    taskClass,
    cliFirstApplicability,
    documentationApplicability,
    diffSummary: {
      totalChanged: diff.all.length,
      docCount: diff.docs.length,
      testCount: diff.tests.length,
      hasBusinessLogic: diff.hasBusinessLogic,
      hasCliCommand: diff.hasCliCommand,
      hasApiChange: diff.hasApiChange,
      hasMigration: diff.hasMigration,
      hasInfra: diff.hasInfra,
    },
  };
}
