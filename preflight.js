/**
 * README-first preflight for DevWorkflow tasks.
 *
 * WHY THIS EXISTS
 * ---------------
 * Agents were told to read README.md and AGENTS.md before coding, but nothing
 * enforced it. A task could start, commit and close without the server ever
 * looking at the repository's own instructions. This module makes the server
 * perform a bounded, read-only discovery at `start_task` and revalidate it at
 * `resume_session`, then persist the result as evidence.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * - It never executes a command found in README.md, AGENTS.md, package.json or
 *   any other document. Documents are untrusted project content.
 * - It never reads secrets or private configuration values. It records paths,
 *   SHA-256 fingerprints, script names and invocation references only.
 * - It does not scan the whole repository. Reads are bounded by bytes, depth
 *   and file count.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const MAX_DOC_BYTES = 64 * 1024;
export const MAX_NESTED_AGENTS = 20;
export const MAX_NESTED_DEPTH = 2;
export const MAX_CLI_REFERENCES = 40;

const README_VARIANTS = ["README.md", "README", "README.rst", "README.txt"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  "target",
]);

function fingerprint(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** Read at most `maxBytes` from a file without loading the whole file. */
export function readBounded(file, maxBytes = MAX_DOC_BYTES) {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    const length = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
      const bytesRead = readSync(fd, buffer, 0, length, 0);
      return {
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: stat.size > maxBytes,
        bytes: stat.size,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function findReadme(projectDir) {
  for (const name of README_VARIANTS) {
    const file = path.join(projectDir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

export function findNestedAgents(projectDir) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_NESTED_DEPTH || found.length >= MAX_NESTED_AGENTS) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_NESTED_AGENTS) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name === "AGENTS.md") {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(projectDir, 0);
  return found;
}

function readJson(file) {
  try {
    return JSON.parse(readBounded(file)?.text || "null");
  } catch {
    return null;
  }
}

/**
 * Discover documented CLI entrypoints. Nothing is executed; every reference is
 * marked `verified: false` until a human or a test proves it runs.
 */
export function discoverCli(projectDir) {
  const refs = [];

  const pkg = readJson(path.join(projectDir, "package.json"));
  for (const [name, command] of Object.entries(pkg?.scripts || {})) {
    refs.push({
      name,
      source: "package.json",
      invocation: `npm run ${name}`,
      purpose: String(command).slice(0, 120),
      verified: false,
    });
  }

  const composer = readJson(path.join(projectDir, "composer.json"));
  for (const [name, command] of Object.entries(composer?.scripts || {})) {
    refs.push({
      name,
      source: "composer.json",
      invocation: `composer run ${name}`,
      purpose: String(Array.isArray(command) ? command.join(" && ") : command).slice(0, 120),
      verified: false,
    });
  }

  if (existsSync(path.join(projectDir, "pyproject.toml"))) {
    refs.push({
      name: "pyproject",
      source: "pyproject.toml",
      invocation: "see [project.scripts]",
      purpose: "Python project entrypoints",
      verified: false,
    });
  }

  if (existsSync(path.join(projectDir, "Makefile"))) {
    refs.push({
      name: "make",
      source: "Makefile",
      invocation: "make <target>",
      purpose: "Make targets",
      verified: false,
    });
  }

  return refs.slice(0, MAX_CLI_REFERENCES);
}

const MAX_SUMMARY_CHARS = 2400;

function looksSensitive(line) {
  return (
    /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)\s*[:=]/i.test(line) ||
    /^[A-Z0-9_]+\s*=\s*\S+/.test(line)
  );
}

function meaningfulLines(text, maxLines) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```") && !looksSensitive(line))
    .slice(0, maxLines);
}

function extractRules(text) {
  const rules = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (looksSensitive(trimmed)) continue;
    if (/^(?:[-*]\s*)?(?:MUST|NEVER|ALWAYS|DO NOT|DON'T|FORBIDDEN|PROHIBITED)\b/i.test(trimmed)) {
      rules.push(trimmed.replace(/^[-*]\s*/, "").slice(0, 200));
    }
    if (rules.length >= 8) break;
  }
  return rules;
}

/**
 * Build a bounded, task-relevant instruction summary from README and AGENTS.md.
 * The summary is stored instead of the full document bodies.
 */
export function summarizeInstructions({ projectDir, taskDescription = "" } = {}) {
  const root = path.resolve(String(projectDir || ""));
  const readmePath = findReadme(root);
  const readmeDoc = readmePath ? readBounded(readmePath) : null;

  const agents = [];
  const rootAgents = path.join(root, "AGENTS.md");
  if (existsSync(rootAgents)) {
    const doc = readBounded(rootAgents);
    if (doc) agents.push({ path: rootAgents, text: doc.text });
  }
  for (const file of findNestedAgents(root)) {
    if (file === rootAgents) continue;
    const doc = readBounded(file);
    if (doc) agents.push({ path: file, text: doc.text });
  }

  const readmeLines = readmeDoc ? meaningfulLines(readmeDoc.text, 8) : [];
  const purpose = readmeLines.find((line) => !line.startsWith("#")) || readmeLines[0] || "";
  const rules = agents.flatMap((agent) => extractRules(agent.text)).slice(0, 8);
  const cli = discoverCli(root);
  const buildTestRelease = cli
    .filter((ref) => /test|build|release|lint|check|verify/i.test(ref.name))
    .slice(0, 8);
  const prohibited = rules
    .filter((rule) => /never|do not|don't|forbidden|prohibited/i.test(rule))
    .slice(0, 6);
  const documentation = [readmePath, ...agents.map((agent) => agent.path)].filter(Boolean);

  const lines = [];
  if (purpose) lines.push(`Purpose: ${purpose.slice(0, 200)}`);
  if (rules.length) lines.push(`Rules: ${rules.join(" | ")}`);
  if (buildTestRelease.length) lines.push(`Build/test/release: ${buildTestRelease.map((ref) => ref.invocation).join(", ")}`);
  if (prohibited.length) lines.push(`Prohibited: ${prohibited.join(" | ")}`);
  if (taskDescription) lines.push(`Task scope: ${String(taskDescription).slice(0, 200)}`);
  if (documentation.length) lines.push(`Docs: ${documentation.join(", ")}`);

  return {
    purpose: purpose.slice(0, 200),
    rules,
    cli: cli.slice(0, 12),
    buildTestRelease,
    prohibited,
    taskScope: String(taskDescription || "").slice(0, 200),
    documentation,
    text: lines.join("\n").slice(0, MAX_SUMMARY_CHARS),
  };
}

/**
 * Run the bounded preflight for a project.
 *
 * @returns {object} a persisted-safe record. It contains no document bodies and
 *   no secret values, only paths, fingerprints, CLI references and a bounded
 *   instruction summary.
 */
export function runPreflight({ projectDir, taskId = "", taskDescription = "" } = {}) {
  const root = path.resolve(String(projectDir || ""));
  if (!projectDir || !existsSync(root) || !statSync(root).isDirectory()) {
    return {
      ok: false,
      code: "INVALID_PROJECT_ROOT",
      taskId,
      projectRoot: root,
      preflightAt: new Date().toISOString(),
    };
  }

  const readmePath = findReadme(root);
  const readmeDoc = readmePath ? readBounded(readmePath) : null;

  const agents = [];
  const rootAgents = path.join(root, "AGENTS.md");
  if (existsSync(rootAgents)) {
    const doc = readBounded(rootAgents);
    if (doc) {
      agents.push({ path: rootAgents, fingerprint: fingerprint(doc.text), truncated: doc.truncated });
    }
  }
  for (const file of findNestedAgents(root)) {
    if (file === rootAgents) continue;
    const doc = readBounded(file);
    if (doc) {
      agents.push({ path: file, fingerprint: fingerprint(doc.text), truncated: doc.truncated });
    }
  }

  return {
    ok: true,
    taskId,
    projectRoot: root,
    readme: readmePath
      ? { path: readmePath, fingerprint: fingerprint(readmeDoc.text), truncated: readmeDoc.truncated }
      : null,
    readmeMissing: !readmePath,
    agents,
    agentGuidanceMissing: agents.length === 0,
    cli: discoverCli(root),
    instructionSummary: summarizeInstructions({ projectDir: root, taskDescription }),
    preflightAt: new Date().toISOString(),
    verification: "PREFLIGHT_RECORDED",
  };
}

/**
 * Revalidate a previous preflight record against the current working tree.
 *
 * Documentation edits are reported as changes, not as failures. The caller
 * decides whether a change affects the task contract.
 */
export function revalidatePreflight(record, { projectDir } = {}) {
  if (!record || record.ok !== true) {
    return { ok: false, code: "STALE_PREFLIGHT", reason: "no previous preflight record" };
  }

  const current = runPreflight({ projectDir: projectDir || record.projectRoot, taskId: record.taskId });
  if (!current.ok) return { ok: false, code: current.code };

  const changes = [];
  if ((record.readme?.fingerprint || null) !== (current.readme?.fingerprint || null)) {
    changes.push("README_CHANGED");
  }

  const previousAgents = new Map((record.agents || []).map((a) => [a.path, a.fingerprint]));
  const currentAgents = new Map((current.agents || []).map((a) => [a.path, a.fingerprint]));
  for (const [file, hash] of currentAgents) {
    if (previousAgents.get(file) !== hash) changes.push(`AGENTS_CHANGED:${file}`);
  }
  for (const file of previousAgents.keys()) {
    if (!currentAgents.has(file)) changes.push(`AGENTS_REMOVED:${file}`);
  }

  return { ok: true, current, changes, changed: changes.length > 0 };
}

/**
 * Scope guard for DevWorkflow-governed write operations.
 *
 * The task's preflight record names the project root it was started in. A
 * governed write must not target a different root. This is deliberately narrow:
 * it does not try to intercept shell or Git commands that bypass DevWorkflow.
 */
export function assertPreflightScope(record, { projectDir, operation = "write" } = {}) {
  // Backward compatibility: a task that predates the preflight has no record.
  // The existing repository identity contract still governs it. A record that
  // exists but is invalid is a stale preflight and must be revalidated.
  if (record === null || record === undefined) {
    return {
      ok: true,
      legacy: true,
      reason: "no preflight record; legacy task allowed under the identity contract",
    };
  }
  if (record.ok !== true) {
    return {
      ok: false,
      code: "STALE_PREFLIGHT",
      reason: "the preflight record is not valid; re-run start_task to record one",
    };
  }

  const target = path.resolve(String(projectDir || ""));
  const recorded = path.resolve(String(record.projectRoot || ""));
  if (target !== recorded) {
    return {
      ok: false,
      code: "SCOPE_MISMATCH",
      reason: `${operation} targets ${target}, but the task preflight is ${recorded}`,
    };
  }

  return { ok: true };
}
