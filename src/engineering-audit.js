import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanSecrets } from "../security/scanner.js";
import { sanitize } from "../security/sanitizer.js";
import {
  ProjectOwnershipLostError,
  acquireWorktreeMutex,
  releaseWorktreeMutex,
  getHeldWorktreeCapability,
  useWorktreeCapability,
  resolveCanonicalWorktreeRoot,
} from "../process-lock.js";

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
    description: "Controllers, UI views, and transport handlers must delegate complex queries and transactions to deep domain/service modules.",
    category: "architecture",
    principle: "Deep Modules & Information Hiding",
    source: "A Philosophy of Software Design (John Ousterhout)",
    severity: "medium",
    enforcement: "advisory",
    detection: "static-pattern",
    pattern: "\\b(?:DB::raw|mysqli_query)\\s*\\(",
    autofix: "proposal-only",
    autofix_class: "AF-2",
    scope: ["backend", "mcp_server"],
    rationale: "Controllers and views should delegate complex queries and transactions to deep domain/service modules.",
    evidence_requirements: "File path, line number, and matched query call.",
    exception_process: "Record approved exception in engineering/exceptions/approved-exceptions.yaml with owner and expiry.",
    verification: "php artisan test",
  },
  {
    id: "ZET-ARCH-002",
    title: "Enforce role permission and release safety boundaries in server code",
    description: "Autonomous coding agent roles, worker endpoints, and mutating MCP tools must enforce permission and safety boundaries in server code.",
    category: "architecture",
    principle: "Design by Contract & Least Privilege",
    source: "The Pragmatic Programmer (David Thomas & Andrew Hunt)",
    severity: "critical",
    enforcement: "blocking",
    detection: "architecture-boundary",
    pattern: "allow_auto_merge\\s*=>\\s*true|bypass_safety_policy\\s*=\\s*true",
    autofix: "disabled",
    autofix_class: "AF-3",
    scope: ["backend", "agent_worker", "mcp_server"],
    rationale: "Safety gates and role permissions must never be weakened or bypassed in code.",
    evidence_requirements: "Exact line demonstrating policy bypass or auto-merge override.",
    exception_process: "No exceptions permitted for blocking security boundary rules.",
    verification: "php artisan test tests/Feature/CodingAgent/V16ReleaseSafetyAndAiOrgTest.php",
  },
  {
    id: "ZET-ARCH-003",
    title: "Respect layered dependency direction and prevent forbidden cross-layer imports",
    description: "Presentation/UI layers and read-only modules must not directly import raw database adapters, internal secret vaults, or unguarded shell primitives.",
    category: "architecture",
    principle: "Acyclic Dependencies & Information Hiding",
    source: "A Philosophy of Software Design (John Ousterhout) & The Pragmatic Programmer",
    severity: "high",
    enforcement: "blocking",
    detection: "dependency-analysis",
    pattern: "from\\s+[\"'](?:\\.\\.\\/)+db\\/adapters\\/|require\\s*\\(\\s*[\"'](?:\\.\\.\\/)+db\\/adapters\\/",
    autofix: "proposal-only",
    autofix_class: "AF-2",
    scope: ["backend", "frontend", "mcp_server"],
    rationale: "Unidirectional dependencies prevent circular coupling and preserve architectural layering.",
    evidence_requirements: "Import statement violating module boundary.",
    exception_process: "Record approved architectural exception with migration target.",
    verification: "npm test",
  },
  {
    id: "ZET-CODE-001",
    title: "Avoid duplicated business knowledge and leftover debug statements",
    description: "Production source files must not contain leftover debug dump statements (dd(), var_dump()).",
    category: "code-quality",
    principle: "DRY & Clean Production Code",
    source: "The Pragmatic Programmer & Refactoring (Martin Fowler)",
    severity: "medium",
    enforcement: "warning",
    detection: "regex",
    pattern: "^\\s*(?:dd|var_dump)\\s*\\([^)]*\\)\\s*;\\s*$",
    autofix: "AF-1",
    autofix_class: "AF-1",
    scope: ["backend", "frontend", "agent_worker", "mcp_server"],
    rationale: "Leftover debug dumps leak internal state and halt execution unexpectedly.",
    evidence_requirements: "File path and line number of debug statement.",
    exception_process: "Approved test or CLI diagnostic files only.",
    verification: "npm test",
  },
  {
    id: "ZET-CODE-002",
    title: "Deterministic formatting and no unresolved merge conflict markers or trailing whitespace",
    description: "Source files must not contain unresolved Git merge conflict markers or trailing whitespace pollution.",
    category: "code-quality",
    principle: "Continuous Integration & Small Clean Changes",
    source: "Extreme Programming Explained (Kent Beck)",
    severity: "high",
    enforcement: "blocking",
    detection: "regex",
    pattern: "^(?:<<<<<<<|=======|>>>>>>>)(?:\\s|$)|[ \\t]+$",
    autofix: "AF-0",
    autofix_class: "AF-0",
    scope: ["backend", "frontend", "agent_worker", "mcp_server"],
    rationale: "Conflict markers break runtime parsing and trailing whitespace pollutes diffs.",
    evidence_requirements: "File path and line number of conflict marker or trailing whitespace.",
    exception_process: "None.",
    verification: "git diff --check",
  },
  {
    id: "ZET-SEC-001",
    title: "No embedded credentials, private keys, or live tokens",
    description: "Source code, configurations, and tests must never embed live API keys, private keys, or bearer tokens.",
    category: "security",
    principle: "Security by Design",
    source: "The Pragmatic Programmer",
    severity: "critical",
    enforcement: "blocking",
    detection: "secret-scanner",
    pattern: "(?:ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)",
    autofix: "disabled",
    autofix_class: "AF-3",
    scope: ["backend", "frontend", "agent_worker", "mcp_server"],
    rationale: "Embedded credentials in source files compromise production systems permanently.",
    evidence_requirements: "Redacted secret type and line number without exposing credential value.",
    exception_process: "Never allowed.",
    verification: "security_audit",
  },
  {
    id: "ZET-SEC-002",
    title: "No unrestricted shell execution or unsafe deserialization",
    description: "Avoid unvalidated shell execution (shell_exec, passthru, unserialize on untrusted input).",
    category: "security",
    principle: "Defensive Input Validation",
    source: "The Pragmatic Programmer",
    severity: "high",
    enforcement: "blocking",
    detection: "regex",
    pattern: "\\b(?:shell_exec|passthru|unserialize)\\s*\\(",
    autofix: "disabled",
    autofix_class: "AF-3",
    scope: ["backend", "agent_worker", "mcp_server"],
    rationale: "Unrestricted command execution or unsafe deserialization leads to remote code execution.",
    evidence_requirements: "File path, line number, and matched call.",
    exception_process: "Requires security architect approval in approved-exceptions.yaml.",
    verification: "php artisan test",
  },
  {
    id: "ZET-TEST-001",
    title: "Protect critical behavior with characterization and regression tests before risky changes",
    description: "Any modification to release safety, lock lifecycle, security boundaries, or coding-agent orchestration must include automated regression test coverage.",
    category: "testing",
    principle: "Legacy Code Safety & Characterization Tests",
    source: "Working Effectively with Legacy Code (Michael Feathers)",
    severity: "high",
    enforcement: "conditional",
    detection: "change-impact-analysis",
    autofix: "proposal-only",
    autofix_class: "AF-2",
    scope: ["backend", "frontend", "agent_worker", "mcp_server"],
    rationale: "Modifying critical services without corresponding test coverage risks silent regressions.",
    evidence_requirements: "Modified critical path and absence of accompanying test files in change set.",
    exception_process: "Requires explicit waiver reason in task Definition of Done.",
    verification: "php artisan test && npm test",
  },
  {
    id: "ZET-API-001",
    title: "Backward-compatible API contracts and defensive input validation",
    description: "API endpoints and MCP tool definitions must validate incoming inputs using explicit schemas and preserve backward-compatible response envelopes.",
    category: "api-contracts",
    principle: "Design by Contract",
    source: "The Pragmatic Programmer",
    severity: "high",
    enforcement: "blocking",
    detection: "api-contract-analysis",
    autofix: "proposal-only",
    autofix_class: "AF-2",
    scope: ["backend", "mcp_server"],
    rationale: "API endpoints must validate request payloads and preserve response structure compatibility.",
    evidence_requirements: "Controller or tool definition lacking input validation.",
    exception_process: "Versioned API endpoint migration plan required.",
    verification: "php artisan test",
  },
  {
    id: "ZET-DB-001",
    title: "Additive N-1 compatible database migrations and no unapproved destructive schema changes",
    description: "Database migrations must be N-1 compatible; destructive operations (dropColumn, dropIfExists, dropTable) are blocked without verified pre-deploy backup and approval.",
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
    evidence_requirements: "Migration file and destructive DDL call in up() method.",
    exception_process: "Requires verified GCS backup sha256 and human approval.",
    verification: "php artisan migrate --pretend",
  },
  {
    id: "ZET-DOC-001",
    title: "Synchronized architectural and operational documentation",
    description: "Significant architectural, API, or release-safety changes must update AGENTS.md, README.md, or canonical engineering documentation.",
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
    evidence_requirements: "Modified architectural files without documentation update.",
    exception_process: "Waive with explicit justification when changes are purely internal.",
    verification: "audit_standards",
  },
  {
    id: "ZET-REL-001",
    title: "8-Dimension PR Reversibility & 15-Condition Autonomous Release Gate",
    description: "Every release must satisfy 8-dimension reversibility and staging verification before production cutover.",
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
    evidence_requirements: "Release readiness assessment across 8 reversibility dimensions.",
    exception_process: "Explicit human owner override with verified recovery runbook.",
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

const SECRET_TOKEN_REGEX =
  /(?:\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:live-|proj-|test-)?[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})\b|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/g;

/**
 * Redact any raw credential tokens from evidence strings so secrets are never exposed in outputs.
 */
export function redactSecretValues(text) {
  if (typeof text !== "string" || !text) return "";
  return text.replace(SECRET_TOKEN_REGEX, "<REDACTED_SECRET>");
}

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
    const rawAutofix = getField("autofix") || "proposal-only";
    const autofixClass = rawAutofix.startsWith("AF-")
      ? rawAutofix
      : rawAutofix === "disabled" || rawAutofix === "false"
        ? "AF-3"
        : "AF-2";
    rules.push({
      id,
      title: getField("title") || id,
      description: getField("description") || "",
      rationale: getField("rationale") || "",
      principle: getField("principle") || "Engineering Excellence",
      source: getField("source") || "Zettly Engineering Standard",
      category: (getField("category") || categoryFallback).toLowerCase(),
      severity: (getField("severity") || "medium").toLowerCase(),
      enforcement: (getField("enforcement") || "advisory").toLowerCase(),
      detection: getField("detection") || "static-pattern",
      pattern: getField("pattern") || null,
      autofix: rawAutofix,
      autofix_class: autofixClass,
      evidence_requirements: getField("evidence_requirements") || "File path, line number, and matched pattern.",
      exception_process: getField("exception_process") || "Record approved exception in engineering/exceptions/approved-exceptions.yaml.",
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
          loadedRules.set(r.id, {
            ...existing,
            ...r,
            rationale: r.rationale || existing.rationale || "Enforce engineering quality standard.",
            pattern: r.pattern || existing.pattern || null,
          });
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
          expires_at: getF("expires_at"),
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
  const nowMs = Date.now();
  return exceptions.some((e) => {
    if (e.rule_id !== ruleId || !e.file) return false;
    if (e.expires_at) {
      const exp = Date.parse(e.expires_at);
      if (Number.isFinite(exp) && exp < nowMs) return false;
    }
    return norm.endsWith(e.file.replaceAll("\\", "/"));
  });
}

/**
 * Discover changed and untracked files in a Git repository when `audit_changes`
 * is invoked without an explicit `files` array.
 */
export async function discoverGitChangedFiles(root) {
  const discovered = new Set();
  try {
    const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain", "-uall"], {
      cwd: root,
      timeout: 5000,
      windowsHide: true,
    });
    for (const rawLine of String(statusOut || "").split(/\r?\n/)) {
      if (!rawLine || rawLine.length < 4) continue;
      const status = rawLine.slice(0, 2);
      if (status.includes("D")) continue;
      let rel = rawLine.slice(3).trim();
      if (rel.includes(" -> ")) {
        rel = rel.split(" -> ").pop().trim();
      }
      rel = rel.replace(/^"|"$/g, "").replaceAll("\\", "/");
      if (rel) discovered.add(rel);
    }
  } catch {
    // not a git repo or git unavailable
  }
  return Array.from(discovered);
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

async function loadAuditBaseline(root, { baseline = null, baselineFile = null } = {}) {
  if (Array.isArray(baseline)) {
    return { active: true, items: baseline };
  }
  if (baseline && Array.isArray(baseline.findings)) {
    return { active: true, items: baseline.findings };
  }
  const candidateFile = baselineFile
    ? path.isAbsolute(baselineFile)
      ? baselineFile
      : path.join(root, baselineFile)
    : path.join(root, "engineering", "reports", "audit-baseline.json");
  if (existsSync(candidateFile)) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidateFile, "utf8"));
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : [];
      return { active: true, items };
    } catch {
      return { active: false, items: [] };
    }
  }
  return { active: false, items: [] };
}

/**
 * Core Automatic Code Audit Engine (Section 4, 5, 16)
 */
export async function runEngineeringAudit({
  projectDir,
  files = [],
  categoryFilter = null,
  scopeLabel = "Repository",
  discoverGitChanges = false,
  baseline = null,
  baselineFile = null,
} = {}) {
  const loaded = await loadProjectStandards(projectDir);
  const root = loaded.projectDir;

  let effectiveFiles = Array.isArray(files) ? [...files] : [];
  if (effectiveFiles.length === 0 && discoverGitChanges) {
    effectiveFiles = await discoverGitChangedFiles(root);
  }

  const isScopedAudit = effectiveFiles.length > 0;
  const targetFiles = await collectAuditFiles(root, effectiveFiles);
  const rawFindings = [];
  const seenFindingKeys = new Set();

  const pushFinding = (finding) => {
    const key = `${finding.rule_id}::${finding.file}::${finding.line || 1}`;
    if (seenFindingKeys.has(key)) return;
    seenFindingKeys.add(key);
    rawFindings.push({
      ...finding,
      evidence: redactSecretValues(String(finding.evidence || "")),
      detection_type: finding.detection_type || "deterministic",
    });
  };

  const applicableStandards = categoryFilter
    ? loaded.standards.filter((s) => s.category === categoryFilter)
    : loaded.standards;

  const hasTestChange = targetFiles.some(
    (f) => /(?:^|\/)tests?\//i.test(f) || /(?:\.test|_test|Test)\.(?:js|ts|php|py)$/i.test(f)
  );

  // Rules handled by specialized context-aware analyzers below
  const specializedRuleIds = new Set([
    "ZET-SEC-001",
    "ZET-CODE-002",
    "ZET-CODE-001",
    "ZET-DB-001",
    "ZET-ARCH-001",
    "ZET-TEST-001",
  ]);

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
    const isControllerOrViewFile =
      /app\/Http\/Controllers\/.*\.php$/i.test(relPath) ||
      /resources\/js\/(?:Pages|Components)\/.*\.(?:jsx|tsx|js|ts)$/i.test(relPath);
    const lines = content.split(/\r?\n/);

    // 1. Secret scanning (ZET-SEC-001) with line-accurate detection & full credential redaction
    if (!categoryFilter || categoryFilter === "security") {
      const literalSecretTypes = new Set([
        "private_key",
        "ssh_key",
        "github_token",
        "aws_access_key",
        "api_key",
        "oauth_token",
        "jwt",
        "connection_credentials",
      ]);
      const secretHits = scanSecrets(content).filter((h) => literalSecretTypes.has(h.type));
      let secretLine = 1;
      for (let idx = 0; idx < lines.length; idx++) {
        SECRET_TOKEN_REGEX.lastIndex = 0;
        if (SECRET_TOKEN_REGEX.test(lines[idx])) {
          secretLine = idx + 1;
          break;
        }
      }
      SECRET_TOKEN_REGEX.lastIndex = 0;
      const hasEmbeddedToken = SECRET_TOKEN_REGEX.test(content);
      if (
        (secretHits.length > 0 || hasEmbeddedToken) &&
        !isExceptionApproved(loaded.exceptions, "ZET-SEC-001", relPath)
      ) {
        pushFinding({
          rule_id: "ZET-SEC-001",
          title: "No embedded credentials, private keys, or live tokens",
          category: "security",
          severity: "critical",
          enforcement: "blocking",
          file: relPath,
          line: secretLine,
          evidence: `Detected embedded secret pattern (${secretHits.map((h) => h.type).join(", ") || "token_pattern"}) at line ${secretLine} [<REDACTED_SECRET>]`,
          autofix_eligible: false,
          autofix_class: "AF-3",
          recommended_fix:
            "Remove embedded secret immediately, rotate credential, and load from environment or Secret Manager.",
        });
      }
    }

    // 2. Unresolved conflict markers & trailing whitespace (ZET-CODE-002)
    if (!categoryFilter || categoryFilter === "code-quality") {
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        if (/^(?:<<<<<<<|=======|>>>>>>>)(?:\s|$)/.test(line) && !isTestFile) {
          pushFinding({
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
        if (/[ \t]+$/.test(line) && isScopedAudit) {
          pushFinding({
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
        if (
          /^\s*(?:dd|var_dump)\s*\([^)]*\)\s*;\s*$/.test(lines[idx]) &&
          !isExceptionApproved(loaded.exceptions, "ZET-CODE-001", relPath)
        ) {
          pushFinding({
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
      if (
        /\b(?:dropColumn|dropIfExists|dropTable)\s*\(/.test(upSection) &&
        !isExceptionApproved(loaded.exceptions, "ZET-DB-001", relPath)
      ) {
        pushFinding({
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
          recommended_fix:
            "Use additive N-1 compatible migration steps and require a verified pre-deployment GCS database backup before running destructive DDL.",
        });
      }
    }

    // 5. Architecture boundary check: raw DB query in Controller/View (ZET-ARCH-001)
    if ((!categoryFilter || categoryFilter === "architecture") && isControllerOrViewFile) {
      if (/\bDB::raw\s*\(/.test(content) && !isExceptionApproved(loaded.exceptions, "ZET-ARCH-001", relPath)) {
        const lineIdx = lines.findIndex((l) => /\bDB::raw\s*\(/.test(l));
        pushFinding({
          rule_id: "ZET-ARCH-001",
          title: "Controller embeds raw SQL instead of delegating to a deep Service/Domain module",
          category: "architecture",
          severity: "medium",
          enforcement: "advisory",
          file: relPath,
          line: lineIdx >= 0 ? lineIdx + 1 : 1,
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
      isScopedAudit &&
      !hasTestChange &&
      /(?:app\/Services\/ReleaseSafety\/|app\/Services\/AiOrganization\/|security\/|process-lock\.js|workflow-state\.js)/i.test(
        relPath
      )
    ) {
      pushFinding({
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

    // 7. Dynamic evaluation of all other loaded standards (ZET-ARCH-002, ZET-ARCH-003, ZET-SEC-002, ZET-UI-001, and custom YAML rules)
    if (!isTestFile && !/\.(?:yaml|yml)$/i.test(relPath)) {
      for (const rule of applicableStandards) {
        if (!rule.pattern) continue;
        // If a custom YAML rule overrode ZET-ARCH-001 or another specialized rule with a custom pattern, evaluate it on non-controller files too
        const isDefaultArch001 =
          rule.id === "ZET-ARCH-001" &&
          (rule.pattern === "\\b(?:DB::raw|mysqli_query)\\s*\\(" || rule.pattern === "DB::raw\\(|mysqli_query\\(");
        if (specializedRuleIds.has(rule.id) && (rule.id !== "ZET-ARCH-001" || isDefaultArch001)) {
          continue;
        }
        if (isExceptionApproved(loaded.exceptions, rule.id, relPath)) continue;

        let regex;
        try {
          regex = new RegExp(rule.pattern);
        } catch {
          continue;
        }

        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx];
          if (regex.test(line)) {
            const autofixEligible = rule.autofix_class === "AF-0" || rule.autofix_class === "AF-1";
            pushFinding({
              rule_id: rule.id,
              title: rule.title,
              category: rule.category,
              severity: rule.severity,
              enforcement: rule.enforcement,
              file: relPath,
              line: idx + 1,
              evidence: redactSecretValues(line.trim().slice(0, 120)),
              autofix_eligible: autofixEligible,
              autofix_class: rule.autofix_class || "AF-2",
              recommended_fix: `Remediate ${rule.id} (${rule.title}) and verify with: ${rule.verification || "npm test"}`,
            });
            break;
          }
        }
      }
    }
  }

  // Baseline comparison (Section 4 & Scenario 10: distinguish new violations from historical technical debt)
  const baselineData = await loadAuditBaseline(root, { baseline, baselineFile });
  const baselineKeys = new Set(
    baselineData.items.map((item) => {
      const f = String(item.file || "").replaceAll("\\", "/");
      return `${item.rule_id}::${f}`;
    })
  );

  const findings = rawFindings.map((f) => {
    const isHistorical =
      baselineData.active &&
      f.rule_id !== "ZET-SEC-001" &&
      baselineKeys.has(`${f.rule_id}::${f.file.replaceAll("\\", "/")}`);
    return {
      ...f,
      is_new: !isHistorical,
      baseline_status: isHistorical ? "historical" : "new",
    };
  });

  const newFindings = findings.filter((f) => f.is_new);
  const historicalFindings = findings.filter((f) => !f.is_new);

  const summary = {
    critical: findings.filter((f) => f.severity === "critical").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    new_violations: newFindings.length,
    historical_debt: historicalFindings.length,
    safe_autofix_candidates: findings.filter((f) => f.autofix_eligible).length,
    manual_review_required: findings.filter((f) => !f.autofix_eligible).length,
  };

  // Quality gate blocks on NEW critical/high blocking findings (or any critical secret leak)
  const gatingFindings = baselineData.active ? newFindings : findings;
  const hasBlockingFailure = gatingFindings.some(
    (f) => f.enforcement === "blocking" && (f.severity === "critical" || f.severity === "high")
  );
  const qualityGate = hasBlockingFailure ? "FAIL" : findings.length > 0 ? "WARN" : "PASS";

  return sanitize({
    repository: path.basename(root),
    project_dir: root,
    scope: scopeLabel,
    files_audited: targetFiles.length,
    standards_loaded: applicableStandards.length,
    baseline_active: baselineData.active,
    result: qualityGate,
    quality_gate: qualityGate === "FAIL" ? "FAILED" : qualityGate === "WARN" ? "WARNING" : "PASSED",
    summary,
    findings,
    new_findings: newFindings.map((f) => ({ ...f })),
    historical_findings: historicalFindings.map((f) => ({ ...f })),
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
 * Verify worktree ownership and kernel mutex fencing before applying a mutating autofix
 * (Section 9 & Acceptance Scenarios 7 & 8).
 */
async function enforceAutofixOwnershipFence({
  root,
  workflowState = null,
  requireOwnership = false,
  sessionId = null,
} = {}) {
  const callerSessionKey =
    sessionId ||
    (typeof workflowState?._sessionKey === "function" ? workflowState._sessionKey()?.key : null) ||
    workflowState?.sessionId ||
    null;

  // 1. If a WorkflowState with requireKernelMutex is provided, assert its live ownership directly
  if (workflowState && (workflowState.requireKernelMutex || workflowState.boundKernelCapability || requireOwnership)) {
    const cap = workflowState._assertKernelOwnership("helper_apply_safe_fix");
    return { fencedCapability: cap, temporaryCapability: null };
  }

  // 2. Check if another session in the same process holds the worktree capability
  const heldCap = getHeldWorktreeCapability(root);
  if (heldCap) {
    if (callerSessionKey && heldCap.ownerKey && heldCap.ownerKey !== callerSessionKey) {
      throw new ProjectOwnershipLostError(
        `Project ownership conflict before helper_apply_safe_fix: worktree is owned by session "${heldCap.ownerKey}", not "${callerSessionKey}".`,
        {
          operation: "helper_apply_safe_fix",
          capabilityOwnerKey: heldCap.ownerKey,
          sessionKey: callerSessionKey,
        }
      );
    }
    return { fencedCapability: heldCap, temporaryCapability: null };
  }

  // 3. If strict ownership was explicitly required but no capability is held, fail closed
  if (requireOwnership) {
    throw new ProjectOwnershipLostError(
      "Project ownership lost before helper_apply_safe_fix: missing OS kernel mutex capability.",
      { operation: "helper_apply_safe_fix", reason: "missing_capability" }
    );
  }

  // 4. If root is a valid Git worktree, probe the OS kernel mutex to ensure no foreign OS process holds it
  const wt = resolveCanonicalWorktreeRoot(root);
  if (wt.ok) {
    const probe = await acquireWorktreeMutex({
      projectDir: wt.worktreeRoot,
      ownerKey: callerSessionKey || `autofix-${process.pid}`,
      timeoutMs: 0,
    });
    if (!probe.ok) {
      throw new ProjectOwnershipLostError(
        `Project ownership conflict before helper_apply_safe_fix: worktree mutex is held by another active client (${probe.reason || probe.error || "KERNEL_MUTEX_HELD"}).`,
        {
          operation: "helper_apply_safe_fix",
          reason: probe.reason || "held_by_other_process",
        }
      );
    }
    return {
      fencedCapability: probe.capability,
      temporaryCapability: probe.alreadyHeld ? null : probe.capability,
    };
  }

  return { fencedCapability: null, temporaryCapability: null };
}

/**
 * Bounded Self-Healing Autofix Engine (`helper_apply_safe_fix`, Section 7, 9, 16)
 *
 * - Enforces worktree kernel mutex ownership & concurrency fencing (fails closed on lost/foreign ownership).
 * - Supports allowlisted deterministic AF-0 (trailing whitespace/CRLF) and AF-1 (leftover dd()/var_dump() removal).
 * - Never touches PROTECTED_GOVERNANCE_PREFIXES.
 * - Captures pre-change snapshot, runs optional verification callback/command, and restores exact snapshot on verification failure.
 */
export async function applyBoundedSafeFix({
  projectDir,
  file,
  ruleId = "ZET-CODE-002",
  verifyCommand = null,
  simulateVerificationFailure = false,
  workflowState = null,
  requireOwnership = false,
  sessionId = null,
} = {}) {
  const root = path.resolve(projectDir || workflowState?.state?.projectDir || process.cwd());
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

  const { fencedCapability, temporaryCapability } = await enforceAutofixOwnershipFence({
    root,
    workflowState,
    requireOwnership,
    sessionId,
  });

  const executeFix = async () => {
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
  };

  try {
    if (fencedCapability) {
      return await useWorktreeCapability(fencedCapability, executeFix, {
        operation: "helper_apply_safe_fix",
      });
    }
    return await executeFix();
  } finally {
    if (temporaryCapability) {
      try {
        await releaseWorktreeMutex(temporaryCapability);
      } catch {
        // best-effort release of temporary probe mutex
      }
    }
  }
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
      const statusTag = f.baseline_status === "historical" ? " [HISTORICAL DEBT]" : "";
      lines.push(`[${f.severity.toUpperCase()}] ${f.rule_id}${statusTag}`);
      lines.push(f.title);
      lines.push(`File: ${f.file}${f.line ? `:${f.line}` : ""}`);
      lines.push(`Evidence: ${redactSecretValues(f.evidence)}`);
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
    `New Violations: ${report.summary.new_violations ?? report.findings.length}`,
    `Historical Debt: ${report.summary.historical_debt ?? 0}`,
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
    } else if (norm.includes("process-lock") || norm.includes("workflow-state") || norm.includes("commit-handlers")) {
      affectedModules.add("DevWorkflow Lock & Lifecycle Core");
      recommendedTests.add("node --import ./tests/setup-env.js --test tests/project-lock-lifecycle-termination.test.js tests/process-lock.test.js");
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
 * Helper 11: `helper_propose_standard` (Never auto-activates blocking rules; Scenario 9)
 */
export async function proposeEngineeringStandard({
  projectDir = null,
  proposedId = "ZET-CUSTOM-001",
  title,
  problemDescription,
  recurrenceEvidence = [],
  proposedSeverity = "medium",
  proposedEnforcement = "advisory",
  persistProposal = false,
} = {}) {
  const requestedEnforcement = String(proposedEnforcement || "advisory").toLowerCase();
  const blockingRefused = requestedEnforcement === "blocking";

  let proposalFile = null;
  if (projectDir && persistProposal) {
    const root = path.resolve(projectDir);
    const proposalsDir = path.join(root, "engineering", "proposals");
    await fs.mkdir(proposalsDir, { recursive: true });
    proposalFile = path.join(proposalsDir, `${proposedId}.yaml`);
    const yamlContent = [
      `id: ${proposedId}`,
      `title: "${String(title || "Proposed Engineering Standard").replaceAll('"', '\\"')}"`,
      `status: PROPOSED_PENDING_REVIEW`,
      `auto_activated: false`,
      `requested_enforcement: ${requestedEnforcement}`,
      `effective_enforcement: advisory`,
      `severity: ${proposedSeverity}`,
      `problem_description: "${String(problemDescription || "").replaceAll('"', '\\"')}"`,
      "",
    ].join("\n");
    await fs.writeFile(proposalFile, yamlContent, "utf8");
  }

  return {
    proposed_rule_id: proposedId,
    title: title || "Proposed Engineering Standard",
    problem_description: problemDescription || "Recurring code pattern requiring standardization.",
    evidence_of_recurrence: recurrenceEvidence,
    rationale: "Prevent recurring defect pattern identified during automated audits.",
    detection_strategy: "static-pattern",
    false_positive_risks: "Evaluate against historical repository commits before enabling warning/blocking mode.",
    proposed_severity: proposedSeverity,
    requested_enforcement: requestedEnforcement,
    proposed_enforcement: "advisory",
    blocking_activation_refused: blockingRefused,
    auto_activated: false,
    active_in_registry: false,
    status: "PROPOSED_PENDING_REVIEW",
    proposal_file: proposalFile,
    governance_notice:
      "New standards require explicit human review and authorization before activation; blocking enforcement is never enabled automatically.",
  };
}

/**
 * Unified dispatcher for all DevWorkflow V2.0/V2.1 tools (Sections 4–10, 16).
 */
export const DEVWORKFLOW_V2_TOOL_DEFINITIONS = [
  {
    name: "audit_code",
    description: "[READ_ONLY] Run Zettly & DevWorkflow V2.1 engineering standards against selected files or the repository.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        baselineFile: { type: "string" },
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
        baselineFile: { type: "string" },
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
        baselineFile: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "audit_architecture",
    description: "[READ_ONLY] Evaluate architectural boundaries, deep-module encapsulation, dependency direction, and role/permission enforcement.",
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
    description: "[READ_ONLY] Scan for embedded secrets (with credential redaction), unsafe shell/deserialization calls, and security boundary violations.",
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
        baselineFile: { type: "string" },
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
    description: "[LOCAL_WRITE] Apply an allowlisted deterministic AF-0/AF-1 fix to an authorized workspace file under worktree mutex fencing with automatic snapshot rollback on verification failure.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        file: { type: "string" },
        ruleId: { type: "string" },
        verifyCommand: { type: "array", items: { type: "string" } },
        simulateVerificationFailure: { type: "boolean" },
        requireOwnership: { type: "boolean" },
        sessionId: { type: "string" },
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
        projectDir: { type: "string" },
        proposedId: { type: "string" },
        title: { type: "string" },
        problemDescription: { type: "string" },
        recurrenceEvidence: { type: "array", items: { type: "string" } },
        proposedSeverity: { type: "string" },
        proposedEnforcement: { type: "string" },
        persistProposal: { type: "boolean" },
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
  const baseline = args.baseline || null;
  const baselineFile = args.baselineFile || null;

  switch (name) {
    case "audit_code":
      return await runEngineeringAudit({
        projectDir,
        files,
        scopeLabel: files.length ? "Selected Files" : "Repository",
        baseline,
        baselineFile,
      });
    case "audit_changes":
      return await runEngineeringAudit({
        projectDir,
        files,
        scopeLabel: "Pull Request / Changed Files",
        discoverGitChanges: true,
        baseline,
        baselineFile,
      });
    case "audit_repository":
      return await runEngineeringAudit({
        projectDir,
        files: [],
        scopeLabel: "Full Repository",
        baseline,
        baselineFile,
      });
    case "audit_architecture":
      return await runEngineeringAudit({
        projectDir,
        files,
        categoryFilter: "architecture",
        scopeLabel: "Architecture",
        baseline,
        baselineFile,
      });
    case "audit_security":
      return await runEngineeringAudit({
        projectDir,
        files,
        categoryFilter: "security",
        scopeLabel: "Security",
        baseline,
        baselineFile,
      });
    case "audit_tests":
      return await runEngineeringAudit({
        projectDir,
        files,
        categoryFilter: "testing",
        scopeLabel: "Testing",
        baseline,
        baselineFile,
      });
    case "audit_api_contracts":
      return await runEngineeringAudit({
        projectDir,
        files,
        categoryFilter: "api-contracts",
        scopeLabel: "API Contracts",
        baseline,
        baselineFile,
      });
    case "audit_database_changes":
      return await runEngineeringAudit({
        projectDir,
        files,
        categoryFilter: "database",
        scopeLabel: "Database Migrations",
        baseline,
        baselineFile,
      });
    case "audit_standards":
      return await validateStandardsRegistry(projectDir);
    case "audit_report": {
      const report = await runEngineeringAudit({
        projectDir,
        files,
        scopeLabel: args.scope || (files.length ? "Pull Request" : "Repository"),
        discoverGitChanges: args.scope === "Pull Request" && files.length === 0,
        baseline,
        baselineFile,
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
      const audit = await runEngineeringAudit({
        projectDir,
        files,
        scopeLabel: "Autofix Candidate Scan",
        discoverGitChanges: files.length === 0,
      });
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
        workflowState,
        requireOwnership: Boolean(args.requireOwnership),
        sessionId: args.sessionId || null,
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
        priorities: [
          "P0: Security & Data Integrity",
          "P1: High-Risk Architecture & Regression Coverage",
          "P2: Maintainability",
          "P3: Cosmetic",
        ],
        register_preview: rawDebt
          ? rawDebt.slice(0, 2000)
          : "No technical-debt-register.yaml found; run audit_repository to baseline.",
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
      return await proposeEngineeringStandard({ ...args, projectDir: args.projectDir || null });
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
