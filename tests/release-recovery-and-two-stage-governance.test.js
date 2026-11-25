import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getToolList } from "../tools/definitions.js";
import { REMOVED_LEGACY_TOOLS } from "../src/tool-catalog-auditor.js";
import {
  OPEN_SOURCE_RELEASE_REGISTRY,
  evaluateReleaseDocsGate,
} from "../src/release-governance.js";
import { handleDevWorkflowV2Tool } from "../src/engineering-audit.js";
const TOOL_COUNT = getToolList().length;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const PKG_VERSION = PKG.version;

// ============================================================================
// RV-01 .. RV-10: Version, Registry & Two-Stage Release Identity
// ============================================================================

test("RV-01..RV-05: Canonical release state model separates SOURCE, GITHUB, NPM_PUBLISHED, NPM_LATEST, WEBSITE, and RUNTIME versions", async () => {
  const res = await evaluateReleaseDocsGate({
    projectDir: REPO_ROOT,
    stage: "both",
    expectedVersion: PKG_VERSION,
    expectedToolCount: TOOL_COUNT,
    githubReleaseVersion: `v${PKG_VERSION}`,
    npmPublishedVersion: PKG_VERSION,
    npmLatestVersion: PKG_VERSION,
    runtimeVersion: PKG_VERSION,
    liveWebsiteHtml: `<html><body>DevWorkflow ${PKG_VERSION} — TOOL_COUNT Canonical MCP Tools</body></html>`,
  });
  assert.equal(res.ok, true);
  assert.equal(res.stageVerdict, "POST_PUBLISH_PASS");
  assert.equal(res.releaseIdentity.SOURCE_VERSION, PKG_VERSION);
  assert.equal(res.releaseIdentity.GITHUB_RELEASE_VERSION, `v${PKG_VERSION}`);
  assert.equal(res.releaseIdentity.NPM_PUBLISHED_VERSION, PKG_VERSION);
  assert.equal(res.releaseIdentity.NPM_LATEST_VERSION, PKG_VERSION);
  assert.equal(res.releaseIdentity.WEBSITE_DEPLOYED_VERSION, PKG_VERSION);
  assert.equal(res.releaseIdentity.RUNTIME_VERSION, PKG_VERSION);
});

test("RV-06..RV-10: Unpublished npm version or stale latest dist-tag fails post-publish verification without passing falsely", async () => {
  const unpublished = await evaluateReleaseDocsGate({
    projectDir: REPO_ROOT,
    stage: "post_publish",
    expectedVersion: PKG_VERSION,
    githubReleaseVersion: `v${PKG_VERSION}`,
    npmPublishedVersion: null,
    npmLatestVersion: "2.1.1",
    liveWebsiteHtml: `<html><body>DevWorkflow ${PKG_VERSION}</body></html>`,
  });
  assert.equal(unpublished.ok, false);
  assert.equal(unpublished.stageVerdict, "POST_PUBLISH_FAIL");
  assert.ok(unpublished.findings.some((f) => f.code === "NPM_PUBLISHED_VERSION_DRIFT"));
  assert.ok(unpublished.findings.some((f) => f.code === "NPM_LATEST_TAG_DRIFT"));

  // Pre-publish never circularly requires an unpublished npm version
  const pre = await evaluateReleaseDocsGate({
    projectDir: REPO_ROOT,
    stage: "pre_publish",
    expectedVersion: PKG_VERSION,
    expectedToolCount: TOOL_COUNT,
  });
  assert.equal(pre.ok, true);
  assert.equal(pre.stageVerdict, "PRE_PUBLISH_PASS");
});

// ============================================================================
// WEB-01 .. WEB-18: Website, Onboarding, Tutorials & Catalog Single Source of Truth
// ============================================================================

test("WEB-01..WEB-12: Active website source & runtime catalog contain current version, TOOL_COUNT tools, Zettly Code journey, and ZERO active removed v2 tool names", () => {
  const tools = getToolList();
  assert.equal(tools.length, TOOL_COUNT);
  const removedNames = Object.keys(REMOVED_LEGACY_TOOLS);

  // Runtime tool descriptions must not advertise removed v2 tool names
  for (const t of tools) {
    for (const removed of removedNames) {
      assert.equal(
        new RegExp(`\\b${removed}\\b`).test(t.description || ""),
        false,
        `Active tool '${t.name}' description still mentions removed v2 tool '${removed}'`
      );
    }
  }

  const catalog = fs.readFileSync(path.join(REPO_ROOT, "web", "lib", "catalog.generated.ts"), "utf8");
  assert.ok(catalog.includes(`"version": "${PKG_VERSION}"`));
  assert.ok(catalog.includes(`"mcpToolCount": TOOL_COUNT`));

  const howTo = fs.readFileSync(path.join(REPO_ROOT, "web", "lib", "how-to-use-data.ts"), "utf8");
  assert.ok(howTo.includes(`@programinglive/dev-workflow@${PKG_VERSION}`));
  assert.ok(howTo.includes(`"toolsDiscovered": TOOL_COUNT`));
  assert.ok(howTo.includes("ZETTLY_CODE_DEBUGGING_JOURNEY"));
  assert.ok(howTo.includes("code_context"));
  assert.ok(howTo.includes("code_index"));

  const useCases = fs.readFileSync(path.join(REPO_ROOT, "web", "lib", "use-cases-data.ts"), "utf8");
  for (const removed of removedNames) {
    assert.equal(new RegExp(`\\b${removed}\\b`).test(howTo), false, `how-to-use-data.ts references removed tool '${removed}'`);
    assert.equal(new RegExp(`\\b${removed}\\b`).test(useCases), false, `use-cases-data.ts references removed tool '${removed}'`);
  }

  const hero = fs.readFileSync(path.join(REPO_ROOT, "web", "components", "Hero.tsx"), "utf8");
  assert.ok(hero.includes("GENERATED_CATALOG.mcpToolCount"));
  assert.ok(hero.includes("Node 20+"));
});

test("WEB-13..WEB-18: GitHub Actions release and web deploy workflows invoke release governance and live route checks", () => {
  const ghRel = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "github-release.yml"), "utf8");
  assert.ok(ghRel.includes("evaluateReleaseDocsGate"));
  assert.ok(ghRel.includes('stage: "pre_publish"'));

  const webDeploy = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "deploy-web.yml"), "utf8");
  assert.ok(webDeploy.includes("/how-to-use/"));
  assert.ok(webDeploy.includes("/use-cases/"));
  assert.ok(webDeploy.includes("/docs/"));
  assert.ok(webDeploy.includes("audit_code"));
});

// ============================================================================
// RG-06..RG-16 & Controlled End-to-End Two-Stage Release Pipeline Test
// ============================================================================

test("E2E Release Pipeline: detects README drift -> fixes -> PRE_PUBLISH_PASS -> detects stale live website (RELEASE_PUBLISHED_BUT_NOT_FULLY_VERIFIED) -> POST_PUBLISH_PASS", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-e2e-rel-"));
  try {
    fs.mkdirSync(path.join(tmp, "web", "lib"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@programinglive/dev-workflow", version: "4.0.0" }));
    fs.writeFileSync(path.join(tmp, "README.md"), "# DevWorkflow 3.0.0\n");
    fs.writeFileSync(path.join(tmp, "CHANGELOG.md"), "# Changelog\n## 3.0.0\n");
    fs.writeFileSync(path.join(tmp, "web", "lib", "catalog.generated.ts"), `export const C = { "version": "3.0.0", toolCount: 64 };`);

    // Step 1: Pre-publish gate detects README + CHANGELOG + website catalog drift
    const step1 = await handleDevWorkflowV2Tool("audit", {
      category: "release_docs",
      projectDir: tmp,
      stage: "pre_publish",
      expectedVersion: "4.0.0",
      expectedToolCount: TOOL_COUNT,
    });
    assert.equal(step1.ok, false);
    assert.equal(step1.stageVerdict, "PRE_PUBLISH_FAIL");
    assert.ok(step1.findings.some((f) => f.code === "README_VERSION_DRIFT"));
    assert.ok(step1.findings.some((f) => f.code === "CHANGELOG_VERSION_DRIFT"));
    assert.ok(step1.findings.some((f) => f.code === "WEBSITE_CATALOG_VERSION_DRIFT"));

    // Step 2: Repair docs and rebuild website catalog -> PRE_PUBLISH_PASS
    fs.writeFileSync(path.join(tmp, "README.md"), "# DevWorkflow 4.0.0\n");
    fs.writeFileSync(path.join(tmp, "CHANGELOG.md"), "# Changelog\n## 4.0.0\n");
    fs.writeFileSync(path.join(tmp, "web", "lib", "catalog.generated.ts"), `export const C = { "version": "4.0.0", toolCount: TOOL_COUNT };`);
    const step2 = await handleDevWorkflowV2Tool("audit", {
      category: "release_docs",
      projectDir: tmp,
      stage: "pre_publish",
      expectedVersion: "4.0.0",
      expectedToolCount: TOOL_COUNT,
    });
    assert.equal(step2.ok, true);
    assert.equal(step2.stageVerdict, "PRE_PUBLISH_PASS");

    // Step 3: Published to GitHub & npm, but live website is still stale -> RELEASE_PUBLISHED_BUT_NOT_FULLY_VERIFIED
    const step3 = await handleDevWorkflowV2Tool("audit", {
      category: "release_docs",
      projectDir: tmp,
      stage: "post_publish",
      expectedVersion: "4.0.0",
      githubReleaseVersion: "v4.0.0",
      npmPublishedVersion: "4.0.0",
      npmLatestVersion: "4.0.0",
      runtimeVersion: "4.0.0",
      liveWebsiteHtml: "<html><body>DevWorkflow v3.0.0</body></html>",
    });
    assert.equal(step3.ok, false);
    assert.equal(step3.stageVerdict, "RELEASE_PUBLISHED_BUT_NOT_FULLY_VERIFIED");

    // Step 4: Live website deployed and verified -> POST_PUBLISH_PASS
    const step4 = await handleDevWorkflowV2Tool("audit", {
      category: "release_docs",
      projectDir: tmp,
      stage: "post_publish",
      expectedVersion: "4.0.0",
      githubReleaseVersion: "v4.0.0",
      npmPublishedVersion: "4.0.0",
      npmLatestVersion: "4.0.0",
      runtimeVersion: "4.0.0",
      liveWebsiteHtml: "<html><body>DevWorkflow 4.0.0 — TOOL_COUNT Canonical MCP Tools</body></html>",
    });
    assert.equal(step4.ok, true);
    assert.equal(step4.stageVerdict, "POST_PUBLISH_PASS");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("RG-05: Projects without websites (e.g. commiter, ci-cd) pass post-publish without requiring website HTML", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-rg-noweb-"));
  try {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@programinglive/commiter", version: "1.6.0" }));
    fs.writeFileSync(path.join(tmp, "README.md"), "# Commiter 1.6.0\n");
    const res = await evaluateReleaseDocsGate({
      projectDir: tmp,
      repoName: "commiter",
      stage: "both",
      expectedVersion: "1.6.0",
      githubReleaseVersion: "v1.6.0",
      npmPublishedVersion: "1.6.0",
      npmLatestVersion: "1.6.0",
    });
    assert.equal(res.ok, true);
    assert.equal(res.stageVerdict, "POST_PUBLISH_PASS");
    assert.ok(OPEN_SOURCE_RELEASE_REGISTRY.some((r) => r.name === "commiter" && r.websiteUrl === null));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
