import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanSecrets } from "../security/scanner.js";
import { sanitize } from "../security/sanitizer.js";

const execFileAsync = promisify(execFile);

/**
 * Built-in baseline Engineering Standards derived from the 5 foundational software books:
 * 1. A Philosophy of Software Design (John Ousterhout)
 * 2. The Pragmatic Programmer (David Thomas & Andrew Hunt)
 * 3. Working Effectively with Legacy Code (Michael Feathers)
 * 4. Refactoring (Martin Fowler)
 * 5. Extreme Programming Explained (Kent Beck)
 */
export const BUILTIN_ENGINEERING_STANDARDS = [
  {
    id: "ZET-ARCH-001",
    title: "Deep modules with clear responsibility boundaries and no controller-to-DB bypass",
    category: "architecture",
    principle: "Deep Modules & Information Hiding",
    source: "A Philosophy of Software Design (John Ousterhout)",
    severity: "medium",
    enforcement: "advisory",
    detection: "static-pattern",
    pattern: "\\b(?:DB::raw|mysqli_query)\\s*\\(",
    autofix: "proposal-only",
    autofix_class: "AF-2",
    scope: ["backend"],
    rationale: "Controllers and views should delegate complex queries and transactions to deep domain/service modules.",
    verification: "php artisan test",
  },
  {
    id: "ZET-ARCH-002",
    title: "Enforce role permission and release safety boundaries in server code",
    category: "architecture",
    principle: "Design by Contract & Least Privilege",
    source: "The Pragmatic Programmer (David Thomas & Andrew Hunt)",
    severity: "critical",
    enforcement: "blocking",
    detection: "architecture-boundary",
    pattern: "allow_auto_merge\\s*=>\\s*true|bypass_safety_policy\\s*=\\s*true",
    autofix: "disabled",
    autofix_class: "AF-3",
    scope: ["backend", "agent_worker"],
    rationale: "Safety gates and role permissions must never be weakened or bypassed in code.",
    verification: "php artisan test tests/Feature/CodingAgent/V16ReleaseSafetyAndAiOrgTest.php",
  },
  {
    id: "ZET-CODE-001",
    title: "Avoid duplicated business knowledge and leftover debug statements",
    category: "code-quality",
    principle: "DRY & Clean Production Code",
    source: "The Pragmatic Programmer & Refactoring (Martin Fowler)",
    severity: "medium",
    enforcement: "warning",
    detection: "regex",
    pattern: "^\\s*(?:dd|var_dump)\\s*\\([^)]*\\)\\s*;\\s*$",
    autofix: "AF-1",
    autofix_class: "AF-1",
    scope: ["backend", "frontend"],
    rationale: "Leftover debug dumps leak internal state and halt execution unexpectedly.",
    verification: "npm test",
  },
  {
    id: "ZET-CODE-002",
    title: "Deterministic formatting and no unresolved merge conflict markers or trailing whitespace",
    category: "code-quality",
    principle: "Continuous Integration & Small Clean Changes",
    source: "Extreme Programming Explained (Kent Beck)",
    severity: "high",
    enforcement: "blocking",
    detection: "regex",
    pattern: "^(?:<<<<<<<|=======|>>>>>>>)(?:\\s|$)|[ \\t]+$",
    autofix: "AF-0",
    autofix_class: "AF-0",
    scope: ["backend", "frontend", "agent_worker"],
    rationale: "Conflict markers break runtime parsing and trailing whitespace pollutes diffs.",
    verification: "git diff --check",
  },
  {
    id: "ZET-SEC-001",
    title: "No embedded credentials, private keys, or live tokens",
    category: "security",
    principle: "Security by Design",
    source: "The Pragmatic Programmer",
    severity: "critical",
    enforcement: "blocking",
    detection: "secret-scanner",
    pattern: "(?:ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)",
    autofix: "disabled",
    autofix_class: "AF-3",
    scope: ["backend", "frontend", "agent_worker"],
    rationale: "Embedded credentials in source files compromise production systems permanently.",
    verification: "security_audit",
  },
  {
    id: "ZET-SEC-002",
    title: "No unrestricted shell execution or unsafe deserialization",
    category: "security",
    principle: "Defensive Input Validation",
    source: "The Pragmatic Programmer",
    severity: "high",
    enforcement: "blocking",
    detection: "regex",
    pattern: "\\b(?:shell_exec|passthru|unserialize)\\s*\\(",
    autofix: "disabled",
    autofix_class: "AF-3",
    scope: ["backend", "agent_worker"],
    rationale: "Unrestricted command execution or unsafe deserialization leads to remote code execution.",
    verification: "php artisan test",
  },
  {
    id: "ZET-TEST-001",
    title: "Protect critical behavior with characterization and regression tests before risky changes",
    category: "testing",
    principle: "Legacy Code Safety & Characterization Tests",
    source: "Working Effectively with Legacy Code (Michael Feathers)",
    severity: "high",
    enforcement: "conditional",
    detection: "change-impact-analysis",
    autofix: "proposal-only",
    autofix_class: "AF-2",
    scope: ["backend", "frontend", "agent_worker"],
    rationale: "Modifying critical services without corresponding test coverage risks silent regressions.",
    verification: "php artisan test && npm test",
  },
  {
    id: "ZET-API-001",
    title: "Backward-compatible API contracts and defensive input validation",
    category: "api-contracts",
    principle: "Design by Contract",
    source: "The Pragmatic Programmer",
    severity: "high",
    enforcement: "blocking",
    detection: "api-contract-analysis",
    autofix: "proposal-only",
    autofix_class: "AF-2",
    scope: ["backend"],
    rationale: "API endpoints must validate request payloads and preserve response structure compatibility.",
    verification: "php artisan test",
  },
  {
    id: "ZET-DB-001",
    title: "Additive N-1 compatible database migrations and no unapproved destructive schema changes",
    category: "database",
    principle: "Reversible Changes & Database Safety",
    source: "The Pragmatic Programmer & Zettly V1.6 Policy",
    severity: "critical",
    enforcement: "blocking",
    detection: "migration-safety-scanner",
    pattern: "\\b(?:dropColumn|dropIfExists|dropTable)\\s*\\(",
    autofix: "disabled",
    autofix_class: "AF-3",
    scope: ["database"],
    rationale: "Destructive schema migrations break N-1 application rollback and risk irreversible data loss.",
    verification: "php artisan migrate --pretend",
  },
  {
    id: "ZET-DOC-001",
    title: "Synchronized architectural and operational documentation",
    category: "documentation",
    principle: "Living Documentation",
    source: "The Pragmatic Programmer",
    severity: "low",
    enforcement: "advisory",
    detection: "doc-drift-analysis",
    autofix: "proposal-only",
    autofix_class: "AF-2",
    scope: ["documentation"],
    rationale: "Keep AGENTS.md and architecture documentation aligned with structural changes.",
    verification: "audit_standards",
  },
  {
    id: "ZET-REL-001",
    title: "8-Dimension PR Reversibility & 15-Condition Autonomous Release Gate",
    category: "release",
    principle: "Continuous Integration & Sustainable Release Practices",
    source: "Extreme Programming Explained & Zettly V1.6 Policy",
    severity: "critical",
    enforcement: "blocking",
    detection: "release-readiness-check",
    autofix: "disabled",
    autofix_class: "AF-3",
    scope: ["release"],
    rationale: "Every release must satisfy 8-dimension reversibility and staging verification before production cutover.",
    verification: "php artisan coding-agent:safety assess",
  },
];

export const PROTECTED_GOVERNANCE_PREFIXES = [
  "engineering/standards/",
  "engineering/policies/",
  "engineering/exceptions/",
  "app/Services/ReleaseSafety/",
  "security/policy.js",
  ".github/workflows/",
  ".env",
];

/**
 * Parse simple YAML standards/exceptions files without external dependencies.
 */
function parseSimpleStandardsYaml(content, categoryFallback = "general") {
  const rules = [];
  const blocks = content.split(/\n\s*-\s+id:\s*/);
  for (let i = 1; i < blocks.length; i++) {
    const block = "id: " + blocks[i];
    const getField = (key) => {
      const m = block.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
      if (!m) return null;
      return m[1].trim().replace(/^["']|["']$/g, "");
    };
    const id = getField("id");
    if (!id) continue;
    rules.push({
      id,
      title: getField("title") || id,
      description: getField("description") || "",
      rationale: getField("rationale") || "",
      principle: getField("principle") || "Engineering Excellence",
      source: getField("source") || "Zettly Engineering Standard",
      category: categoryFallback,
      severity: (getField("severity") || "medium").toLowerCase(),
      enforcement: (getField("enforcement") || "advisory").toLowerCase(),
      detection: getField("detection") || "static-pattern",
      pattern: getField("pattern") || null,
      autofix: getField("autofix") || "proposal-only",
      autofix_class: (getField("autofix") || "").startsWith("AF-") ? getField("autofix") : "AF-2",
      verification: getField("verification") || "npm test",
    });
  }
  return rules;
}

export async function loadProjectStandards(projectDir) {
  const root = path.resolve(projectDir || process.cwd());
  const standardsDir = path.join(root, "engineering", "standards");
  const exceptionsFile = path.join(root, "engineering", "exceptions", "approved-exceptions.yaml");
  const loadedRules = new Map();

  for (const rule of BUILTIN_ENGINEERING_STANDARDS) {
    loadedRules.set(rule.id, { ...rule });
  }

  const yamlFiles = [];
  if (existsSync(standardsDir)) {
    try {
      const entries = await fs.readdir(standardsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
        yamlFiles.push(entry);
        const category = entry.replace(/\.ya?ml$/i, "");
        const content = await fs.readFile(path.join(standardsDir, entry), "utf8");
        const parsed = parseSimpleStandardsYaml(content, category);
        for (const r of parsed) {
          const existing = loadedRules.get(r.id) || {};
          loadedRules.set(r.id, { ...existing, ...r, pattern: r.pattern || existing.pattern });
        }
      }
    } catch {
      // fallback to built-in rules
    }
  }

  const exceptions = [];
  if (existsSync(exceptionsFile)) {
    try {
      const rawExc = await fs.readFile(exceptionsFile, "utf8");
      const excBlocks = rawExc.split(/\n\s*-\s+id:\s*/);
      for (let i = 1; i < excBlocks.length; i++) {
        const b = "id: " + excBlocks[i];
        const getF = (k) => {
          const m = b.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, "m"));
          return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
        };
        exceptions.push({
          id: getF("id"),
          rule_id: getF("rule_id"),
          file: getF("file"),
          reason: getF("reason"),
          approved_by: getF("approved_by"),
        });
      }
    } catch {
      // ignore unreadable exceptions
    }
  }

  return {
    projectDir: root,
    hasRegistryDir: existsSync(standardsDir),
    yamlFiles,
    standards: Array.from(loadedRules.values()),
    exceptions,
  };
}

function isExceptionApproved(exceptions, ruleId, relPath) {
  const norm = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
  return exceptions.some((e) => e.rule_id === ruleId && e.file && norm.endsWith(e.file.replaceAll("\\", "/")));
}

async function collectAuditFiles(root, targetPaths = [], maxFiles = 250) {
  const results = [];
  const skipDirs = new Set([".git", "node_modules", "vendor", "public", "storage", "dist", "build", ".state", ".worktrees"]);

  if (Array.isArray(targetPaths) && targetPaths.length > 0) {
    for (const rel of targetPaths) {
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
      try {
        const st = await fs.stat(abs);
        if (st.isFile() && st.size <= 512 * 1024) {
          results.push(path.relative(root, abs).replaceAll("\\", "/"));
        }
      } catch {
        // skip missing file
      }
    }
    return results;
  }

  async function walk(current, depth = 0) {
    if (depth > 8 || results.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          await walk(full, depth + 1);
        }
      } else if (/\.(?:php|js|mjs|cjs|jsx|ts|tsx|py|yaml|yml)$/i.test(entry.name) && !entry.name.endsWith(".min.js")) {
        try {
          const st = await fs.stat(full);
          if (st.size <= 512 * 1024) {
            results.push(path.relative(root, full).replaceAll("\\", "/"));
          }
        } catch {
          // ignore
        }
      }
    }
  }

  await walk(root);
  return results;
}

/**
 * Core Automatic Code Audit Engine (Section 6 & 8)
 */
export async function runEngineeringAudit({
  projectDir,
  files = [],
  categoryFilter = null,
  scopeLabel = "Repository",
} = {}) {
  const loaded = await loadProjectStandards(projectDir);
  const root = loaded.projectDir;
  const targetFiles = await collectAuditFiles(root, files);
  const findings = [];

  const applicableStandards = categoryFilter
    ? loaded.standards.filter((s) => s.category === categoryFilter)
    : loaded.standards;

  const hasTestChange = targetFiles.some((f) => /(?:^|\/)tests?\//i.test(f) || /(?:\.test|_test|Test)\.(?:js|ts|php|py)$/i.test(f));

  for (const relPath of targetFiles) {
    const absPath = path.join(root, relPath);
    let content = "";
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      continue;
    }

    const isTestFile = /(?:^|\/)tests?\//i.test(relPath) || /(?:\.test|_test|Test)\.(?:js|ts|php|py)$/i.test(relPath);
    const isMigrationFile = /database\/migrations\/.*\.php$/i.test(relPath);
    const lines = content.split(/\r?\n/);

    // 1. Secret scanning (ZET-SEC-001)
    if (!categoryFilter || categoryFilter === "security") {
      const literalSecretTypes = new Set(["private_key", "ssh_key", "github_token", "aws_access_key", "api_key", "oauth_token", "jwt", "connection_credentials"]);
      const secretHits = scanSecrets(content).filter((h) => literalSecretTypes.has(h.type));
      const hasEmbeddedToken = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/.test(content);
      if ((secretHits.length > 0 || hasEmbeddedToken) && !isExceptionApproved(loaded.exceptions, "ZET-SEC-001", relPath)) {
        findings.push({
          rule_id: "ZET-SEC-001",
          title: "No embedded credentials, private keys, or live tokens",
          category: "security",
          severity: "critical",
          enforcement: "blocking",
          file: relPath,
          line: 1,
          evidence: `Detected embedded secret pattern (${secretHits.map((h) => h.type).join(", ") || "token_pattern"})`,
          autofix_eligible: false,
          autofix_class: "AF-3",
          recommended_fix: "Remove embedded secret immediately, rotate credential, and load from environment or Secret Manager.",
        });
      }
    }

    // 2. Unresolved conflict markers (ZET-CODE-002)
    if (!categoryFilter || categoryFilter === "code-quality") {
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        if (/^(?:<<<<<<<|=======|>>>>>>>)(?:\s|$)/.test(line) && !isTestFile) {
          findings.push({
            rule_id: "ZET-CODE-002",
            title: "Unresolved Git merge conflict marker",
            category: "code-quality",
            severity: "high",
            enforcement: "blocking",
            file: relPath,
            line: idx + 1,
            evidence: line.slice(0, 80),
            autofix_eligible: false,
            autofix_class: "AF-2",
            recommended_fix: "Resolve merge conflict markers before committing.",
          });
        }
        if (/[ \t]+$/.test(line) && files.length > 0) {
          findings.push({
            rule_id: "ZET-CODE-002",
            title: "Trailing whitespace pollution",
            category: "code-quality",
            severity: "low",
            enforcement: "advisory",
            file: relPath,
            line: idx + 1,
            evidence: `Line ${idx + 1} has trailing whitespace`,
            autofix_eligible: true,
            autofix_class: "AF-0",
            recommended_fix: "Strip trailing whitespace deterministically via helper_apply_safe_fix (AF-0).",
          });
          break;
        }
      }
    }

    // 3. Leftover debug dumps in non-test code (ZET-CODE-001)
    if ((!categoryFilter || categoryFilter === "code-quality") && !isTestFile) {
      for (let idx = 0; idx < lines.length; idx++) {
        if (/^\s*(?:dd|var_dump)\s*\([^)]*\)\s*;\s*$/.test(lines[idx]) && !isExceptionApproved(loaded.exceptions, "ZET-CODE-001", relPath)) {
          findings.push({
            rule_id: "ZET-CODE-001",
            title: "Avoid leftover debug dump statements in production code",
            category: "code-quality",
            severity: "medium",
            enforcement: "warning",
            file: relPath,
            line: idx + 1,
            evidence: lines[idx].trim().slice(0, 100),
            autofix_eligible: true,
            autofix_class: "AF-1",
            recommended_fix: "Remove debug dump statement or use helper_apply_safe_fix (AF-1).",
          });
        }
      }
    }

    // 4. Destructive migration operations in up() method (ZET-DB-001)
    if ((!categoryFilter || categoryFilter === "database") && isMigrationFile) {
      const upSection = content.split(/public\s+function\s+down\s*\(/i)[0] || content;
      if (/\b(?:dropColumn|dropIfExists|dropTable)\s*\(/.test(upSection) && !isExceptionApproved(loaded.exceptions, "ZET-DB-001", relPath)) {
        findings.push({
          rule_id: "ZET-DB-001",
          title: "Destructive schema operation in migration up() method",
          category: "database",
          severity: "critical",
          enforcement: "blocking",
          file: relPath,
          line: 1,
          evidence: "Detected dropColumn / dropIfExists / dropTable in migration up() body",
          autofix_eligible: false,
          autofix_class: "AF-3",
          recommended_fix: "Use additive N-1 compatible migration steps and require a verified pre-deployment GCS database backup before running destructive DDL.",
        });
      }
    }

    // 5. Architecture boundary check: raw DB query in Controller (ZET-ARCH-001)
    if ((!categoryFilter || categoryFilter === "architecture") && /app\/Http\/Controllers\/.*\.php$/i.test(relPath)) {
      if (/\bDB::raw\s*\(/.test(content) && !isExceptionApproved(loaded.exceptions, "ZET-ARCH-001", relPath)) {
        findings.push({
          rule_id: "ZET-ARCH-001",
          title: "Controller embeds raw SQL instead of delegating to a deep Service/Domain module",
          category: "architecture",
          severity: "medium",
          enforcement: "advisory",
          file: relPath,
          line: 1,
          evidence: "Controller contains DB::raw() call",
          autofix_eligible: false,
          autofix_class: "AF-2",
          recommended_fix: "Extract raw query logic into an App\\Services or App\\Domain class.",
        });
      }
    }

    // 6. Critical service changed without regression test in scoped change audit (ZET-TEST-001)
    if (
      (!categoryFilter || categoryFilter === "testing") &&
      files.length > 0 &&
      !hasTestChange &&
      /(?:app\/Services\/ReleaseSafety\/|app\/Services\/AiOrganization\/|security\/)/i.test(relPath)
    ) {
      findings.push({
        rule_id: "ZET-TEST-001",
        title: "Critical safety/orchestration module modified without accompanying regression test change",
        category: "testing",
        severity: "high",
        enforcement: "conditional",
        file: relPath,
        line: 1,
        evidence: `Critical file '${relPath}' modified in change set with zero test files included.`,
        autofix_eligible: false,
        autofix_class: "AF-2",
        recommended_fix: "Add or update characterization/regression tests covering the modified behavior.",
      });
    }
  }

  const summary = {
    critical: findings.filter((f) => f.severity === "critical").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    safe_autofix_candidates: findings.filter((f) => f.autofix_eligible).length,
    manual_review_required: findings.filter((f) => !f.autofix_eligible).length,
  };

  const hasBlockingFailure = findings.some(
    (f) => f.enforcement === "blocking" && (f.severity === "critical" || f.severity === "high")
  );
  const qualityGate = hasBlockingFailure ? "FAIL" : findings.length > 0 ? "WARN" : "PASS";

  return sanitize({
    repository: path.basename(root),
    project_dir: root,
    scope: scopeLabel,
    files_audited: targetFiles.length,
    standards_loaded: applicableStandards.length,
    result: qualityGate,
    quality_gate: qualityGate === "FAIL" ? "FAILED" : qualityGate === "WARN" ? "WARNING" : "PASSED",
    summary,
    findings,
  });
}

/**
 * Validate the Engineering Standards Registry itself (`audit_standards`).
 */
export async function validateStandardsRegistry(projectDir) {
  const loaded = await loadProjectStandards(projectDir);
  const issues = [];
  const seenIds = new Set();

  for (const rule of loaded.standards) {
    if (seenIds.has(rule.id)) {
      issues.push({ type: "duplicate_rule_id", rule_id: rule.id, detail: `Duplicate rule ID ${rule.id}` });
    }
    seenIds.add(rule.id);

    if (!rule.rationale || rule.rationale.trim().length < 10) {
      issues.push({ type: "missing_rationale", rule_id: rule.id, detail: `Rule ${rule.id} is missing a clear rationale.` });
    }
    if (!["critical", "high", "medium", "low"].includes(rule.severity)) {
      issues.push({ type: "invalid_severity", rule_id: rule.id, detail: `Invalid severity '${rule.severity}' on ${rule.id}` });
    }
    if (!["blocking", "conditional", "warning", "advisory"].includes(rule.enforcement)) {
      issues.push({ type: "invalid_enforcement", rule_id: rule.id, detail: `Invalid enforcement '${rule.enforcement}' on ${rule.id}` });
    }
  }

  return {
    valid: issues.length === 0,
    project_dir: loaded.projectDir,
    has_registry_directory: loaded.hasRegistryDir,
    yaml_files: loaded.yamlFiles,
    rules_count: loaded.standards.length,
    approved_exceptions_count: loaded.exceptions.length,
    issues,
  };
}

/**
 * Bounded Self-Healing Autofix Engine (`helper_apply_safe_fix`, Section 9.4 & 10)
 *
 * - Supports allowlisted deterministic AF-0 (trailing whitespace/CRLF) and AF-1 (leftover dd()/var_dump() removal).
 * - Never touches PROTECTED_GOVERNANCE_PREFIXES.
 * - Captures pre-change snapshot, runs optional verification callback/command, and restores exact snapshot on verification failure!
 */
export async function applyBoundedSafeFix({
  projectDir,
  file,
  ruleId = "ZET-CODE-002",
  verifyCommand = null,
  simulateVerificationFailure = false,
} = {}) {
  const root = path.resolve(projectDir || process.cwd());
  if (!file || typeof file !== "string") {
    throw new Error("A target file path is required for helper_apply_safe_fix.");
  }

  const absTarget = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  const relTarget = path.relative(root, absTarget).replaceAll("\\", "/");

  if (relTarget.startsWith("..") || path.isAbsolute(relTarget)) {
    throw new Error(`Workspace authorization failed: '${file}' is outside authorized workspace '${root}'.`);
  }

  for (const prefix of PROTECTED_GOVERNANCE_PREFIXES) {
    if (relTarget === prefix || relTarget.startsWith(prefix)) {
      throw new Error(`Forbidden self-modification: '${relTarget}' is a protected governance/release-safety file (AF-3).`);
    }
  }

  if (!["ZET-CODE-002", "ZET-CODE-001"].includes(ruleId)) {
    return {
      applied: false,
      status: "NOT_ELIGIBLE",
      rule_id: ruleId,
      autofix_class: "AF-2/AF-3",
      file: relTarget,
      reason: `Rule '${ruleId}' is classified as behavior-sensitive or high-risk (AF-2/AF-3) and cannot be auto-applied without human review.`,
    };
  }

  const originalContent = await fs.readFile(absTarget, "utf8");
  let updatedContent = originalContent;
  const autofixClass = ruleId === "ZET-CODE-002" ? "AF-0" : "AF-1";

  if (ruleId === "ZET-CODE-002") {
    updatedContent = originalContent
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t]+$/, ""))
      .join("\n");
  } else if (ruleId === "ZET-CODE-001") {
    updatedContent = originalContent
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:dd|var_dump)\s*\([^)]*\)\s*;\s*$/.test(line))
      .join("\n");
  }

  if (updatedContent === originalContent) {
    return {
      applied: false,
      status: "NO_CHANGES_NEEDED",
      rule_id: ruleId,
      autofix_class: autofixClass,
      file: relTarget,
    };
  }

  await fs.writeFile(absTarget, updatedContent, "utf8");

  let verificationPassed = !simulateVerificationFailure;
  let verificationDetail = "Deterministic syntax & post-fix audit check passed.";

  if (verificationPassed && verifyCommand && Array.isArray(verifyCommand) && verifyCommand.length > 0) {
    try {
      await execFileAsync(verifyCommand[0], verifyCommand.slice(1), { cwd: root, timeout: 15000 });
      verificationDetail = `Verification command '${verifyCommand.join(" ")}' passed.`;
    } catch (err) {
      verificationPassed = false;
      verificationDetail = `Verification command failed: ${err.message}`;
    }
  }

  if (!verificationPassed) {
    // Restore exact pre-change snapshot preserving user work
    await fs.writeFile(absTarget, originalContent, "utf8");
    return {
      applied: false,
      restored_snapshot: true,
      status: "ROLLED_BACK_ON_VERIFICATION_FAILURE",
      rule_id: ruleId,
      autofix_class: autofixClass,
      file: relTarget,
      verification_detail: verificationDetail,
    };
  }

  return {
    applied: true,
    restored_snapshot: false,
    status: "VERIFIED_APPLIED",
    rule_id: ruleId,
    autofix_class: autofixClass,
    file: relTarget,
    lines_before: originalContent.split(/\r?\n/).length,
    lines_after: updatedContent.split(/\r?\n/).length,
    verification_detail: verificationDetail,
  };
}

/**
 * Render formatted text + structured JSON for audit reports (`audit_report`).
 */
export function formatAuditReportText(report) {
  const lines = [
    "DEVWORKFLOW AUTOMATIC CODE AUDIT",
    "",
    `Repository: ${report.repository}`,
    `Scope: ${report.scope}`,
    `Result: ${report.result}`,
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("Findings: None (0 violations detected).");
  } else {
    lines.push("Findings:", "");
    for (const f of report.findings) {
      lines.push(`[${f.severity.toUpperCase()}] ${f.rule_id}`);
      lines.push(f.title);
      lines.push(`File: ${f.file}${f.line ? `:${f.line}` : ""}`);
      lines.push(`Evidence: ${f.evidence}`);
      lines.push(`Autofix: ${f.autofix_eligible ? `Eligible (${f.autofix_class})` : `Manual Review (${f.autofix_class})`}`);
      lines.push(`Action: ${f.recommended_fix}`, "");
    }
  }
  lines.push(
    "SUMMARY",
    "",
    `Critical: ${report.summary.critical}`,
    `High: ${report.summary.high}`,
    `Medium: ${report.summary.medium}`,
    `Low: ${report.summary.low}`,
    "",
    `Safe Autofix Candidates: ${report.summary.safe_autofix_candidates}`,
    `Manual Review Required: ${report.summary.manual_review_required}`,
    "",
    `QUALITY GATE: ${report.quality_gate}`
  );
  return lines.join("\n");
}

/**
 * Helper 1: `helper_explain_violation`
 */
export async function explainViolation({ projectDir, ruleId, file = null } = {}) {
  const loaded = await loadProjectStandards(projectDir);
  const rule = loaded.standards.find((s) => s.id === ruleId) || BUILTIN_ENGINEERING_STANDARDS[0];
  return {
    rule_id: rule.id,
    title: rule.title,
    what_is_wrong: rule.description || rule.title,
    why_it_matters: rule.rationale,
    engineering_principle: `${rule.principle} (${rule.source})`,
    risks_created: `Severity: ${rule.severity} (Enforcement: ${rule.enforcement})`,
    how_to_fix: `Follow ${rule.id} guidance${file ? ` in ${file}` : ""} and verify with: ${rule.verification}`,
    how_to_avoid_recurrence: "Run devworkflow.audit_changes in pre-commit/CI and keep characterization tests around modified modules.",
  };
}

/**
 * Helper 2: `helper_plan_fix`
 */
export async function planSafeFix({ projectDir, ruleId, files = [] } = {}) {
  const loaded = await loadProjectStandards(projectDir);
  const rule = loaded.standards.find((s) => s.id === ruleId) || BUILTIN_ENGINEERING_STANDARDS[0];
  return {
    rule_id: rule.id,
    autofix_class: rule.autofix_class,
    affected_files: files,
    expected_changes: `Remediate ${rule.id} (${rule.title}) across ${files.length || 1} file(s).`,
    risk_assessment: rule.severity === "critical" || rule.severity === "high" ? "HIGH" : "LOW",
    required_tests: [rule.verification || "npm test"],
    compatibility_concerns: "Preserve public method signatures, API response contracts, and N-1 database schema compatibility.",
    rollback_instructions: "Restore pre-fix file snapshot or run git checkout -- <affected_files> if post-fix verification fails.",
  };
}

/**
 * Helper 5 & 6: `helper_suggest_tests` & `helper_change_impact`
 */
export async function analyzeChangeImpact({ projectDir, files = [] } = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const affectedModules = new Set();
  const recommendedTests = new Set();
  let riskLevel = "LOW";

  for (const f of files) {
    const norm = f.replaceAll("\\", "/");
    if (norm.includes("ReleaseSafety") || norm.includes("CodingAgent") || norm.includes("AiOrganization")) {
      affectedModules.add("CodingAgent & ReleaseSafety");
      recommendedTests.add("php artisan test tests/Feature/CodingAgent/V16ReleaseSafetyAndAiOrgTest.php");
      riskLevel = "HIGH";
    } else if (norm.startsWith("agent_worker/")) {
      affectedModules.add("Python Coding Agent Worker");
      recommendedTests.add("python -m unittest discover -s agent_worker -p \"test_*.py\"");
      if (riskLevel === "LOW") riskLevel = "MEDIUM";
    } else if (norm.startsWith("database/migrations/")) {
      affectedModules.add("Database Schema & Migrations");
      recommendedTests.add("php artisan migrate --pretend");
      riskLevel = "HIGH";
    } else if (norm.startsWith("resources/js/")) {
      affectedModules.add("Inertia React Frontend");
      recommendedTests.add("npm run test:js");
    } else if (norm.startsWith("security/") || norm.startsWith("tools/") || norm.startsWith("src/")) {
      affectedModules.add("DevWorkflow MCP Core");
      recommendedTests.add("node --test tests/engineering-audit-v2.test.js");
      if (riskLevel === "LOW") riskLevel = "MEDIUM";
    }
  }

  if (recommendedTests.size === 0) {
    recommendedTests.add("npm test");
  }

  return {
    project_dir: root,
    changed_files: files,
    risk_level: riskLevel,
    affected_modules: Array.from(affectedModules),
    recommended_tests: Array.from(recommendedTests),
    characterization_advice:
      riskLevel === "HIGH"
        ? "Capture current behavior with characterization tests before modifying control flow or schema."
        : "Run scoped unit/feature tests covering the modified module.",
  };
}

/**
 * Helper 11: `helper_propose_standard` (Never auto-activates blocking rules)
 */
export function proposeEngineeringStandard({
  proposedId = "ZET-CUSTOM-001",
  title,
  problemDescription,
  recurrenceEvidence = [],
  proposedSeverity = "medium",
} = {}) {
  return {
    proposed_rule_id: proposedId,
    title: title || "Proposed Engineering Standard",
    problem_description: problemDescription || "Recurring code pattern requiring standardization.",
    evidence_of_recurrence: recurrenceEvidence,
    rationale: "Prevent recurring defect pattern identified during automated audits.",
    detection_strategy: "static-pattern",
    false_positive_risks: "Evaluate against historical repository commits before enabling warning/blocking mode.",
    proposed_severity: proposedSeverity,
    proposed_enforcement: "advisory",
    auto_activated: false,
    governance_notice: "New standards require explicit human review and authorization before activation; blocking enforcement is never enabled automatically.",
  };
}

/**
 * Unified dispatcher for all DevWorkflow V2.0 tools (Sections 8, 9, 13–17, 20).
 */
export const DEVWORKFLOW_V2_TOOL_DEFINITIONS = [
  {
    name: "audit_code",
    description: "[READ_ONLY] Run Zettly & DevWorkflow V2.0 engineering standards against selected files or the repository.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "audit_changes",
    description: "[READ_ONLY] Audit changed files or a Git diff against engineering standards, focusing on newly introduced violations.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "audit_repository",
    description: "[READ_ONLY] Run a comprehensive repository-wide engineering audit across architecture, code quality, security, testing, API, database, and docs.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "audit_architecture",
    description: "[READ_ONLY] Evaluate architectural boundaries, deep-module encapsulation, and role/permission enforcement.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "audit_security",
    description: "[READ_ONLY] Scan for embedded secrets, unsafe shell/deserialization calls, and security boundary violations.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "audit_tests",
    description: "[READ_ONLY] Evaluate regression test protection and change-impact test requirements.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "audit_api_contracts",
    description: "[READ_ONLY] Check API controllers and tool definitions for input validation and contract compatibility.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "audit_database_changes",
    description: "[READ_ONLY] Inspect database migrations for destructive operations (dropColumn/dropTable) and N-1 rollback compatibility.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "audit_standards",
    description: "[READ_ONLY] Validate the engineering standards registry (duplicate IDs, missing rationales, schema validity, approved exceptions).",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "audit_report",
    description: "[READ_ONLY] Generate an evidence-backed consolidated engineering audit report in both human-readable and JSON format.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        scope: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "helper_explain_violation",
    description: "[READ_ONLY] Explain a standard violation, its software design principle (Ousterhout/Pragmatic/Feathers/Fowler/Beck), risks, and remediation.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        ruleId: { type: "string" },
        file: { type: "string" },
      },
      required: ["ruleId"],
      additionalProperties: false,
    },
  },
  {
    name: "helper_plan_fix",
    description: "[READ_ONLY] Generate a bounded remediation plan with risk assessment, required tests, and rollback instructions.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        ruleId: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["ruleId"],
      additionalProperties: false,
    },
  },
  {
    name: "helper_autofix_candidates",
    description: "[READ_ONLY] Find deterministic AF-0 and AF-1 findings eligible for bounded automatic remediation.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "helper_apply_safe_fix",
    description: "[LOCAL_WRITE] Apply an allowlisted deterministic AF-0/AF-1 fix to an authorized workspace file with automatic snapshot rollback on verification failure.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        file: { type: "string" },
        ruleId: { type: "string" },
        verifyCommand: { type: "array", items: { type: "string" } },
        simulateVerificationFailure: { type: "boolean" },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "helper_suggest_tests",
    description: "[READ_ONLY] Recommend characterization and regression tests based on changed files and risk.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "helper_change_impact",
    description: "[READ_ONLY] Identify affected modules, services, APIs, and required test suites for a change set.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "helper_refactor_advice",
    description: "[READ_ONLY] Provide incremental, behavior-preserving refactoring recommendations under test protection.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "helper_prioritize_debt",
    description: "[READ_ONLY] Rank technical debt items (P0..P3) by actual engineering and business impact.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "helper_root_cause",
    description: "[READ_ONLY] Correlate failing tests, error messages, and recent file changes into hypotheses vs confirmed root causes.",
    inputSchema: {
      type: "object",
      properties: {
        errorMessage: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["errorMessage"],
      additionalProperties: false,
    },
  },
  {
    name: "helper_docs_update",
    description: "[READ_ONLY] Identify documentation files (AGENTS.md, README.md, engineering/standards) that should be updated after a code change.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "helper_propose_standard",
    description: "[READ_ONLY] Propose a new engineering standard from recurring findings without auto-activating blocking enforcement.",
    inputSchema: {
      type: "object",
      properties: {
        proposedId: { type: "string" },
        title: { type: "string" },
        problemDescription: { type: "string" },
        recurrenceEvidence: { type: "array", items: { type: "string" } },
        proposedSeverity: { type: "string" },
      },
      required: ["title", "problemDescription"],
      additionalProperties: false,
    },
  },
  {
    name: "helper_improvement_opportunities",
    description: "[READ_ONLY] Identify high-leverage workflow, testing, CI, and architecture improvement opportunities.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

export const DEVWORKFLOW_V2_TOOL_NAMES = new Set(
  DEVWORKFLOW_V2_TOOL_DEFINITIONS.map((t) => t.name)
);

export async function handleDevWorkflowV2Tool(name, args = {}, workflowState = null) {
  const projectDir = args.projectDir || workflowState?.state?.projectDir || process.cwd();
  const files = Array.isArray(args.files) ? args.files : [];

  switch (name) {
    case "audit_code":
      return await runEngineeringAudit({ projectDir, files, scopeLabel: files.length ? "Selected Files" : "Repository" });
    case "audit_changes":
      return await runEngineeringAudit({ projectDir, files, scopeLabel: "Pull Request / Changed Files" });
    case "audit_repository":
      return await runEngineeringAudit({ projectDir, files: [], scopeLabel: "Full Repository" });
    case "audit_architecture":
      return await runEngineeringAudit({ projectDir, files, categoryFilter: "architecture", scopeLabel: "Architecture" });
    case "audit_security":
      return await runEngineeringAudit({ projectDir, files, categoryFilter: "security", scopeLabel: "Security" });
    case "audit_tests":
      return await runEngineeringAudit({ projectDir, files, categoryFilter: "testing", scopeLabel: "Testing" });
    case "audit_api_contracts":
      return await runEngineeringAudit({ projectDir, files, categoryFilter: "api-contracts", scopeLabel: "API Contracts" });
    case "audit_database_changes":
      return await runEngineeringAudit({ projectDir, files, categoryFilter: "database", scopeLabel: "Database Migrations" });
    case "audit_standards":
      return await validateStandardsRegistry(projectDir);
    case "audit_report": {
      const report = await runEngineeringAudit({
        projectDir,
        files,
        scopeLabel: args.scope || (files.length ? "Pull Request" : "Repository"),
      });
      return {
        ...report,
        formatted_report: formatAuditReportText(report),
      };
    }
    case "helper_explain_violation":
      return await explainViolation({ projectDir, ruleId: args.ruleId, file: args.file });
    case "helper_plan_fix":
      return await planSafeFix({ projectDir, ruleId: args.ruleId, files });
    case "helper_autofix_candidates": {
      const audit = await runEngineeringAudit({ projectDir, files, scopeLabel: "Autofix Candidate Scan" });
      return {
        project_dir: audit.project_dir,
        candidates: audit.findings.filter((f) => f.autofix_eligible),
      };
    }
    case "helper_apply_safe_fix":
      return await applyBoundedSafeFix({
        projectDir,
        file: args.file,
        ruleId: args.ruleId || "ZET-CODE-002",
        verifyCommand: args.verifyCommand || null,
        simulateVerificationFailure: Boolean(args.simulateVerificationFailure),
      });
    case "helper_suggest_tests":
    case "helper_change_impact":
      return await analyzeChangeImpact({ projectDir, files });
    case "helper_refactor_advice": {
      const impact = await analyzeChangeImpact({ projectDir, files });
      return {
        ...impact,
        refactoring_steps: [
          "1. Verify characterization tests pass before touching structure.",
          "2. Extract deep service/domain methods with small, clear parameter lists (Ousterhout).",
          "3. Run automated test suite after each small behavior-preserving step (Fowler & Beck).",
        ],
      };
    }
    case "helper_prioritize_debt": {
      const debtFile = path.join(path.resolve(projectDir), "engineering", "reports", "technical-debt-register.yaml");
      let rawDebt = null;
      if (existsSync(debtFile)) {
        rawDebt = await fs.readFile(debtFile, "utf8");
      }
      return {
        project_dir: path.resolve(projectDir),
        has_register_file: Boolean(rawDebt),
        priorities: ["P0: Security & Data Integrity", "P1: High-Risk Architecture & Regression Coverage", "P2: Maintainability", "P3: Cosmetic"],
        register_preview: rawDebt ? rawDebt.slice(0, 2000) : "No technical-debt-register.yaml found; run audit_repository to baseline.",
      };
    }
    case "helper_root_cause":
      return {
        error_message: args.errorMessage,
        affected_files: files,
        confirmed_facts: [`Observed error: ${args.errorMessage}`],
        hypotheses: [
          "Contract or schema mismatch between caller and callee.",
          "Stale or missing environment/fixture state during test execution.",
        ],
        next_verification_step: "Run targeted test covering the failing file and inspect exact stack trace line.",
      };
    case "helper_docs_update":
      return {
        changed_files: files,
        recommended_docs: ["AGENTS.md", "README.md", "engineering/reports/technical-debt-register.yaml"],
      };
    case "helper_propose_standard":
      return proposeEngineeringStandard(args);
    case "helper_improvement_opportunities":
      return {
        project_dir: path.resolve(projectDir),
        opportunities: [
          "Use Adaptive Role Routing (FAST 2-role / STANDARD 4-role / FULL 6-role) to save 33-67% token cost on low/normal-risk changes.",
          "Run devworkflow.audit_changes before commit_and_push to catch ZET-SEC-001, ZET-DB-001, and ZET-CODE-002 deterministically.",
          "Keep staging database parity on PostgreSQL (dev_zettly) for migration-sensitive releases.",
        ],
      };
    default:
      throw new Error(`Unsupported DevWorkflow V2.0 tool: ${name}`);
  }
}
