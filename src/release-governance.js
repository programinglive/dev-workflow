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

export const RELEASE_GOVERNANCE_VERSION = "2.0.0";

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
 * Evaluate the Permanent Two-Stage Open-Source Release Governance Gate.
 *
 * Stages:
 *   - "pre_publish"  : verifies source version, README, CHANGELOG, website source &
 *                      generated catalog locally (never circularly requires unpublished npm/GH).
 *   - "post_publish" : verifies external published artifacts (GitHub Release, npm published
 *                      version, npm `latest` dist-tag, runtime CLI version, and live website HTML).
 *   - "both"         : runs Stage A (pre_publish) and Stage B (post_publish).
 */
export async function evaluateReleaseDocsGate({
  projectDir,
  repoName = null,
  stage = "pre_publish",
  expectedVersion = null,
  expectedToolCount = null,
  githubReleaseVersion = null,
  npmPublishedVersion = null,
  npmLatestVersion = null,
  runtimeVersion = null,
  liveWebsiteHtml = null,
  checkLiveWebsite = false,
} = {}) {
  const normalizedStage = String(stage || "pre_publish").toLowerCase();
  const runPre = normalizedStage === "pre_publish" || normalizedStage === "both";
  const runPost =
    normalizedStage === "post_publish" ||
    normalizedStage === "both" ||
    Boolean(checkLiveWebsite) ||
    typeof liveWebsiteHtml === "string" ||
    Boolean(githubReleaseVersion) ||
    Boolean(npmPublishedVersion) ||
    Boolean(npmLatestVersion) ||
    Boolean(runtimeVersion);

  const root = path.resolve(projectDir || process.cwd());
  const registryEntry = detectRepositoryEntry(root, repoName);
  const pkg = readJsonSafe(path.join(root, "package.json"));
  const composer = readJsonSafe(path.join(root, "composer.json"));
  const actualVersion = pkg?.version || composer?.version || expectedVersion || null;
  const targetVersion = expectedVersion || actualVersion;

  const findings = [];
  const checks = [];

  const addFinding = (code, severity, file, message) => {
    findings.push({ code, severity, file, message });
  };

  // Stage A — PRE-PUBLISH checks
  if (runPre) {
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
      stage: "pre_publish",
      status: expectedVersion && actualVersion !== expectedVersion ? "FAIL" : "PASS",
      version: actualVersion,
    });

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
          const countMatch = /"?(?:mcpToolCount|toolCount)"?:\s*(\d+)/.exec(catalog);
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
    checks.push({ name: "website_source", stage: "pre_publish", status: websiteSourceStatus });
  }

  // Stage B — POST-PUBLISH checks (external surfaces)
  let liveWebsiteStatus = "NOT_CHECKED";
  let liveWebsiteVersionDetected = null;
  let npmAndGithubPassed = true;
  let liveWebsiteFailed = false;

  if (runPost) {
    if (normalizedStage === "post_publish" || normalizedStage === "both" || githubReleaseVersion !== null) {
      const ghMatch = Boolean(githubReleaseVersion && targetVersion && githubReleaseVersion.replace(/^v/, "") === targetVersion.replace(/^v/, ""));
      if (!ghMatch && (normalizedStage === "post_publish" || normalizedStage === "both" || githubReleaseVersion !== null)) {
        npmAndGithubPassed = false;
        addFinding(
          "GITHUB_RELEASE_VERSION_DRIFT",
          "error",
          "github-release",
          `GitHub Release version '${githubReleaseVersion || "MISSING"}' does not match target release '${targetVersion}'.`
        );
      }
      checks.push({ name: "github_release", stage: "post_publish", status: ghMatch ? "PASS" : "FAIL", value: githubReleaseVersion });
    }

    if (normalizedStage === "post_publish" || normalizedStage === "both" || npmPublishedVersion !== null) {
      const npmPubMatch = Boolean(npmPublishedVersion && targetVersion && npmPublishedVersion === targetVersion);
      if (!npmPubMatch) {
        npmAndGithubPassed = false;
        addFinding(
          "NPM_PUBLISHED_VERSION_DRIFT",
          "error",
          "npm-registry",
          `npm published version '${npmPublishedVersion || "UNPUBLISHED"}' does not match target release '${targetVersion}'.`
        );
      }
      checks.push({ name: "npm_published", stage: "post_publish", status: npmPubMatch ? "PASS" : "FAIL", value: npmPublishedVersion });
    }

    if (normalizedStage === "post_publish" || normalizedStage === "both" || npmLatestVersion !== null) {
      const npmLatestMatch = Boolean(npmLatestVersion && targetVersion && npmLatestVersion === targetVersion);
      if (!npmLatestMatch) {
        npmAndGithubPassed = false;
        addFinding(
          "NPM_LATEST_TAG_DRIFT",
          "error",
          "npm-dist-tags",
          `npm 'latest' dist-tag '${npmLatestVersion || "MISSING"}' does not match target release '${targetVersion}'.`
        );
      }
      checks.push({ name: "npm_latest_tag", stage: "post_publish", status: npmLatestMatch ? "PASS" : "FAIL", value: npmLatestVersion });
    }

    if (runtimeVersion !== null) {
      const rtMatch = Boolean(runtimeVersion && targetVersion && runtimeVersion.replace(/^v/, "") === targetVersion.replace(/^v/, ""));
      if (!rtMatch) {
        npmAndGithubPassed = false;
        addFinding(
          "RUNTIME_VERSION_DRIFT",
          "error",
          "cli-runtime",
          `Installed CLI runtime version '${runtimeVersion}' does not match target release '${targetVersion}'.`
        );
      }
      checks.push({ name: "runtime_version", stage: "post_publish", status: rtMatch ? "PASS" : "FAIL", value: runtimeVersion });
    }

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
          liveWebsiteFailed = true;
          addFinding(
            "LIVE_WEBSITE_HTTP_ERROR",
            "error",
            registryEntry.websiteUrl,
            `Live website returned HTTP ${resp.status}.`
          );
        }
      } catch (err) {
        liveWebsiteStatus = "FETCH_FAILED";
        liveWebsiteFailed = true;
        addFinding(
          "LIVE_WEBSITE_UNREACHABLE",
          "error",
          registryEntry.websiteUrl,
          `Could not reach live website: ${err.message}`
        );
      }
    }

    if (typeof inspectedHtml === "string" && inspectedHtml.length > 0) {
      const hasCurrentVersion = targetVersion ? inspectedHtml.includes(targetVersion) : true;
      const removedFound = REMOVED_TOOL_NAMES.filter((t) => new RegExp(`\\b${t}\\b`).test(inspectedHtml));
      if (!hasCurrentVersion || removedFound.length > 0) {
        liveWebsiteStatus = "DEPLOY_PENDING_OR_DRIFTED";
        liveWebsiteFailed = true;
        addFinding(
          "LIVE_WEBSITE_DRIFT",
          "error",
          registryEntry?.websiteUrl || "live-website",
          !hasCurrentVersion
            ? `Live website does not display current release version ${targetVersion}. Redeploy website after release.`
            : `Live website still displays removed MCP tools: ${removedFound.join(", ")}.`
        );
      } else {
        liveWebsiteStatus = "LIVE_SYNCED";
        liveWebsiteVersionDetected = targetVersion;
      }
    } else if ((normalizedStage === "post_publish" || normalizedStage === "both") && registryEntry?.websiteUrl && !inspectedHtml) {
      liveWebsiteStatus = "NOT_VERIFIED";
      liveWebsiteFailed = true;
      addFinding(
        "LIVE_WEBSITE_NOT_VERIFIED",
        "error",
        registryEntry.websiteUrl,
        "Post-publish verification requires live website HTML check for projects with an official website."
      );
    }
  }
  checks.push({ name: "live_website", stage: "post_publish", status: liveWebsiteStatus });

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");

  let stageVerdict;
  if (normalizedStage === "pre_publish" && !runPost) {
    stageVerdict = errors.length === 0 ? "PRE_PUBLISH_PASS" : "PRE_PUBLISH_FAIL";
  } else if (errors.length === 0) {
    stageVerdict = "POST_PUBLISH_PASS";
  } else if (npmAndGithubPassed && liveWebsiteFailed) {
    stageVerdict = "RELEASE_PUBLISHED_BUT_NOT_FULLY_VERIFIED";
  } else {
    stageVerdict = "POST_PUBLISH_FAIL";
  }

  return {
    ok: errors.length === 0,
    gate: "release_docs_gate",
    stage: normalizedStage,
    stageVerdict,
    status: errors.length === 0 ? (warnings.length === 0 ? "PASSED" : "PASSED_WITH_WARNINGS") : "BLOCKED",
    repoName: registryEntry?.name || repoName || path.basename(root),
    repository: registryEntry?.repo || null,
    websiteUrl: registryEntry?.websiteUrl || null,
    version: actualVersion,
    releaseIdentity: {
      SOURCE_VERSION: actualVersion,
      GITHUB_RELEASE_VERSION: githubReleaseVersion,
      NPM_PUBLISHED_VERSION: npmPublishedVersion,
      NPM_LATEST_VERSION: npmLatestVersion,
      WEBSITE_DEPLOYED_VERSION: liveWebsiteVersionDetected,
      RUNTIME_VERSION: runtimeVersion,
    },
    registryCount: OPEN_SOURCE_RELEASE_REGISTRY.length,
    checks,
    errorsCount: errors.length,
    warningsCount: warnings.length,
    findings,
  };
}
