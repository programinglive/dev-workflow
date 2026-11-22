import fs from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
import {
  auditToolCatalog,
  generateConsolidationPlan,
  TOOL_ALIASES,
} from "./tool-catalog-auditor.js";
import {
  runCodeIndex,
  runCodeContext,
  runBugFixKnowledgeGate,
} from "./zettly-code-adapter.js";
import { evaluateReleaseDocsGate } from "./release-governance.js";

const execFileAsync = promisify(execFile);

export const STANDARDS_REGISTRY_VERSION = "3.1.0";
export const FINDING_FINGERPRINT_VERSION = "2.0";

const ALLOWED_VERIFY_BINARIES = new Set([
  "node",
  "npm",
  "npx",
  "php",
  "phpunit",
  "paratest",
  "pytest",
  "python",
  "python3",
  "git",
]);

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
 * Compute deterministic Finding Identity v2.0 fingerprint from ruleId, normalized file path,
 * and normalized evidence/source snippet (tolerate line movement while distinguishing distinct
 * violations in the same file).
 */
export function computeFindingFingerprint(ruleId, relFile, evidenceSnippet = "") {
  const normRule = String(ruleId || "").trim();
  const normFile = String(relFile || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .trim();
  // Strip volatile line-number phrases like "Line 12 has trailing whitespace" -> "has trailing whitespace"
  const normEvidence = redactSecretValues(String(evidenceSnippet || ""))
    .replace(/\b[Ll]ine\s+\d+\b/g, "line")
    .trim()
    .replace(/\s+/g, " ");
  return crypto
    .createHash("sha256")
    .update(`${normRule}::${normFile}::${normEvidence}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Analyze a source file for active PHP/JS debug statements (`dd`, `var_dump`) while:
 * 1. Ignoring occurrences inside comments (`//`, `#`, `/* ... * /`) or string literals.
 * 2. Distinguishing simple standalone statements (`dd($x);`) from behavior-sensitive
 *    complex occurrences (inline conditionals `if ($x) dd($x);`, braceless control-flow
 *    bodies, expressions `$a || dd($x);`, nested calls `dd(foo($x));`, or multiline calls).
 */
export function analyzeDebugStatementsInSource(content) {
  const lines = String(content || "").split(/\r?\n/);
  const hits = [];
  let inBlockComment = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    let codeOnly = "";
    let i = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    while (i < rawLine.length) {
      const ch = rawLine[i];
      const next = rawLine[i + 1] || "";

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }

      if (inSingleQuote) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === "'") inSingleQuote = false;
        i += 1;
        continue;
      }

      if (inDoubleQuote) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === '"') inDoubleQuote = false;
        i += 1;
        continue;
      }

      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if ((ch === "/" && next === "/") || ch === "#") {
        break;
      }
      if (ch === "'") {
        inSingleQuote = true;
        codeOnly += "''";
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = true;
        codeOnly += '""';
        i += 1;
        continue;
      }

      codeOnly += ch;
      i += 1;
    }

    if (!/\b(?:dd|var_dump)\s*\(/.test(codeOnly)) {
      continue;
    }

    // Check whether previous non-empty line is a braceless control structure (e.g. `if ($cond)`)
    let prevCodeLine = "";
    for (let p = idx - 1; p >= 0; p--) {
      const candidate = lines[p].trim();
      if (!candidate || candidate.startsWith("//") || candidate.startsWith("#") || candidate.startsWith("*")) {
        continue;
      }
      prevCodeLine = candidate;
      break;
    }
    const afterBracelessControl =
      /^(?:if|elseif|else\s+if|for|foreach|while)\s*\(.*\)\s*$/.test(prevCodeLine) ||
      /^else\s*$/.test(prevCodeLine);

    // Simple standalone statement: single line, no nested parens in args, no other statement on line
    const isSimpleStandaloneSyntax = /^\s*(?:dd|var_dump)\s*\([^()]*\)\s*;\s*$/.test(codeOnly);
    const isSimpleStandalone = isSimpleStandaloneSyntax && !afterBracelessControl;

    hits.push({
      line: idx + 1,
      rawLine: rawLine.trim().slice(0, 120),
      isSimpleStandalone,
      autofixEligible: isSimpleStandalone,
      autofixClass: isSimpleStandalone ? "AF-1" : "AF-2",
      semanticRisk: isSimpleStandalone
        ? "LOW_STANDALONE_DEBUG_STATEMENT"
        : "HIGH_CONTROL_FLOW_OR_EXPRESSION_EMBEDDED",
    });
  }

  return hits;
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
      exception_process:
        getField("exception_process") || "Record approved exception in engineering/exceptions/approved-exceptions.yaml.",
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
  const loadErrors = [];
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
    } catch (err) {
      loadErrors.push(`Failed reading standards directory: ${err.message}`);
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
    } catch (err) {
      loadErrors.push(`Failed reading approved-exceptions.yaml: ${err.message}`);
    }
  }

  return {
    projectDir: root,
    hasRegistryDir: existsSync(standardsDir),
    yamlFiles,
    standards: Array.from(loadedRules.values()),
    exceptions,
    loadErrors,
  };
}

function findMatchingApprovedException(exceptions, ruleId, relPath) {
  const norm = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
  const nowMs = Date.now();
  return (
    exceptions.find((e) => {
      if (e.rule_id !== ruleId || !e.file) return false;
      if (e.expires_at) {
        const exp = Date.parse(e.expires_at);
        if (Number.isFinite(exp) && exp < nowMs) return false;
      }
      return norm.endsWith(e.file.replaceAll("\\", "/"));
    }) || null
  );
}

function isValidGitRefToken(ref) {
  if (typeof ref !== "string" || !ref.trim()) return false;
  const trimmed = ref.trim();
  if (trimmed.startsWith("-")) return false;
  return /^[A-Za-z0-9._/@~^-]+$/.test(trimmed);
}

/**
 * Parse NUL-delimited `git status --porcelain=v1 -z -uall` output safely.
 * Handles spaces in paths, renames (`R`/`C` followed by origin path), and deletions (`D`).
 */
function parsePorcelainZ(stdout) {
  const tokens = String(stdout || "").split("\0");
  const changed = new Set();
  const deleted = new Set();
  const renamed = [];

  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const targetPath = entry.slice(3).replaceAll("\\", "/");

    if (x === "R" || y === "R" || x === "C" || y === "C") {
      const origPath = (tokens[i + 1] || "").replaceAll("\\", "/");
      i += 1;
      if (x === "R" || y === "R") {
        renamed.push({ from: origPath, to: targetPath });
      }
      if (targetPath) changed.add(targetPath);
    } else if (x === "D" || y === "D") {
      if (targetPath) deleted.add(targetPath);
    } else if (targetPath) {
      changed.add(targetPath);
    }
  }

  for (const d of deleted) {
    changed.delete(d);
  }

  return {
    changed_files: Array.from(changed),
    deleted_files: Array.from(deleted),
    renamed_files: renamed,
  };
}

/**
 * Parse NUL-delimited `git diff --name-status -z -M` output safely.
 */
function parseDiffNameStatusZ(stdout) {
  const tokens = String(stdout || "").split("\0").filter((t) => t.length > 0);
  const changed = new Set();
  const deleted = new Set();
  const renamed = [];

  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    const code = status[0];
    if (code === "R" || code === "C") {
      const fromPath = (tokens[i + 1] || "").replaceAll("\\", "/");
      const toPath = (tokens[i + 2] || "").replaceAll("\\", "/");
      i += 3;
      if (code === "R") {
        renamed.push({ from: fromPath, to: toPath, similarity: status.slice(1) || "100" });
      }
      if (toPath) changed.add(toPath);
    } else if (code === "D") {
      const delPath = (tokens[i + 1] || "").replaceAll("\\", "/");
      i += 2;
      if (delPath) deleted.add(delPath);
    } else if (code === "A" || code === "M" || code === "T") {
      const modPath = (tokens[i + 1] || "").replaceAll("\\", "/");
      i += 2;
      if (modPath) changed.add(modPath);
    } else {
      i += 1;
    }
  }

  for (const d of deleted) {
    changed.delete(d);
  }

  return {
    changed_files: Array.from(changed),
    deleted_files: Array.from(deleted),
    renamed_files: renamed,
  };
}

async function resolveGitHeadRevision(root) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      timeout: 3000,
      windowsHide: true,
    });
    return String(stdout || "").trim() || null;
  } catch {
    return null;
  }
}

async function verifyGitCommitRef(root, ref) {
  if (!isValidGitRefToken(ref)) return null;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: root,
      timeout: 3000,
      windowsHide: true,
    });
    return String(stdout || "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Multi-Mode Git Change Scope Resolver (CRITICAL FINDING A — AR-01..AR-04, AR-18).
 *
 * Supports:
 * - "working_tree": uncommitted modified, staged, and untracked files
 * - "staged": staged index changes (`git diff --cached`)
 * - "commit_range": explicit `baseRef..headRef` or `commitRange`
 * - "pr": pull request merge-base diff (`git merge-base <baseRef> <headRef>` .. `<headRef>`) + working tree
 * - "auto": working tree changes if dirty; otherwise falls back to PR/branch diff against baseRef / main / HEAD~1
 */
export async function resolveGitChangeScope(
  root,
  {
    changeMode = "auto",
    baseRef = null,
    headRef = "HEAD",
    commitRange = null,
  } = {}
) {
  const mode = String(changeMode || "auto").toLowerCase();
  const effectiveHeadRef = headRef || "HEAD";

  let effectiveBaseRef = baseRef || null;
  if (!effectiveBaseRef && commitRange && typeof commitRange === "string") {
    const parts = commitRange.split(/\.\.\.?/);
    if (parts.length === 2 && parts[0] && parts[1]) {
      effectiveBaseRef = parts[0].trim();
    } else {
      return {
        ok: false,
        mode,
        error: "INVALID_COMMIT_RANGE",
        message: `Invalid commitRange '${commitRange}'. Expected '<base>..<head>'.`,
      };
    }
  }

  // If explicit baseRef or headRef is supplied, validate format against option injection
  if (effectiveBaseRef && !isValidGitRefToken(effectiveBaseRef)) {
    return {
      ok: false,
      mode,
      error: "INVALID_GIT_BASE_REF",
      message: `Invalid Git base reference '${effectiveBaseRef}'.`,
      base_ref: effectiveBaseRef,
      head_ref: effectiveHeadRef,
    };
  }
  if (!isValidGitRefToken(effectiveHeadRef)) {
    return {
      ok: false,
      mode,
      error: "INVALID_GIT_HEAD_REF",
      message: `Invalid Git head reference '${effectiveHeadRef}'.`,
      base_ref: effectiveBaseRef,
      head_ref: effectiveHeadRef,
    };
  }

  // 1. Staged mode
  if (mode === "staged") {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--name-status", "-z", "-M", "--cached"], {
        cwd: root,
        timeout: 5000,
        windowsHide: true,
      });
      const parsed = parseDiffNameStatusZ(stdout);
      return {
        ok: true,
        mode: "staged",
        base_ref: "INDEX",
        head_ref: "STAGED",
        merge_base: null,
        ...parsed,
      };
    } catch (err) {
      return {
        ok: false,
        mode: "staged",
        error: "GIT_STAGED_DIFF_FAILED",
        message: `Failed reading staged changes: ${err.message}`,
      };
    }
  }

  // 2. Working tree inspection
  let workingTree = { changed_files: [], deleted_files: [], renamed_files: [] };
  let gitAvailable = true;
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "-uall"], {
      cwd: root,
      timeout: 5000,
      windowsHide: true,
    });
    workingTree = parsePorcelainZ(stdout);
  } catch (err) {
    gitAvailable = false;
    if (mode === "working_tree" || mode === "pr" || mode === "commit_range" || effectiveBaseRef) {
      return {
        ok: false,
        mode,
        error: "GIT_REPOSITORY_UNAVAILABLE",
        message: `Git status failed in '${root}': ${err.message}`,
      };
    }
  }

  if (mode === "working_tree") {
    return {
      ok: true,
      mode: "working_tree",
      base_ref: "HEAD",
      head_ref: "WORKTREE",
      merge_base: null,
      ...workingTree,
    };
  }

  // 3. Explicit PR / Commit-Range comparison (or when baseRef is explicitly provided)
  if (mode === "pr" || mode === "commit_range" || effectiveBaseRef) {
    const targetBase =
      effectiveBaseRef ||
      process.env.GITHUB_BASE_REF ||
      process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ||
      null;

    if (!targetBase) {
      return {
        ok: false,
        mode: mode === "auto" ? "pr" : mode,
        error: "MISSING_GIT_BASE_REF",
        message: "PR / commit-range audit requires a valid baseRef (or GITHUB_BASE_REF).",
        base_ref: null,
        head_ref: effectiveHeadRef,
      };
    }

    let resolvedBaseSha = await verifyGitCommitRef(root, targetBase);
    if (!resolvedBaseSha && !targetBase.startsWith("origin/")) {
      resolvedBaseSha = await verifyGitCommitRef(root, `origin/${targetBase}`);
    }
    const resolvedHeadSha = await verifyGitCommitRef(root, effectiveHeadRef);

    if (!resolvedBaseSha || !resolvedHeadSha) {
      return {
        ok: false,
        mode: mode === "auto" ? "pr" : mode,
        error: "MISSING_GIT_BASE_REF",
        message: `Cannot resolve Git comparison references (base='${targetBase}' [${resolvedBaseSha || "MISSING"}], head='${effectiveHeadRef}' [${resolvedHeadSha || "MISSING"}]).`,
        base_ref: targetBase,
        head_ref: effectiveHeadRef,
      };
    }

    let mergeBaseSha = resolvedBaseSha;
    try {
      const { stdout: mbOut } = await execFileAsync("git", ["merge-base", resolvedBaseSha, resolvedHeadSha], {
        cwd: root,
        timeout: 5000,
        windowsHide: true,
      });
      mergeBaseSha = String(mbOut || "").trim() || resolvedBaseSha;
    } catch (err) {
      return {
        ok: false,
        mode: mode === "auto" ? "pr" : mode,
        error: "MERGE_BASE_UNRESOLVABLE",
        message: `Could not compute Git merge-base between '${targetBase}' and '${effectiveHeadRef}' (possible shallow clone): ${err.message}`,
        base_ref: targetBase,
        head_ref: effectiveHeadRef,
      };
    }

    try {
      const { stdout: diffOut } = await execFileAsync(
        "git",
        ["diff", "--name-status", "-z", "-M", `${mergeBaseSha}..${resolvedHeadSha}`],
        { cwd: root, timeout: 5000, windowsHide: true }
      );
      const prDiff = parseDiffNameStatusZ(diffOut);
      const mergedChanged = new Set([...prDiff.changed_files, ...workingTree.changed_files]);
      const mergedDeleted = new Set([...prDiff.deleted_files, ...workingTree.deleted_files]);
      for (const d of mergedDeleted) mergedChanged.delete(d);

      return {
        ok: true,
        mode: mode === "commit_range" ? "commit_range" : "pr",
        base_ref: targetBase,
        head_ref: effectiveHeadRef,
        merge_base: mergeBaseSha,
        changed_files: Array.from(mergedChanged),
        deleted_files: Array.from(mergedDeleted),
        renamed_files: [...prDiff.renamed_files, ...workingTree.renamed_files],
      };
    } catch (err) {
      return {
        ok: false,
        mode: mode === "auto" ? "pr" : mode,
        error: "GIT_DIFF_EXECUTION_FAILED",
        message: `Git diff failed for '${mergeBaseSha}..${resolvedHeadSha}': ${err.message}`,
        base_ref: targetBase,
        head_ref: effectiveHeadRef,
      };
    }
  }

  // 4. Auto mode: if working tree has changes/deletions/renames, use working tree.
  //    If working tree is clean (e.g., clean CI checkout or committed PR branch — AR-01 & AR-02),
  //    compare against main/master merge-base (if on a feature branch) or HEAD~1!
  if (
    workingTree.changed_files.length > 0 ||
    workingTree.deleted_files.length > 0 ||
    workingTree.renamed_files.length > 0
  ) {
    return {
      ok: true,
      mode: "working_tree",
      base_ref: "HEAD",
      head_ref: "WORKTREE",
      merge_base: null,
      ...workingTree,
    };
  }

  if (gitAvailable) {
    const headSha = await verifyGitCommitRef(root, "HEAD");
    for (const candidateBase of ["origin/main", "main", "origin/master", "master"]) {
      const baseSha = await verifyGitCommitRef(root, candidateBase);
      if (baseSha && headSha && baseSha !== headSha) {
        try {
          const { stdout: mbOut } = await execFileAsync("git", ["merge-base", baseSha, headSha], {
            cwd: root,
            timeout: 3000,
            windowsHide: true,
          });
          const mb = String(mbOut || "").trim();
          if (mb && mb !== headSha) {
            const { stdout: diffOut } = await execFileAsync(
              "git",
              ["diff", "--name-status", "-z", "-M", `${mb}..${headSha}`],
              { cwd: root, timeout: 5000, windowsHide: true }
            );
            return {
              ok: true,
              mode: "pr",
              base_ref: candidateBase,
              head_ref: "HEAD",
              merge_base: mb,
              ...parseDiffNameStatusZ(diffOut),
            };
          }
        } catch {
          // try next fallback
        }
      }
    }

    // Clean commit directly on main/master: diff against HEAD~1 if parent commit exists
    const parentSha = await verifyGitCommitRef(root, "HEAD~1");
    if (parentSha && headSha) {
      try {
        const { stdout: diffOut } = await execFileAsync(
          "git",
          ["diff", "--name-status", "-z", "-M", `${parentSha}..${headSha}`],
          { cwd: root, timeout: 5000, windowsHide: true }
        );
        return {
          ok: true,
          mode: "commit_range",
          base_ref: "HEAD~1",
          head_ref: "HEAD",
          merge_base: parentSha,
          ...parseDiffNameStatusZ(diffOut),
        };
      } catch {
        // fallback below
      }
    }
  }

  return {
    ok: true,
    mode: "working_tree",
    base_ref: "HEAD",
    head_ref: "WORKTREE",
    merge_base: null,
    changed_files: [],
    deleted_files: [],
    renamed_files: [],
  };
}

/**
 * Backward-compatible helper returning discovered changed files array.
 */
export async function discoverGitChangedFiles(root, options = {}) {
  const scope = await resolveGitChangeScope(root, options);
  return scope.ok ? scope.changed_files : [];
}

/**
 * Bounded Repository & File Scanner with Coverage Telemetry & Symlink/Traversal Safety
 * (FINDING D — AR-11, AR-12).
 */
async function collectAuditFiles(
  root,
  targetPaths = [],
  { maxFiles = 1000, maxDepth = 12, explicitFilesProvided = false } = {}
) {
  const effectiveMaxFiles = Math.max(1, Math.min(5000, Number(maxFiles) || 1000));
  const effectiveMaxDepth = Math.max(1, Math.min(32, Number(maxDepth) || 12));
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));

  const results = [];
  let filesDiscovered = 0;
  let filesExcluded = 0;
  let filesSkipped = 0;
  let directoriesSkipped = 0;
  let symlinksSkipped = 0;
  let unscannedFilesCount = 0;
  let limitReached = false;
  let limitReason = null;
  const scannerErrors = [];

  const skipDirs = new Set([
    ".git",
    "node_modules",
    "vendor",
    "public",
    "storage",
    "dist",
    "build",
    ".state",
    ".worktrees",
  ]);

  const isInsideRealRoot = (candidateRealPath) => {
    const rel = path.relative(realRoot, candidateRealPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  if (explicitFilesProvided) {
    for (const rel of targetPaths) {
      const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel);
      try {
        const lst = lstatSync(abs);
        if (lst.isSymbolicLink()) {
          symlinksSkipped += 1;
          const targetReal = await fs.realpath(abs).catch(() => null);
          if (!targetReal || !isInsideRealRoot(targetReal)) {
            filesExcluded += 1;
            scannerErrors.push({
              code: "SYMLINK_OUTSIDE_WORKSPACE",
              file: String(rel),
              message: `Refused symlink pointing outside workspace root: '${rel}'`,
            });
            continue;
          }
        }
        const realAbs = await fs.realpath(abs).catch(() => abs);
        if (!isInsideRealRoot(realAbs)) {
          filesExcluded += 1;
          scannerErrors.push({
            code: "PATH_OUTSIDE_WORKSPACE",
            file: String(rel),
            message: `Refused file outside authorized workspace root: '${rel}'`,
          });
          continue;
        }
        const st = await fs.stat(abs);
        if (!st.isFile()) continue;
        filesDiscovered += 1;
        if (st.size > 512 * 1024) {
          filesSkipped += 1;
          continue;
        }
        if (results.length >= effectiveMaxFiles) {
          limitReached = true;
          limitReason = "MAX_FILES_REACHED";
          unscannedFilesCount += 1;
          continue;
        }
        results.push(path.relative(root, abs).replaceAll("\\", "/"));
      } catch {
        filesSkipped += 1;
      }
    }

    const coverageStatus = limitReached ? "PARTIAL" : "COMPLETE";
    return {
      files: results,
      coverage: {
        status: coverageStatus,
        files_discovered: filesDiscovered,
        files_scanned: results.length,
        files_excluded: filesExcluded,
        files_skipped: filesSkipped,
        directories_skipped: directoriesSkipped,
        symlinks_skipped: symlinksSkipped,
        limit_reached: limitReached,
        limit_reason: limitReason,
        unscanned_files_count: unscannedFilesCount,
        max_files: effectiveMaxFiles,
        max_depth: effectiveMaxDepth,
        scanner_errors: scannerErrors,
      },
    };
  }

  const visitedRealDirs = new Set([realRoot]);

  async function walk(current, depth = 0) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      scannerErrors.push({
        code: "DIRECTORY_READ_ERROR",
        path: path.relative(root, current).replaceAll("\\", "/"),
        message: err.message,
      });
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isSymbolicLink()) {
        symlinksSkipped += 1;
        directoriesSkipped += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          directoriesSkipped += 1;
          continue;
        }
        if (depth + 1 > effectiveMaxDepth) {
          limitReached = true;
          if (!limitReason) limitReason = "MAX_DEPTH_REACHED";
          directoriesSkipped += 1;
          continue;
        }
        const realDir = await fs.realpath(full).catch(() => null);
        if (!realDir || !isInsideRealRoot(realDir) || visitedRealDirs.has(realDir)) {
          directoriesSkipped += 1;
          continue;
        }
        visitedRealDirs.add(realDir);
        await walk(full, depth + 1);
      } else if (
        /\.(?:php|js|mjs|cjs|jsx|ts|tsx|py|yaml|yml)$/i.test(entry.name) &&
        !entry.name.endsWith(".min.js")
      ) {
        try {
          const st = await fs.stat(full);
          if (st.size > 512 * 1024) {
            filesSkipped += 1;
            continue;
          }
          filesDiscovered += 1;
          if (results.length >= effectiveMaxFiles) {
            limitReached = true;
            if (!limitReason) limitReason = "MAX_FILES_REACHED";
            unscannedFilesCount += 1;
            continue;
          }
          results.push(path.relative(root, full).replaceAll("\\", "/"));
        } catch {
          filesSkipped += 1;
        }
      } else {
        filesExcluded += 1;
      }
    }
  }

  await walk(root, 0);

  const coverageStatus = limitReached ? "PARTIAL" : "COMPLETE";
  return {
    files: results,
    coverage: {
      status: coverageStatus,
      files_discovered: filesDiscovered,
      files_scanned: results.length,
      files_excluded: filesExcluded,
      files_skipped: filesSkipped,
      directories_skipped: directoriesSkipped,
      symlinks_skipped: symlinksSkipped,
      limit_reached: limitReached,
      limit_reason: limitReason,
      unscanned_files_count: unscannedFilesCount,
      max_files: effectiveMaxFiles,
      max_depth: effectiveMaxDepth,
      scanner_errors: scannerErrors,
    },
  };
}

async function loadAuditBaseline(root, { baseline = null, baselineFile = null } = {}) {
  if (Array.isArray(baseline)) {
    return { active: true, items: baseline, error: null };
  }
  if (baseline && Array.isArray(baseline.findings)) {
    return { active: true, items: baseline.findings, error: null };
  }
  const explicitRequested = Boolean(baselineFile);
  const candidateFile = baselineFile
    ? path.isAbsolute(baselineFile)
      ? baselineFile
      : path.join(root, baselineFile)
    : path.join(root, "engineering", "reports", "audit-baseline.json");

  if (existsSync(candidateFile)) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidateFile, "utf8"));
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : null;
      if (!items) {
        return {
          active: false,
          items: [],
          error: {
            code: "INVALID_BASELINE_SCHEMA",
            file: candidateFile,
            message: `Baseline file '${candidateFile}' does not contain a valid findings array.`,
          },
        };
      }
      return { active: true, items, error: null, file: candidateFile };
    } catch (err) {
      return {
        active: false,
        items: [],
        error: {
          code: "CORRUPTED_BASELINE_FILE",
          file: candidateFile,
          message: `Failed parsing baseline JSON '${candidateFile}': ${err.message}`,
        },
      };
    }
  } else if (explicitRequested) {
    return {
      active: false,
      items: [],
      error: {
        code: "MISSING_BASELINE_FILE",
        file: candidateFile,
        message: `Requested baselineFile '${candidateFile}' does not exist.`,
      },
    };
  }
  return { active: false, items: [], error: null };
}

/**
 * Match current findings against baseline items using Finding Identity v2.0:
 * - Multiplicity-aware matching by `(rule_id, file, evidence_fingerprint)` (AR-05, AR-06, AR-07).
 * - Safe fallback for legacy v1 baseline items (`{ rule_id, file, line }` without `evidence_fingerprint`):
 *   consumes at most 1 entry per legacy baseline item (exact line match first; single unambiguous shifted
 *   finding in file second; ambiguous multi-violation files default conservatively to "new").
 */
function classifyFindingsAgainstBaseline(rawFindings, baselineData, renamedFiles = []) {
  if (!baselineData.active) {
    return rawFindings.map((f) => ({
      ...f,
      is_new: true,
      baseline_status: "new",
    }));
  }

  // Map renamed target paths back to their pre-rename baseline paths if needed
  const renameToFrom = new Map();
  for (const r of renamedFiles || []) {
    if (r.to && r.from) {
      renameToFrom.set(r.to.replaceAll("\\", "/"), r.from.replaceAll("\\", "/"));
    }
  }

  // 1. Separate v2 fingerprinted baseline items from legacy v1 line-only items
  const v2FpCounts = new Map();
  const v1ItemsByRuleFile = new Map();

  for (const item of baselineData.items) {
    if (!item || !item.rule_id || !item.file) continue;
    const normFile = String(item.file).replaceAll("\\", "/").replace(/^\.\//, "");
    const itemFp =
      item.evidence_fingerprint ||
      (item.evidence ? computeFindingFingerprint(item.rule_id, normFile, item.evidence) : null);

    if (itemFp) {
      const key = `${item.rule_id}::${normFile}::${itemFp}`;
      v2FpCounts.set(key, (v2FpCounts.get(key) || 0) + 1);
    } else {
      const rfKey = `${item.rule_id}::${normFile}`;
      if (!v1ItemsByRuleFile.has(rfKey)) v1ItemsByRuleFile.set(rfKey, []);
      v1ItemsByRuleFile.get(rfKey).push({ line: Number(item.line) || 1, consumed: false });
    }
  }

  // Count how many findings per (rule_id, file) exist in the current scan (for v1 ambiguity checks)
  const currentCountsByRuleFile = new Map();
  for (const f of rawFindings) {
    const normFile = f.file.replaceAll("\\", "/");
    const rfKey = `${f.rule_id}::${normFile}`;
    currentCountsByRuleFile.set(rfKey, (currentCountsByRuleFile.get(rfKey) || 0) + 1);
  }

  // First pass: match v2 fingerprinted items and exact-line v1 items
  const results = rawFindings.map((f) => ({ ...f, _matched: false, _uncertainty: false }));

  for (const f of results) {
    if (f.rule_id === "ZET-SEC-001") continue; // Critical secret leaks are never suppressed as historical
    const normFile = f.file.replaceAll("\\", "/");
    const candidateFiles = [normFile];
    if (renameToFrom.has(normFile)) {
      candidateFiles.push(renameToFrom.get(normFile));
    }

    // Try v2 fingerprint match (supports line movement & exact multiplicity!)
    let matchedV2 = false;
    for (const cf of candidateFiles) {
      const fp = computeFindingFingerprint(f.rule_id, cf, f.evidence);
      const fpKey = `${f.rule_id}::${cf}::${fp}`;
      const count = v2FpCounts.get(fpKey) || 0;
      if (count > 0) {
        v2FpCounts.set(fpKey, count - 1);
        f._matched = true;
        matchedV2 = true;
        break;
      }
    }
    if (matchedV2) continue;

    // Try exact-line match against unconsumed v1 legacy items
    for (const cf of candidateFiles) {
      const rfKey = `${f.rule_id}::${cf}`;
      const v1List = v1ItemsByRuleFile.get(rfKey);
      if (!v1List) continue;
      const exactEntry = v1List.find((e) => !e.consumed && e.line === f.line);
      if (exactEntry) {
        exactEntry.consumed = true;
        f._matched = true;
        break;
      }
    }
  }

  // Second pass: for remaining unmatched findings, allow line-moved v1 fallback ONLY when
  // there is an unambiguous 1-to-1 correspondence in that file (single finding in file & single unconsumed v1 entry).
  for (const f of results) {
    if (f._matched || f.rule_id === "ZET-SEC-001") continue;
    const normFile = f.file.replaceAll("\\", "/");
    const candidateFiles = [normFile];
    if (renameToFrom.has(normFile)) candidateFiles.push(renameToFrom.get(normFile));

    for (const cf of candidateFiles) {
      const rfKey = `${f.rule_id}::${cf}`;
      const v1List = v1ItemsByRuleFile.get(rfKey);
      if (!v1List) continue;
      const unconsumed = v1List.filter((e) => !e.consumed);
      const totalCurrentInFile = currentCountsByRuleFile.get(`${f.rule_id}::${normFile}`) || 0;
      if (unconsumed.length === 1 && totalCurrentInFile === 1) {
        unconsumed[0].consumed = true;
        f._matched = true;
        break;
      } else if (unconsumed.length > 0 && totalCurrentInFile > 1) {
        // Ambiguous legacy v1 baseline without evidence_fingerprint when multiple violations exist in same file:
        // conservatively classify as NEW and flag uncertainty (Section 3).
        f._uncertainty = true;
      }
    }
  }

  return results.map(({ _matched, _uncertainty, ...rest }) => ({
    ...rest,
    is_new: !_matched,
    baseline_status: _matched ? "historical" : "new",
    ...(_uncertainty ? { baseline_uncertainty: true } : {}),
  }));
}

/**
 * Core Automatic Code Audit Engine (Sections 2–8, 15)
 */
export async function runEngineeringAudit({
  projectDir,
  files = [],
  categoryFilter = null,
  scopeLabel = "Repository",
  discoverGitChanges = false,
  changeMode = null,
  baseRef = null,
  headRef = "HEAD",
  commitRange = null,
  baseline = null,
  baselineFile = null,
  maxFiles = 1000,
  maxDepth = 12,
} = {}) {
  const loaded = await loadProjectStandards(projectDir);
  const root = loaded.projectDir;
  const repoRevision = await resolveGitHeadRevision(root);

  const explicitFilesProvided = Array.isArray(files) && files.length > 0;
  let effectiveFiles = explicitFilesProvided ? [...files] : [];
  let gitScopeMeta = {
    ok: true,
    mode: explicitFilesProvided ? "explicit_files" : "repository",
    base_ref: null,
    head_ref: null,
    merge_base: null,
    changed_files: effectiveFiles,
    deleted_files: [],
    renamed_files: [],
  };

  const shouldResolveGitDiff =
    !explicitFilesProvided &&
    (discoverGitChanges || Boolean(changeMode) || Boolean(baseRef) || Boolean(commitRange));

  if (shouldResolveGitDiff) {
    gitScopeMeta = await resolveGitChangeScope(root, {
      changeMode: changeMode || "auto",
      baseRef,
      headRef,
      commitRange,
    });

    if (!gitScopeMeta.ok) {
      // CRITICAL FINDING A (AR-04): Never report PASS when requested PR/diff comparison failed!
      return sanitize({
        repository: path.basename(root),
        project_dir: root,
        repository_revision: repoRevision,
        standards_version: STANDARDS_REGISTRY_VERSION,
        requested_scope: scopeLabel,
        audit_mode: gitScopeMeta.mode || changeMode || "pr",
        resolved_scope: {
          mode: gitScopeMeta.mode || changeMode || "pr",
          base_ref: gitScopeMeta.base_ref || baseRef || null,
          head_ref: gitScopeMeta.head_ref || headRef || "HEAD",
          merge_base: null,
          files_discovered: 0,
          files_scanned: 0,
          changed_files: [],
          renamed_files: [],
          deleted_files: [],
        },
        detection_status: "FAILED",
        coverage_status: "FAILED",
        policy_status: "UNKNOWN",
        overall_verdict: "INCOMPLETE",
        scan_completeness: "FAILED",
        scope: scopeLabel,
        files_audited: 0,
        standards_loaded: loaded.standards.length,
        baseline_active: false,
        result: "FAIL",
        quality_gate: "FAILED",
        errors: [
          {
            code: gitScopeMeta.error || "GIT_SCOPE_RESOLUTION_FAILED",
            message: gitScopeMeta.message || "Could not resolve requested Git comparison scope.",
          },
        ],
        warnings: [],
        summary: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          new_violations: 0,
          historical_debt: 0,
          safe_autofix_candidates: 0,
          manual_review_required: 0,
        },
        findings: [],
        new_findings: [],
        historical_findings: [],
      });
    }

    effectiveFiles = gitScopeMeta.changed_files;
  }

  const isScopedAudit = explicitFilesProvided || shouldResolveGitDiff;
  const collected =
    shouldResolveGitDiff && effectiveFiles.length === 0
      ? {
          files: [],
          coverage: {
            status: "COMPLETE",
            files_discovered: 0,
            files_scanned: 0,
            files_excluded: 0,
            files_skipped: 0,
            directories_skipped: 0,
            symlinks_skipped: 0,
            limit_reached: false,
            limit_reason: null,
            unscanned_files_count: 0,
            max_files: maxFiles,
            max_depth: maxDepth,
            scanner_errors: [],
          },
        }
      : await collectAuditFiles(root, effectiveFiles, {
          maxFiles,
          maxDepth,
          explicitFilesProvided: isScopedAudit,
        });

  const targetFiles = collected.files;
  const rawFindings = [];
  const seenFindingKeys = new Set();
  const occurrenceCounters = new Map();
  const appliedExceptions = [];

  const recordAppliedException = (exc, relPath) => {
    if (!exc) return;
    if (!appliedExceptions.some((a) => a.id === exc.id && a.file === relPath)) {
      appliedExceptions.push({ id: exc.id, rule_id: exc.rule_id, file: relPath, reason: exc.reason });
    }
  };

  const pushFinding = (finding) => {
    const key = `${finding.rule_id}::${finding.file}::${finding.line || 1}`;
    if (seenFindingKeys.has(key)) return;
    seenFindingKeys.add(key);

    const redactedEvidence = redactSecretValues(String(finding.evidence || ""));
    const fp = computeFindingFingerprint(finding.rule_id, finding.file, redactedEvidence);
    const occKey = `${finding.rule_id}::${finding.file}::${fp}`;
    const occIdx = (occurrenceCounters.get(occKey) || 0) + 1;
    occurrenceCounters.set(occKey, occIdx);

    rawFindings.push({
      ...finding,
      evidence: redactedEvidence,
      evidence_fingerprint: fp,
      fingerprint_version: FINDING_FINGERPRINT_VERSION,
      occurrence_index: occIdx,
      finding_id: `${finding.rule_id}:${finding.file}:${fp}#${occIdx}`,
      detection_type: finding.detection_type || "deterministic",
    });
  };

  const applicableStandards = categoryFilter
    ? loaded.standards.filter((s) => s.category === categoryFilter)
    : loaded.standards;

  const hasTestChange = targetFiles.some(
    (f) => /(?:^|\/)tests?\//i.test(f) || /(?:\.test|_test|Test)\.(?:js|ts|php|py)$/i.test(f)
  );

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

    // Skip binary files containing NUL bytes
    if (content.includes("\0")) {
      collected.coverage.files_skipped += 1;
      continue;
    }

    const isTestFile = /(?:^|\/)tests?\//i.test(relPath) || /(?:\.test|_test|Test)\.(?:js|ts|php|py)$/i.test(relPath);
    const isMigrationFile = /database\/migrations\/.*\.php$/i.test(relPath);
    const isControllerOrViewFile =
      /app\/Http\/Controllers\/.*\.php$/i.test(relPath) ||
      /resources\/js\/(?:Pages|Components)\/.*\.(?:jsx|tsx|js|ts)$/i.test(relPath);
    const lines = content.split(/\r?\n/);

    // 1. Secret scanning (ZET-SEC-001) with line-accurate detection & full credential redaction
    if ((!categoryFilter || categoryFilter === "security") && !isTestFile) {
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
      const exc = findMatchingApprovedException(loaded.exceptions, "ZET-SEC-001", relPath);
      if (secretHits.length > 0 || hasEmbeddedToken) {
        if (exc) {
          recordAppliedException(exc, relPath);
        } else {
          pushFinding({
            rule_id: "ZET-SEC-001",
            title: "No embedded credentials, private keys, or live tokens",
            category: "security",
            severity: "critical",
            enforcement: "blocking",
            file: relPath,
            line: secretLine,
            evidence: `Detected embedded secret pattern (${secretHits.map((h) => h.type).join(", ") || "token_pattern"}) [<REDACTED_SECRET>]`,
            autofix_eligible: false,
            autofix_class: "AF-3",
            recommended_fix:
              "Remove embedded secret immediately, rotate credential, and load from environment or Secret Manager.",
          });
        }
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

    // 3. Leftover debug dumps in non-test code (ZET-CODE-001 — comment/string-safe & semantic risk classification, FINDING E)
    if ((!categoryFilter || categoryFilter === "code-quality") && !isTestFile && !/\.(?:yaml|yml)$/i.test(relPath)) {
      const exc = findMatchingApprovedException(loaded.exceptions, "ZET-CODE-001", relPath);
      const debugHits = analyzeDebugStatementsInSource(content);
      if (debugHits.length > 0 && exc) {
        recordAppliedException(exc, relPath);
      } else {
        for (const hit of debugHits) {
          pushFinding({
            rule_id: "ZET-CODE-001",
            title: "Avoid leftover debug dump statements in production code",
            category: "code-quality",
            severity: "medium",
            enforcement: "warning",
            file: relPath,
            line: hit.line,
            evidence: hit.rawLine,
            autofix_eligible: hit.autofixEligible,
            autofix_class: hit.autofixClass,
            semantic_risk: hit.semanticRisk,
            recommended_fix: hit.autofixEligible
              ? "Remove standalone debug dump statement or use helper_apply_safe_fix (AF-1)."
              : "Manual review required (AF-2 proposal-only): debug call is embedded in control flow or expression.",
          });
        }
      }
    }

    // 4. Destructive migration operations in up() method (ZET-DB-001)
    if ((!categoryFilter || categoryFilter === "database") && isMigrationFile) {
      const upSection = content.split(/public\s+function\s+down\s*\(/i)[0] || content;
      if (/\b(?:dropColumn|dropIfExists|dropTable)\s*\(/.test(upSection)) {
        const exc = findMatchingApprovedException(loaded.exceptions, "ZET-DB-001", relPath);
        if (exc) {
          recordAppliedException(exc, relPath);
        } else {
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
    }

    // 5. Architecture boundary check: raw DB query in Controller/View (ZET-ARCH-001)
    if ((!categoryFilter || categoryFilter === "architecture") && isControllerOrViewFile) {
      if (/\bDB::raw\s*\(/.test(content)) {
        const exc = findMatchingApprovedException(loaded.exceptions, "ZET-ARCH-001", relPath);
        if (exc) {
          recordAppliedException(exc, relPath);
        } else {
          for (let idx = 0; idx < lines.length; idx++) {
            if (/\bDB::raw\s*\(/.test(lines[idx])) {
              pushFinding({
                rule_id: "ZET-ARCH-001",
                title: "Controller embeds raw SQL instead of delegating to a deep Service/Domain module",
                category: "architecture",
                severity: "medium",
                enforcement: "advisory",
                file: relPath,
                line: idx + 1,
                evidence: lines[idx].trim().slice(0, 120),
                autofix_eligible: false,
                autofix_class: "AF-2",
                recommended_fix: "Extract raw query logic into an App\\Services or App\\Domain class.",
              });
            }
          }
        }
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
        const isDefaultArch001 =
          rule.id === "ZET-ARCH-001" &&
          (rule.pattern === "\\b(?:DB::raw|mysqli_query)\\s*\\(" || rule.pattern === "DB::raw\\(|mysqli_query\\(");
        if (specializedRuleIds.has(rule.id) && (rule.id !== "ZET-ARCH-001" || isDefaultArch001)) {
          continue;
        }
        const exc = findMatchingApprovedException(loaded.exceptions, rule.id, relPath);
        if (exc) {
          recordAppliedException(exc, relPath);
          continue;
        }

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
          }
        }
      }
    }
  }

  // Baseline comparison (CRITICAL FINDING B — AR-05, AR-06, AR-07)
  const baselineData = await loadAuditBaseline(root, { baseline, baselineFile });
  const warnings = [];
  const errors = (collected.coverage.scanner_errors || []).map((e) => ({ ...e }));
  if (baselineData.error) {
    warnings.push(baselineData.error);
  }
  for (const le of loaded.loadErrors || []) {
    warnings.push({ code: "STANDARDS_LOAD_WARNING", message: le });
  }

  const findings = classifyFindingsAgainstBaseline(rawFindings, baselineData, gitScopeMeta.renamed_files);
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

  const gatingFindings = baselineData.active ? newFindings : findings;
  const hasBlockingFailure = gatingFindings.some(
    (f) => f.enforcement === "blocking" && (f.severity === "critical" || f.severity === "high")
  );

  // Formal 4-Dimension Audit Reliability Contract (Section 7 & FINDING D — AR-11)
  const detectionStatus = "COMPLETED";
  const coverageStatus = collected.coverage.status; // "COMPLETE" | "PARTIAL"
  const policyStatus = hasBlockingFailure
    ? "NON_COMPLIANT"
    : findings.length > 0
      ? "WARNING"
      : "COMPLIANT";

  let overallVerdict;
  let qualityGate;
  if (hasBlockingFailure) {
    overallVerdict = "FAIL";
    qualityGate = "FAILED";
  } else if (coverageStatus === "PARTIAL") {
    // Never report PASS when repository scan reached limits and is PARTIAL (AR-11)!
    overallVerdict = "PARTIAL";
    qualityGate = "INCOMPLETE_PARTIAL_SCAN";
  } else if (findings.length > 0) {
    overallVerdict = "WARN";
    qualityGate = "WARNING";
  } else {
    overallVerdict = "PASS";
    qualityGate = "PASSED";
  }

  return sanitize({
    repository: path.basename(root),
    project_dir: root,
    repository_revision: repoRevision,
    standards_version: STANDARDS_REGISTRY_VERSION,
    requested_scope: scopeLabel,
    audit_mode: gitScopeMeta.mode,
    resolved_scope: {
      mode: gitScopeMeta.mode,
      base_ref: gitScopeMeta.base_ref,
      head_ref: gitScopeMeta.head_ref,
      merge_base: gitScopeMeta.merge_base,
      files_discovered: collected.coverage.files_discovered,
      files_scanned: collected.coverage.files_scanned,
      changed_files: gitScopeMeta.changed_files,
      renamed_files: gitScopeMeta.renamed_files,
      deleted_files: gitScopeMeta.deleted_files,
    },
    detection_status: detectionStatus,
    coverage_status: coverageStatus,
    policy_status: policyStatus,
    overall_verdict: overallVerdict,
    scan_completeness: coverageStatus,
    scan_coverage: collected.coverage,
    applied_exceptions: appliedExceptions,
    scanners_executed: [
      "secret-scanner",
      "conflict-whitespace-scanner",
      "debug-statement-context-analyzer",
      "migration-safety-scanner",
      "architecture-boundary-scanner",
      "change-impact-test-scanner",
      "dynamic-standards-pattern-scanner",
    ],
    scanners_skipped: [],
    scope: scopeLabel,
    files_audited: targetFiles.length,
    standards_loaded: applicableStandards.length,
    baseline_active: baselineData.active,
    result: overallVerdict,
    quality_gate: qualityGate,
    errors,
    warnings,
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

  for (const err of loaded.loadErrors || []) {
    issues.push({ type: "registry_load_error", rule_id: null, detail: err });
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
 * (Section 9 & Acceptance Scenarios AR-14, AR-15).
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

  if (workflowState && (workflowState.requireKernelMutex || workflowState.boundKernelCapability || requireOwnership)) {
    const cap = workflowState._assertKernelOwnership("helper_apply_safe_fix");
    return { fencedCapability: cap, temporaryCapability: null };
  }

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

  if (requireOwnership) {
    throw new ProjectOwnershipLostError(
      "Project ownership lost before helper_apply_safe_fix: missing OS kernel mutex capability.",
      { operation: "helper_apply_safe_fix", reason: "missing_capability" }
    );
  }

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

function validateApprovedVerifyCommand(verifyCommand) {
  if (!verifyCommand) return null;
  if (!Array.isArray(verifyCommand) || verifyCommand.length === 0) {
    throw new Error("verifyCommand must be a non-empty array of strings.");
  }
  const rawBin = String(verifyCommand[0] || "").trim();
  const baseBin = path.basename(rawBin).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
  if (!ALLOWED_VERIFY_BINARIES.has(baseBin) || rawBin.includes("..")) {
    throw new Error(
      `Untrusted verifyCommand executable '${rawBin}'. Allowed executables: ${Array.from(ALLOWED_VERIFY_BINARIES).join(", ")}.`
    );
  }
  return verifyCommand.map((arg) => String(arg));
}

/**
 * Bounded Self-Healing Autofix Engine (`helper_apply_safe_fix`, CRITICAL FINDING C & E — AR-08..AR-10, AR-13..AR-15)
 */
export async function applyBoundedSafeFix({
  projectDir,
  file,
  ruleId = "ZET-CODE-002",
  verifyCommand = null,
  simulateVerificationFailure = false,
  simulateConcurrentEditBeforeRollback = null,
  workflowState = null,
  requireOwnership = false,
  sessionId = null,
} = {}) {
  const root = path.resolve(projectDir || workflowState?.state?.projectDir || process.cwd());
  if (!file || typeof file !== "string") {
    throw new Error("A target file path is required for helper_apply_safe_fix.");
  }

  const approvedCmd = validateApprovedVerifyCommand(verifyCommand);

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
        verification_level: "NONE",
        tests_executed: false,
        rule_id: ruleId,
        autofix_class: "AF-2/AF-3",
        file: relTarget,
        reason: `Rule '${ruleId}' is classified as behavior-sensitive or high-risk (AF-2/AF-3) and cannot be auto-applied without human review.`,
      };
    }

    const originalContent = await fs.readFile(absTarget, "utf8");
    let updatedContent = originalContent;
    let autofixClass = ruleId === "ZET-CODE-002" ? "AF-0" : "AF-1";

    if (ruleId === "ZET-CODE-002") {
      updatedContent = originalContent
        .split(/\r?\n/)
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n");
    } else if (ruleId === "ZET-CODE-001") {
      // FINDING E (AR-13): Check for complex / inline-conditional / expression-embedded debug statements
      const debugHits = analyzeDebugStatementsInSource(originalContent);
      const complexHits = debugHits.filter((h) => !h.isSimpleStandalone);
      if (complexHits.length > 0) {
        return {
          applied: false,
          status: "PROPOSAL_ONLY_BEHAVIOR_SENSITIVE",
          verification_level: "NONE",
          tests_executed: false,
          rule_id: ruleId,
          autofix_class: "AF-2",
          file: relTarget,
          complex_occurrences: complexHits,
          reason:
            "Debug statement is embedded in control flow, an expression, or a multiline call; automatic removal could alter runtime behavior. Returning proposal for manual review.",
        };
      }

      const standaloneLineNumbers = new Set(debugHits.map((h) => h.line));
      updatedContent = originalContent
        .split(/\r?\n/)
        .filter((_, idx) => !standaloneLineNumbers.has(idx + 1))
        .join("\n");
    }

    if (updatedContent === originalContent) {
      return {
        applied: false,
        status: "NO_CHANGES_NEEDED",
        verification_level: "NONE",
        tests_executed: false,
        rule_id: ruleId,
        autofix_class: autofixClass,
        file: relTarget,
      };
    }

    // Verify local mechanical invariant before writing
    if (ruleId === "ZET-CODE-002") {
      const stripAllTrailing = (s) =>
        s
          .split(/\r?\n/)
          .map((l) => l.replace(/[ \t]+$/, ""))
          .join("\n");
      if (stripAllTrailing(originalContent) !== updatedContent) {
        throw new Error("AF-0 mechanical invariant violation: non-whitespace content changed.");
      }
    }

    await fs.writeFile(absTarget, updatedContent, "utf8");

    let verificationPassed = !simulateVerificationFailure;
    let testsExecuted = false;
    let verificationDetail = "Local deterministic transformation & invariant check passed (no external test command executed).";

    if (typeof simulateConcurrentEditBeforeRollback === "string") {
      await fs.writeFile(absTarget, simulateConcurrentEditBeforeRollback, "utf8");
    }

    if (verificationPassed && approvedCmd) {
      testsExecuted = true;
      try {
        await execFileAsync(approvedCmd[0], approvedCmd.slice(1), {
          cwd: root,
          timeout: 15000,
          windowsHide: true,
        });
        verificationDetail = `Approved verification command '${approvedCmd.join(" ")}' passed.`;
      } catch (err) {
        verificationPassed = false;
        verificationDetail = `Verification command failed: ${err.message}`;
      }
    }

    if (!verificationPassed) {
      // CRITICAL FINDING C (AR-10): Guard rollback against overwriting concurrent developer edits!
      const currentDiskContent = await fs.readFile(absTarget, "utf8");
      if (currentDiskContent !== updatedContent) {
        return {
          applied: false,
          restored_snapshot: false,
          concurrent_modification_detected: true,
          status: "ROLLBACK_ABORTED_CONCURRENT_MODIFICATION",
          verification_level: "ROLLED_BACK_ABORTED_CONCURRENT_EDIT",
          tests_executed: testsExecuted,
          rule_id: ruleId,
          autofix_class: autofixClass,
          file: relTarget,
          verification_detail:
            "Target file was modified concurrently after autofix write; aborted snapshot overwrite to preserve concurrent developer changes.",
        };
      }

      await fs.writeFile(absTarget, originalContent, "utf8");
      return {
        applied: false,
        restored_snapshot: true,
        concurrent_modification_detected: false,
        status: "ROLLED_BACK_ON_VERIFICATION_FAILURE",
        verification_level: "ROLLED_BACK",
        tests_executed: testsExecuted,
        rule_id: ruleId,
        autofix_class: autofixClass,
        file: relTarget,
        verification_detail: verificationDetail,
      };
    }

    // Truthful verification level (CRITICAL FINDING C — AR-08):
    // Distinguish MECHANICALLY_VERIFIED (no external tests run) from TEST_VERIFIED (external test suite passed).
    const verificationLevel = testsExecuted ? "TEST_VERIFIED" : "MECHANICALLY_VERIFIED";

    return {
      applied: true,
      restored_snapshot: false,
      status: "VERIFIED_APPLIED",
      verification_level: verificationLevel,
      tests_executed: testsExecuted,
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
    `Scope: ${report.scope} (Mode: ${report.audit_mode || "repository"})`,
    `Detection: ${report.detection_status || "COMPLETED"} | Coverage: ${report.coverage_status || "COMPLETE"} | Policy: ${report.policy_status || "COMPLIANT"}`,
    `Result: ${report.result}`,
    "",
  ];
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    lines.push("Errors:");
    for (const err of report.errors) {
      lines.push(`- [${err.code || "ERROR"}] ${err.message}`);
    }
    lines.push("");
  }
  if (report.findings.length === 0) {
    lines.push("Findings: None (0 violations detected).");
  } else {
    lines.push("Findings:", "");
    for (const f of report.findings) {
      const statusTag = f.baseline_status === "historical" ? " [HISTORICAL DEBT]" : "";
      lines.push(`[${f.severity.toUpperCase()}] ${f.rule_id}${statusTag}`);
      lines.push(f.title);
      lines.push(`File: ${f.file}${f.line ? `:${f.line}` : ""} (Fingerprint: ${f.evidence_fingerprint || "n/a"})`);
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
      recommendedTests.add(
        "node --import ./tests/setup-env.js --test tests/project-lock-lifecycle-termination.test.js tests/process-lock.test.js"
      );
      riskLevel = "HIGH";
    } else if (norm.startsWith("agent_worker/")) {
      affectedModules.add("Python Coding Agent Worker");
      recommendedTests.add('python -m unittest discover -s agent_worker -p "test_*.py"');
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
 * Unified dispatcher for all DevWorkflow V3.0 canonical engineering audit & helper tools.
 *
 * Radical Simplification (v3.0.0):
 * - 11 legacy `audit_*` tools are consolidated into one canonical `audit` MCP tool.
 * - 12 legacy `helper_*` tools are consolidated into 3 canonical MCP tools:
 *   `analyze_change`, `plan_fix`, and `apply_safe_fix`.
 * - Zero public compatibility aliases are registered in `DEVWORKFLOW_V2_TOOL_DEFINITIONS`.
 */
export const DEVWORKFLOW_V2_TOOL_DEFINITIONS = [
  {
    name: "audit",
    description:
      "[READ_ONLY_STATIC] Canonical engineering audit tool: evaluate code, Git/PR changes, full repository, specific categories (architecture, security, tests, api, database), standards registry, or MCP tool catalog with 4-dimension reliability verdicts and formatted_report.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [
            "code",
            "changes",
            "repository",
            "architecture",
            "security",
            "tests",
            "testing",
            "api",
            "api-contracts",
            "database",
            "code-quality",
            "standards",
            "report",
            "catalog",
            "bugfix_knowledge",
            "release_docs",
          ],
          description:
            "Audit category or mode: 'code' (default for files/repo), 'changes' (Git working_tree/staged/commit_range/PR merge-base), 'repository' (full repository scan), 'architecture', 'security', 'tests', 'api', 'database', 'standards' (validate YAML standards registry), 'report' (code/PR audit with formatted_report), 'catalog' (audit MCP tool catalog), 'bugfix_knowledge' (verify mandatory @zettly-code bug-fix comments & graph freshness), or 'release_docs' (verify open-source README/CHANGELOG/website release synchronization).",
        },
        scope: {
          type: "string",
          description:
            "Optional scope label ('Selected Files', 'Pull Request', 'Full Repository'). Automatically selects PR diff discovery when set to 'Pull Request'.",
        },
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        taskType: { type: "string", description: "Optional task type for bugfix_knowledge gate (e.g. BUG_FIX, FEATURE)." },
        bugId: { type: "string", description: "Optional bug identifier for bugfix_knowledge gate." },
        problemDescription: { type: "string" },
        confirmedRootCause: { type: "string" },
        fixSummary: { type: "string" },
        testReferences: { type: "array", items: { type: "string" } },
        gitCommit: { type: "string" },
        zettlyTodoId: { type: "number" },
        requireFreshGraph: { type: "boolean" },
        repoName: { type: "string", description: "Optional repository name for release_docs gate." },
        stage: { type: "string", enum: ["pre_publish", "post_publish", "both"], description: "Two-stage release gate mode: pre_publish (default), post_publish, or both." },
        expectedVersion: { type: "string", description: "Optional expected release version for release_docs gate." },
        expectedToolCount: { type: "number" },
        githubReleaseVersion: { type: "string" },
        npmPublishedVersion: { type: "string" },
        npmLatestVersion: { type: "string" },
        runtimeVersion: { type: "string" },
        checkLiveWebsite: { type: "boolean" },
        liveWebsiteHtml: { type: "string" },
        changeMode: {
          type: "string",
          description: "Git change detection mode: 'auto', 'working_tree', 'staged', 'commit_range', or 'pr'.",
        },
        baseRef: { type: "string" },
        headRef: { type: "string" },
        commitRange: { type: "string" },
        baselineFile: { type: "string" },
        maxFiles: { type: "number" },
        maxDepth: { type: "number" },
        includeMatrix: { type: "boolean" },
        includeInventory: { type: "boolean" },
        includeConsolidationPlan: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "analyze_change",
    description:
      "[READ_ONLY] Canonical change analysis tool: evaluate change impact & recommended regression tests, explain rule violations, structure failing test/error root causes, advise incremental refactoring, recommend documentation updates, prioritize technical debt, or propose advisory engineering standards.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: [
            "impact",
            "tests",
            "explain",
            "root_cause",
            "refactor",
            "docs",
            "debt",
            "opportunities",
            "propose_standard",
          ],
          description:
            "Analysis mode (defaults to 'impact', or auto-inferred from ruleId / errorMessage / title+problemDescription).",
        },
        projectDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        file: { type: "string" },
        ruleId: { type: "string" },
        errorMessage: { type: "string" },
        proposedId: { type: "string" },
        title: { type: "string" },
        problemDescription: { type: "string" },
        recurrenceEvidence: { type: "array", items: { type: "string" } },
        proposedSeverity: { type: "string" },
        proposedEnforcement: { type: "string" },
        persistProposal: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "plan_fix",
    description:
      "[READ_ONLY] Canonical remediation planner: generate a bounded fix plan with risk assessment, required tests, and rollback instructions for a ruleId, and/or discover deterministic AF-0/AF-1 autofix candidates across files or Git changes.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["plan", "candidates", "all"],
          description:
            "Planning mode: 'plan' (remediation plan for ruleId), 'candidates' (scan for AF-0/AF-1 autofix-eligible findings), or 'all' (auto-inferred when omitted).",
        },
        projectDir: { type: "string" },
        ruleId: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        changeMode: { type: "string" },
        baseRef: { type: "string" },
        headRef: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "apply_safe_fix",
    description:
      "[LOCAL_WRITE_FENCED] Canonical safe autofix tool: apply an allowlisted deterministic AF-0/AF-1 fix under OS worktree mutex fencing with truthful verification levels (MECHANICALLY_VERIFIED vs TEST_VERIFIED) and concurrent rollback protection.",
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
    name: "code_index",
    description:
      "[ZETTLY_CODE] Manage the persistent Zettly Code SQLite knowledge graph for a repository: check freshness ('status'), bootstrap ('initialize'), incrementally re-index changed files ('update'), verify graph + @zettly-code annotations ('verify'), or rebuild deterministically ('rebuild').",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["status", "initialize", "update", "verify", "rebuild"],
          description: "Index operation mode (default: 'status').",
        },
        projectDir: { type: "string" },
        maxFiles: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "code_context",
    description:
      "[ZETTLY_CODE_READ_ONLY] Query persistent Zettly Code debugging memory and bounded knowledge graph context before scanning files: retrieve relevant symbols, @zettly-code bug-fix notes, invariants, callers, dependencies, covering tests, impact radius, or historical bug-fix records.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["debug", "symbol", "dependencies", "callers", "tests", "impact", "history"],
          description: "Retrieval mode (default: 'debug').",
        },
        projectDir: { type: "string" },
        query: { type: "string" },
        symbol: { type: "string" },
        file: { type: "string" },
        depth: { type: "number" },
        maxFiles: { type: "number" },
        autoUpdate: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
];

export const DEVWORKFLOW_V2_TOOL_NAMES = new Set(
  DEVWORKFLOW_V2_TOOL_DEFINITIONS.map((t) => t.name)
);

const CATEGORY_FILTER_MAP = Object.freeze({
  architecture: { filter: "architecture", label: "Architecture" },
  security: { filter: "security", label: "Security" },
  tests: { filter: "testing", label: "Testing" },
  testing: { filter: "testing", label: "Testing" },
  api: { filter: "api-contracts", label: "API Contracts" },
  "api-contracts": { filter: "api-contracts", label: "API Contracts" },
  database: { filter: "database", label: "Database Migrations" },
  "code-quality": { filter: "code-quality", label: "Code Quality" },
});

export async function handleDevWorkflowV2Tool(name, args = {}, workflowState = null) {
  const projectDir = args.projectDir || workflowState?.state?.projectDir || process.cwd();
  const files = Array.isArray(args.files) ? args.files : [];
  const baseline = args.baseline || null;
  const baselineFile = args.baselineFile || null;
  const maxFiles = args.maxFiles || 1000;
  const maxDepth = args.maxDepth || 12;

  switch (name) {
    case "audit": {
      const rawCat = String(args.category || "").trim().toLowerCase();

      if (rawCat === "standards") {
        return await validateStandardsRegistry(projectDir);
      }

      if (rawCat === "bugfix_knowledge") {
        return await runBugFixKnowledgeGate({
          projectDir,
          changedFiles: files,
          taskType: args.taskType || "BUG_FIX",
          bugId: args.bugId || null,
          problemDescription: args.problemDescription || "",
          confirmedRootCause: args.confirmedRootCause || null,
          fixSummary: args.fixSummary || "",
          testReferences: Array.isArray(args.testReferences) ? args.testReferences : [],
          gitCommit: args.gitCommit || null,
          zettlyTodoId: args.zettlyTodoId || null,
          requireFreshGraph: args.requireFreshGraph !== false,
        });
      }

      if (rawCat === "release_docs") {
        return await evaluateReleaseDocsGate({
          projectDir,
          repoName: args.repoName || null,
          stage: args.stage || "pre_publish",
          expectedVersion: args.expectedVersion || null,
          expectedToolCount: args.expectedToolCount ?? null,
          githubReleaseVersion: args.githubReleaseVersion ?? null,
          npmPublishedVersion: args.npmPublishedVersion ?? null,
          npmLatestVersion: args.npmLatestVersion ?? null,
          runtimeVersion: args.runtimeVersion ?? null,
          checkLiveWebsite: Boolean(args.checkLiveWebsite),
          liveWebsiteHtml: args.liveWebsiteHtml || null,
        });
      }

      if (rawCat === "catalog") {
        const { getToolList } = await import("../tools/definitions.js");
        const { NON_SESSION_SCOPED_TOOLS } = await import("../session-scope.js");
        const tools = getToolList();
        const report = auditToolCatalog({
          tools,
          nonSessionTools: NON_SESSION_SCOPED_TOOLS,
          proposedTools: Array.isArray(args.proposedTools) ? args.proposedTools : [],
          includeMatrix: args.includeMatrix !== false,
          includeInventory: args.includeInventory !== false,
        });
        if (args.includeConsolidationPlan) {
          report.consolidation_plan = generateConsolidationPlan({
            tools,
            nonSessionTools: NON_SESSION_SCOPED_TOOLS,
          });
        }
        return sanitize(report);
      }

      const isChangesMode =
        rawCat === "changes" ||
        args.scope === "Pull Request" ||
        Boolean(args.changeMode) ||
        Boolean(args.baseRef) ||
        Boolean(args.commitRange);
      const isFullRepoMode = rawCat === "repository" || args.scope === "Full Repository";
      const mappedCategory = CATEGORY_FILTER_MAP[rawCat] || null;

      const effectiveFiles = isFullRepoMode ? [] : files;
      const scopeLabel =
        args.scope ||
        (isFullRepoMode
          ? "Full Repository"
          : isChangesMode
            ? "Pull Request / Changed Files"
            : mappedCategory
              ? mappedCategory.label
              : effectiveFiles.length
                ? "Selected Files"
                : "Repository");

      const report = await runEngineeringAudit({
        projectDir,
        files: effectiveFiles,
        categoryFilter: mappedCategory ? mappedCategory.filter : null,
        scopeLabel,
        discoverGitChanges: isChangesMode && effectiveFiles.length === 0,
        changeMode: args.changeMode || null,
        baseRef: args.baseRef || null,
        headRef: args.headRef || "HEAD",
        commitRange: args.commitRange || null,
        baseline,
        baselineFile,
        maxFiles,
        maxDepth,
      });

      return {
        ...report,
        formatted_report: formatAuditReportText(report),
      };
    }

    case "analyze_change": {
      const rawMode = String(args.mode || "").trim().toLowerCase();
      const effectiveMode =
        rawMode ||
        (args.title && args.problemDescription
          ? "propose_standard"
          : args.errorMessage
            ? "root_cause"
            : args.ruleId
              ? "explain"
              : "impact");

      if (effectiveMode === "explain") {
        return await explainViolation({ projectDir, ruleId: args.ruleId, file: args.file });
      }
      if (effectiveMode === "propose_standard") {
        return await proposeEngineeringStandard({ ...args, projectDir: args.projectDir || null });
      }
      if (effectiveMode === "root_cause") {
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
      }
      if (effectiveMode === "refactor") {
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
      if (effectiveMode === "debt") {
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
            : "No technical-debt-register.yaml found; run audit with category:'repository' to baseline.",
        };
      }
      if (effectiveMode === "docs") {
        return {
          changed_files: files,
          recommended_docs: ["AGENTS.md", "README.md", "engineering/reports/technical-debt-register.yaml"],
        };
      }
      if (effectiveMode === "opportunities") {
        return {
          project_dir: path.resolve(projectDir),
          opportunities: [
            "Use Adaptive Role Routing (FAST 2-role / STANDARD 4-role / FULL 6-role) to save 33-67% token cost on low/normal-risk changes.",
            "Run devworkflow.audit ({ category: 'changes' }) before commit_and_push to catch ZET-SEC-001, ZET-DB-001, and ZET-CODE-002 deterministically.",
            "Keep staging database parity on PostgreSQL (dev_zettly) for migration-sensitive releases.",
          ],
        };
      }

      // Default: 'impact' or 'tests'
      const impact = await analyzeChangeImpact({ projectDir, files });
      return {
        ...impact,
        recommended_docs: ["AGENTS.md", "README.md", "engineering/reports/technical-debt-register.yaml"],
      };
    }

    case "plan_fix": {
      const rawMode = String(args.mode || "").trim().toLowerCase();
      const wantCandidates = rawMode === "candidates" || rawMode === "all" || !args.ruleId;
      const wantPlan = rawMode === "plan" || rawMode === "all" || Boolean(args.ruleId);

      let planResult = null;
      if (wantPlan && args.ruleId) {
        planResult = await planSafeFix({ projectDir, ruleId: args.ruleId, files });
      }

      let candidatesResult = null;
      if (wantCandidates) {
        const audit = await runEngineeringAudit({
          projectDir,
          files,
          scopeLabel: "Autofix Candidate Scan",
          discoverGitChanges: files.length === 0,
          changeMode: args.changeMode || null,
          baseRef: args.baseRef || null,
          headRef: args.headRef || "HEAD",
          maxFiles,
          maxDepth,
        });
        candidatesResult = {
          project_dir: audit.project_dir,
          candidates: audit.findings.filter((f) => f.autofix_eligible),
        };
      }

      if (planResult && candidatesResult) {
        return {
          ...planResult,
          ...candidatesResult,
        };
      }
      if (planResult) return planResult;
      return candidatesResult;
    }

    case "apply_safe_fix":
      return await applyBoundedSafeFix({
        projectDir,
        file: args.file,
        ruleId: args.ruleId || "ZET-CODE-002",
        verifyCommand: args.verifyCommand || null,
        simulateVerificationFailure: Boolean(args.simulateVerificationFailure),
        simulateConcurrentEditBeforeRollback: args.simulateConcurrentEditBeforeRollback || null,
        workflowState,
        requireOwnership: Boolean(args.requireOwnership),
        sessionId: args.sessionId || null,
      });

    case "code_index":
      return await runCodeIndex({
        projectDir,
        mode: args.mode || "status",
        maxFiles: args.maxFiles || 5000,
      });

    case "code_context":
      return await runCodeContext({
        projectDir,
        mode: args.mode || "debug",
        query: args.query || "",
        symbol: args.symbol || null,
        file: args.file || null,
        depth: args.depth || 2,
        maxFiles: args.maxFiles || 12,
        autoUpdate: args.autoUpdate !== false,
      });

    default:
      throw new Error(`Unsupported DevWorkflow V3.1 tool: ${name}`);
  }
}
