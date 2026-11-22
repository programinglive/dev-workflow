/**
 * Permanent Open-Source Release Governance & Documentation Synchronization Gate
 * (`release_docs_gate`, integrated into canonical `audit` under category `release_docs`).
 *
 * Prevents version drift, outdated README/CHANGELOG files, stale website catalogs,
 * and references to removed MCP tools across all public `programinglive` repositories.
 */

import fs from "node:fs";
import path from "node:path";
import { REMOVED_LEGACY_TOOLS } from "./tool-catalog-auditor.js";

export const RELEASE_GOVERNANCE_VERSION = "1.0.0";

/**
 * Authoritative registry of public `programinglive` open-source repositories
 * and their documentation/website synchronization targets.
 */
export const OPEN_SOURCE_RELEASE_REGISTRY = Object.freeze([
  {
    name: "dev-workflow",
    repo: "programinglive/dev-workflow",
    visibility: "PUBLIC",
    versionSource: "package.json",
    websiteUrl: "https://devworkflow.programinglive.com/",
    websiteSourceDir: "web",
    requiredDocs: ["README.md", "CHANGELOG.md", "AGENTS.md"],
    generatedCatalogFile: "web/lib/catalog.generated.ts",
    docsDataFiles: ["web/lib/how-to-use-data.ts", "web/lib/use-cases-data.ts"],
  },
  {
    name: "zettly",
    repo: "programinglive/zettly",
    visibility: "PUBLIC",
    versionSource: "package.json",
    websiteUrl: "https://zettly.programinglive.com",
    websiteSourceDir: null,
    requiredDocs: ["README.md", "AGENTS.md"],
  },
  {
    name: "dbpinball",
    repo: "programinglive/dbpinball",
    visibility: "PUBLIC",
    versionSource: "package.json",
    websiteUrl: "https://dbpinball.programinglive.com",
    websiteSourceDir: null,
    requiredDocs: ["README.md"],
  },
  {
    name: "programinglive",
    repo: "programinglive/programinglive",
    visibility: "PUBLIC",
    versionSource: "package.json",
    websiteUrl: "https://programinglive.com",
    websiteSourceDir: null,
    requiredDocs: ["README.md"],
  },
  {
    name: "commiter",
    repo: "programinglive/commiter",
    visibility: "PUBLIC",
    versionSource: "package.json",
    websiteUrl: null,
    websiteSourceDir: null,
    requiredDocs: ["README.md"],
  },
  {
    name: "hris",
    repo: "programinglive/hris",
    visibility: "PUBLIC",
    versionSource: "composer.json",
    websiteUrl: "https://hris.programinglive.com",
    websiteSourceDir: null,
    requiredDocs: ["README.md"],
  },
  {
    name: "zettly-editor",
    repo: "programinglive/zettly-editor",
    visibility: "PUBLIC",
    versionSource: "package.json",
    websiteUrl: "https://zettly-editor.programinglive.com/",
    websiteSourceDir: null,
    requiredDocs: ["README.md"],
  },
  {
    name: "ci-cd",
    repo: "programinglive/ci-cd",
    visibility: "PUBLIC",
    versionSource: null,
    websiteUrl: null,
    websiteSourceDir: null,
    requiredDocs: ["README.md"],
  },
  {
    name: "belajar",
    repo: "programinglive/belajar",
    visibility: "PUBLIC",
    versionSource: "package.json",
    websiteUrl: "https://belajar.programinglive.com",
    websiteSourceDir: null,
    requiredDocs: ["README.md"],
  },
  {
    name: "ollama-local-ai",
    repo: "programinglive/ollama-local-ai",
    visibility: "PUBLIC",
    versionSource: null,
    websiteUrl: null,
    websiteSourceDir: null,
    requiredDocs: ["README.md"],
  },
  {
    name: "comingsoon",
    repo: "programinglive/comingsoon",
    visibility: "PUBLIC",
    versionSource: null,
    websiteUrl: "https://comingsoon.programinglive.com/",
    websiteSourceDir: null,
    requiredDocs: ["README.md"],
  },
  {
    name: "windows-gaming-dev-toolkit",
    repo: "programinglive/windows-gaming-dev-toolkit",
    visibility: "PUBLIC",
    versionSource: null,
    websiteUrl: null,
    websiteSourceDir: null,
    requiredDocs: ["README.md"],
  },
  {
    name: ".github",
    repo: "programinglive/.github",
    visibility: "PUBLIC",
    versionSource: null,
    websiteUrl: null,
    websiteSourceDir: null,
    requiredDocs: [],
  },
]);

const REMOVED_TOOL_NAMES = Object.keys(REMOVED_LEGACY_TOOLS);
const PRIVATE_LEAK_PATTERNS = [
  /[A-Z]:\\Users\\[A-Za-z0-9_-]+/i,
  /[A-Z]:\/Users\/[A-Za-z0-9_-]+/i,
  /\b100\.77\.138\.14\b/,
  /\bHELLOWORLD\b/,
  /\bMMCH\b/,
];

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function detectRepositoryEntry(projectDir, explicitRepoName = null) {
  const pkg = readJsonSafe(path.join(projectDir, "package.json"));
  const candidateName =
    explicitRepoName ||
    (pkg?.name ? String(pkg.name).replace(/^@[^/]+\//, "") : path.basename(path.resolve(projectDir)));
  return (
    OPEN_SOURCE_RELEASE_REGISTRY.find(
      (r) => r.name === candidateName || r.repo === candidateName
    ) || null
  );
}

/**
 * Evaluate the Permanent Open-Source Release Documentation & Website Synchronization Gate.
 */
export async function evaluateReleaseDocsGate({
  projectDir,
  repoName = null,
  expectedVersion = null,
  expectedToolCount = null,
  liveWebsiteHtml = null,
  checkLiveWebsite = false,
} = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const registryEntry = detectRepositoryEntry(root, repoName);
  const pkg = readJsonSafe(path.join(root, "package.json"));
  const composer = readJsonSafe(path.join(root, "composer.json"));
  const actualVersion = pkg?.version || composer?.version || expectedVersion || null;

  const findings = [];
  const checks = [];

  const addFinding = (code, severity, file, message) => {
    findings.push({ code, severity, file, message });
  };

  // 1. Version source verification
  if (expectedVersion && actualVersion && expectedVersion !== actualVersion) {
    addFinding(
      "RELEASE_VERSION_MISMATCH",
      "error",
      pkg ? "package.json" : "composer.json",
      `Expected release version ${expectedVersion}, but version source reports ${actualVersion}.`
    );
  }
  checks.push({
    name: "version_source",
    status: expectedVersion && actualVersion !== expectedVersion ? "FAIL" : "PASS",
    version: actualVersion,
  });

  // 2. README.md synchronization
  const readmePath = path.join(root, "README.md");
  if (!fs.existsSync(readmePath)) {
    addFinding("MISSING_README", "error", "README.md", "Public repository is missing README.md.");
  } else {
    const readme = fs.readFileSync(readmePath, "utf8");
    if (actualVersion && !readme.includes(actualVersion)) {
      addFinding(
        "README_VERSION_DRIFT",
        "error",
        "README.md",
        `README.md does not reference current release version ${actualVersion}.`
      );
    }
    for (const pat of PRIVATE_LEAK_PATTERNS) {
      if (pat.test(readme)) {
        addFinding(
          "PRIVATE_ENVIRONMENT_LEAK",
          "error",
          "README.md",
          `README.md contains private workstation or internal host identifier matching ${pat}.`
        );
      }
    }
  }

  // 3. CHANGELOG.md synchronization
  const changelogPath = path.join(root, "CHANGELOG.md");
  if (fs.existsSync(changelogPath)) {
    const changelog = fs.readFileSync(changelogPath, "utf8");
    if (actualVersion && !changelog.includes(actualVersion)) {
      addFinding(
        "CHANGELOG_VERSION_DRIFT",
        "error",
        "CHANGELOG.md",
        `CHANGELOG.md does not contain a release entry for version ${actualVersion}.`
      );
    }
  } else if (registryEntry?.requiredDocs?.includes("CHANGELOG.md")) {
    addFinding("MISSING_CHANGELOG", "error", "CHANGELOG.md", "Required CHANGELOG.md is missing.");
  }

  // 4. Website source & generated catalog synchronization (when web/ exists)
  const webDir = path.join(root, "web");
  let websiteSourceStatus = "NOT_APPLICABLE";
  if (fs.existsSync(webDir)) {
    websiteSourceStatus = "PASS";

    const catalogPath = path.join(root, "web", "lib", "catalog.generated.ts");
    if (fs.existsSync(catalogPath)) {
      const catalog = fs.readFileSync(catalogPath, "utf8");
      if (actualVersion && !catalog.includes(`"${actualVersion}"`)) {
        websiteSourceStatus = "FAIL";
        addFinding(
          "WEBSITE_CATALOG_VERSION_DRIFT",
          "error",
          "web/lib/catalog.generated.ts",
          `Generated website catalog does not match version ${actualVersion}. Run web/scripts/generate-docs-data.mjs.`
        );
      }
      if (expectedToolCount !== null) {
        const countMatch = /toolCount:\s*(\d+)/.exec(catalog);
        if (countMatch && Number(countMatch[1]) !== Number(expectedToolCount)) {
          websiteSourceStatus = "FAIL";
          addFinding(
            "WEBSITE_TOOL_COUNT_DRIFT",
            "error",
            "web/lib/catalog.generated.ts",
            `Generated website catalog reports toolCount=${countMatch[1]}, expected ${expectedToolCount}.`
          );
        }
      }
    }

    const docsDataFiles = ["web/lib/how-to-use-data.ts", "web/lib/use-cases-data.ts"];
    for (const rel of docsDataFiles) {
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, "utf8");

      // Detect stale @programinglive/dev-workflow@<oldVersion>
      const pkgVerMatch = /@programinglive\/dev-workflow@([0-9]+\.[0-9]+\.[0-9]+)/g;
      let m;
      while ((m = pkgVerMatch.exec(content)) !== null) {
        if (actualVersion && m[1] !== actualVersion) {
          websiteSourceStatus = "FAIL";
          addFinding(
            "WEBSITE_STALE_PACKAGE_VERSION",
            "error",
            rel,
            `Website doc file references outdated package version @programinglive/dev-workflow@${m[1]} (current: ${actualVersion}).`
          );
        }
      }

      // Detect stale toolsDiscovered mismatch
      if (expectedToolCount !== null) {
        const tdMatch = /"toolsDiscovered":\s*(\d+)/.exec(content);
        if (tdMatch && Number(tdMatch[1]) !== Number(expectedToolCount)) {
          websiteSourceStatus = "FAIL";
          addFinding(
            "WEBSITE_STALE_TOOL_COUNT",
            "error",
            rel,
            `Website doc file shows toolsDiscovered: ${tdMatch[1]}, expected ${expectedToolCount}.`
          );
        }
      }

      // Detect removed legacy MCP tool names in active tutorials
      for (const removed of REMOVED_TOOL_NAMES) {
        const rx = new RegExp(`\\b${removed}\\b`);
        if (rx.test(content)) {
          websiteSourceStatus = "FAIL";
          addFinding(
            "WEBSITE_REMOVED_TOOL_REFERENCE",
            "error",
            rel,
            `Website documentation still references removed v2 MCP tool '${removed}'. Replace with canonical '${REMOVED_LEGACY_TOOLS[removed].canonicalTool}'.`
          );
        }
      }

      // Private leak guard in public web/
      for (const pat of PRIVATE_LEAK_PATTERNS) {
        if (pat.test(content)) {
          websiteSourceStatus = "FAIL";
          addFinding(
            "WEBSITE_PRIVATE_LEAK",
            "error",
            rel,
            `Public website file contains forbidden private workstation/host pattern ${pat}.`
          );
        }
      }
    }
  }
  checks.push({ name: "website_source", status: websiteSourceStatus });

  // 5. Optional live website verification
  let liveWebsiteStatus = "NOT_CHECKED";
  let inspectedHtml = liveWebsiteHtml;
  if (!inspectedHtml && checkLiveWebsite && registryEntry?.websiteUrl) {
    try {
      const resp = await fetch(registryEntry.websiteUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        inspectedHtml = await resp.text();
      } else {
        liveWebsiteStatus = `HTTP_${resp.status}`;
        addFinding(
          "LIVE_WEBSITE_HTTP_ERROR",
          "warning",
          registryEntry.websiteUrl,
          `Live website returned HTTP ${resp.status}.`
        );
      }
    } catch (err) {
      liveWebsiteStatus = "FETCH_FAILED";
      addFinding(
        "LIVE_WEBSITE_UNREACHABLE",
        "warning",
        registryEntry.websiteUrl,
        `Could not reach live website: ${err.message}`
      );
    }
  }

  if (typeof inspectedHtml === "string" && inspectedHtml.length > 0) {
    const hasCurrentVersion = actualVersion ? inspectedHtml.includes(actualVersion) : true;
    const removedFound = REMOVED_TOOL_NAMES.filter((t) => new RegExp(`\\b${t}\\b`).test(inspectedHtml));
    if (!hasCurrentVersion || removedFound.length > 0) {
      liveWebsiteStatus = "DEPLOY_PENDING_OR_DRIFTED";
      addFinding(
        "LIVE_WEBSITE_DRIFT",
        "error",
        registryEntry?.websiteUrl || "live-website",
        !hasCurrentVersion
          ? `Live website does not display current release version ${actualVersion}. Redeploy website after release.`
          : `Live website still displays removed MCP tools: ${removedFound.join(", ")}.`
      );
    } else {
      liveWebsiteStatus = "LIVE_SYNCED";
    }
  }
  checks.push({ name: "live_website", status: liveWebsiteStatus });

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");

  return {
    ok: errors.length === 0,
    gate: "release_docs_gate",
    status: errors.length === 0 ? (warnings.length === 0 ? "PASSED" : "PASSED_WITH_WARNINGS") : "BLOCKED",
    repoName: registryEntry?.name || repoName || path.basename(root),
    repository: registryEntry?.repo || null,
    websiteUrl: registryEntry?.websiteUrl || null,
    version: actualVersion,
    registryCount: OPEN_SOURCE_RELEASE_REGISTRY.length,
    checks,
    errorsCount: errors.length,
    warningsCount: warnings.length,
    findings,
  };
}
