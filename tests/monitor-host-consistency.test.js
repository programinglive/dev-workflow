import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The live dashboard moved from the database-only host `bw-server-clean`
 * (100.107.65.21:3100) to `bw-tools` (100.77.138.14:3100) on 2026-11-09.
 * Every client that still pointed at the old address reported into a socket
 * nobody was listening on, so the machine showed no sessions at all.
 *
 * These tests keep the address from silently drifting back. Historical,
 * dated documents are excluded: they describe what happened and must not be
 * rewritten. PostgreSQL also still lives on 100.107.65.21, so that address is
 * allowed, but only where the line is about the database port.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RETIRED_HOST = "100.107.65.21";
const RETIRED_MONITOR_URL = "http://100.107.65.21:3100";
const PUBLIC_DEFAULT_MONITOR_URL = "http://127.0.0.1:3100";

// Generated or vendored trees that would only add noise.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".managed-publish", ".state", ".agent", "dist",
  "web", "db", "security", "tools", ".github", ".husky", ".netlify", "android",
]);

// The scanner cannot police its own source: it has to name the strings it forbids.
const SELF = "tests/monitor-host-consistency.test.js";

// Dated records are history, not live configuration.
// Git worktrees are separate checkouts of the same repository: scanning them
// reports violations from code that is not part of this tree, which is how a
// local `npm test` failed while CI stayed green.
const HISTORICAL_PATHS = [
  /^docs[\\/]superpowers[\\/]/,
  /^docs[\\/]20\d\d-\d\d-\d\d-/,
  /^\.worktrees[\\/]/,
];

// Binary and lock artefacts.
const SKIP_FILE = /(package-lock\.json|CHANGELOG\.md|\.env$|\.(png|ico|jpg|jpeg|gif|webp|apk|tgz|gz|zip))$/i;

// Public runtime surfaces that must default to environment-agnostic local-first URLs.
const FILES_WITH_PUBLIC_MONITOR_DEFAULT = [
  "monitor-server/dashboard.cjs",
  "mobile-app/App.js",
  "mobile-app/app.json",
  "cli/monitor-client.js",
];

function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name), rel));
      continue;
    }
    if (!entry.isFile()) continue;
    if (HISTORICAL_PATHS.some((re) => re.test(rel))) continue;
    if (SKIP_FILE.test(entry.name)) continue;
    out.push(rel);
  }
  return out;
}

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function liveFiles() {
  return walk(ROOT).filter((rel) => {
    if (rel === SELF) return false;
    if (HISTORICAL_PATHS.some((re) => re.test(rel))) return false;
    try {
      return statSync(path.join(ROOT, rel)).isFile();
    } catch {
      return false;
    }
  });
}

test("no live file points a browser or client at the retired monitor URL", () => {
  const offenders = [];
  for (const rel of liveFiles()) {
    let body;
    try {
      body = read(rel);
    } catch {
      continue; // unreadable or binary
    }
    if (!body.includes(RETIRED_MONITOR_URL)) continue;
    body.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(RETIRED_MONITOR_URL)) offenders.push(`${rel}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `retired monitor URL still referenced at: ${offenders.join(", ")}`);
});

test("the retired host is only mentioned as the PostgreSQL host", () => {
  const offenders = [];
  for (const rel of liveFiles()) {
    let body;
    try {
      body = read(rel);
    } catch {
      continue;
    }
    if (!body.includes(RETIRED_HOST)) continue;
    body.split(/\r?\n/).forEach((line, index) => {
      if (!line.includes(RETIRED_HOST)) return;
      // Allowed only when the line is clearly about the database, e.g.
      // `@100.107.65.21:5432` or a sentence that names both parts.
      const aboutDatabase = /5432/.test(line) || /postgres/i.test(line) || /bw-server-clean/.test(line);
      if (!aboutDatabase) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `retired host used for something other than PostgreSQL: ${offenders.join(" | ")}`);
});

test("no live file escapes the retired host into a regex that still asserts it", () => {
  // The first sweep missed `100\.107\.65\.21` inside a regex literal because
  // the dots were escaped. That is exactly how one assertion kept demanding the
  // old address while the code already returned the new one.
  const escaped = "100\\.107\\.65\\.21";
  const offenders = [];
  for (const rel of liveFiles()) {
    let body;
    try {
      body = read(rel);
    } catch {
      continue;
    }
    body.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(escaped)) offenders.push(`${rel}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `escaped retired host still asserted at: ${offenders.join(", ")}`);
});

test("every public runtime configuration surface uses local-first default monitor URL", () => {
  const missing = FILES_WITH_PUBLIC_MONITOR_DEFAULT.filter((rel) => {
    try {
      return !read(rel).includes(PUBLIC_DEFAULT_MONITOR_URL);
    } catch {
      return true;
    }
  });
  assert.deepEqual(missing, [], `missing ${PUBLIC_DEFAULT_MONITOR_URL} in: ${missing.join(", ")}`);
});
