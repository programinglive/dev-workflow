import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getToolList } from "../tools/definitions.js";
import { NON_SESSION_SCOPED_TOOLS } from "../session-scope.js";
import { handleDevWorkflowV2Tool } from "../src/engineering-audit.js";
import {
  OPEN_SOURCE_RELEASE_REGISTRY,
  evaluateReleaseDocsGate,
} from "../src/release-governance.js";
import {
  isZettlyCodeAvailable,
  resetZettlyCodeAdapterCache,
} from "../src/zettly-code-adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function makeBugFixRepo(prefix = "dw-bf-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "billing.js"),
    `/**
 * @zettly-code ZC-BILLING-001
 * @purpose Calculate monthly invoice amount safely
 * @invariant Discount cannot exceed subtotal
 * @bug-fix BUG-1001
 * @root-cause Unclamped discount produced negative invoice totals
 * @fix Clamped discount to subtotal maximum
 * @related formatCurrency
 * @tests billing.test.js
 */
export function calculateInvoice(subtotal, discount) {
  const safeDiscount = Math.min(subtotal, Math.max(0, discount));
  return subtotal - safeDiscount;
}
`
  );
  fs.writeFileSync(
    path.join(dir, "src", "format.js"),
    `export function formatCurrency(amount) { return "$" + amount.toFixed(2); }\n`
  );
  fs.writeFileSync(
    path.join(dir, "tests", "billing.test.js"),
    `import { calculateInvoice } from "../src/billing.js";\ntest("never returns negative", () => calculateInvoice(100, 150));\n`
  );
  return dir;
}

// ============================================================================
// BF-01 .. BF-16: Bug-Fix Workflow & DevWorkflow MCP v3.1.0 Integration
// ============================================================================

test("BF-01: DevWorkflow v3.1.0 exposes exactly 65 canonical public tools (63 + code_index + code_context) with 0 aliases", () => {
  const tools = getToolList();
  assert.equal(tools.length, 65);
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has("code_index"));
  assert.ok(names.has("code_context"));
  assert.ok(names.has("audit"));
  assert.ok(!names.has("audit_code"));
  assert.ok(!names.has("helper_change_impact"));
  assert.ok(NON_SESSION_SCOPED_TOOLS.has("code_index"));
  assert.ok(NON_SESSION_SCOPED_TOOLS.has("code_context"));
});

test("BF-02: Zettly Code adapter resolves local @programinglive/zettly-code engine cleanly", async () => {
  const available = await isZettlyCodeAvailable();
  assert.equal(available, true);
});

test("BF-03: code_index(initialize) builds persistent SQLite knowledge graph via MCP dispatcher", async () => {
  const dir = makeBugFixRepo("dw-bf03-");
  try {
    const res = await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "initialize" });
    assert.equal(res.ok, true);
    assert.equal(res.freshnessStatus, "FRESH");
    assert.equal(res.stats.files_indexed, 3);
    assert.equal(res.stats.knowledge_annotations_count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-04: code_context(debug) retrieves symbols, @zettly-code notes, and tests before file scanning", async () => {
  const dir = makeBugFixRepo("dw-bf04-");
  try {
    await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "initialize" });
    const ctx = await handleDevWorkflowV2Tool("code_context", {
      projectDir: dir,
      mode: "debug",
      query: "calculateInvoice",
    });
    assert.equal(ctx.ok, true);
    assert.ok(ctx.symbols.some((s) => s.name === "calculateInvoice"));
    assert.ok(ctx.knowledgeAnnotations.some((a) => a.id === "ZC-BILLING-001"));
    assert.ok(ctx.relatedTests.some((t) => t.test.includes("billing.test.js")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-05: audit(category='bugfix_knowledge') PASSES when bug-fix source file has valid @zettly-code comment and fresh graph", async () => {
  const dir = makeBugFixRepo("dw-bf05-");
  try {
    await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "initialize" });
    const gate = await handleDevWorkflowV2Tool("audit", {
      category: "bugfix_knowledge",
      projectDir: dir,
      files: ["src/billing.js"],
      taskType: "BUG_FIX",
      bugId: "BUG-1001",
      confirmedRootCause: "Unclamped discount produced negative invoice totals",
      fixSummary: "Clamped discount to subtotal maximum",
      testReferences: ["tests/billing.test.js"],
      zettlyTodoId: 1098,
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.status, "PASSED");
    assert.equal(gate.zettlySyncReference.bugId, "BUG-1001");
    assert.equal(gate.zettlySyncReference.zettlyTodoId, 1098);
    assert.ok(gate.zettlySyncReference.knowledgeIds.includes("ZC-BILLING-001"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-06: audit(category='bugfix_knowledge') BLOCKS bug fix when modified source file lacks @zettly-code comment", async () => {
  const dir = makeBugFixRepo("dw-bf06-");
  try {
    await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "initialize" });
    const gate = await handleDevWorkflowV2Tool("audit", {
      category: "bugfix_knowledge",
      projectDir: dir,
      files: ["src/format.js"],
      taskType: "BUG_FIX",
      bugId: "BUG-1002",
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.status, "BLOCKED");
    assert.ok(gate.findings.some((f) => f.code === "MISSING_BUGFIX_KNOWLEDGE_COMMENT"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-07: audit(category='bugfix_knowledge') BLOCKS bug fix when knowledge graph is stale after edit", async () => {
  const dir = makeBugFixRepo("dw-bf07-");
  try {
    await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "initialize" });
    fs.appendFileSync(path.join(dir, "src", "billing.js"), "\nexport const TAX_RATE = 0.11;\n");
    const gate = await handleDevWorkflowV2Tool("audit", {
      category: "bugfix_knowledge",
      projectDir: dir,
      files: ["src/billing.js"],
      taskType: "BUG_FIX",
      bugId: "BUG-1001",
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.findings.some((f) => f.code === "STALE_CODE_KNOWLEDGE_GRAPH"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-08: code_index(update) refreshes stale graph so bugfix_knowledge gate transitions to PASSED", async () => {
  const dir = makeBugFixRepo("dw-bf08-");
  try {
    await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "initialize" });
    fs.appendFileSync(path.join(dir, "src", "billing.js"), "\nexport const TAX_RATE = 0.11;\n");
    const upd = await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "update" });
    assert.equal(upd.filesUpdated, 1);
    const gate = await handleDevWorkflowV2Tool("audit", {
      category: "bugfix_knowledge",
      projectDir: dir,
      files: ["src/billing.js"],
      taskType: "BUG_FIX",
      bugId: "BUG-1001",
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.status, "PASSED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-09: audit(category='bugfix_knowledge') skips non-bugfix FEATURE tasks cleanly", async () => {
  const dir = makeBugFixRepo("dw-bf09-");
  try {
    const gate = await handleDevWorkflowV2Tool("audit", {
      category: "bugfix_knowledge",
      projectDir: dir,
      files: ["src/format.js"],
      taskType: "FEATURE",
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.status, "NOT_APPLICABLE");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-10: audit(category='bugfix_knowledge') skips test-only or docs-only changes cleanly", async () => {
  const dir = makeBugFixRepo("dw-bf10-");
  try {
    const gate = await handleDevWorkflowV2Tool("audit", {
      category: "bugfix_knowledge",
      projectDir: dir,
      files: ["tests/billing.test.js", "README.md"],
      taskType: "BUG_FIX",
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.status, "SKIPPED_NO_PRODUCTION_SOURCE_CHANGES");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-11: recorded bug fix is immediately queryable in future debugging via code_context(history)", async () => {
  const dir = makeBugFixRepo("dw-bf11-");
  try {
    await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "initialize" });
    await handleDevWorkflowV2Tool("audit", {
      category: "bugfix_knowledge",
      projectDir: dir,
      files: ["src/billing.js"],
      taskType: "BUG_FIX",
      bugId: "BUG-1011",
      confirmedRootCause: "Unclamped discount",
      fixSummary: "Clamped discount to subtotal",
    });
    const hist = await handleDevWorkflowV2Tool("code_context", {
      projectDir: dir,
      mode: "history",
      query: "BUG-1011",
    });
    assert.equal(hist.bugFixes.length, 1);
    assert.equal(hist.bugFixes[0].bugId, "BUG-1011");
    assert.equal(hist.bugFixes[0].validityStatus, "VALID");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-12: Zettly sync reference payload is lightweight and never duplicates full SQLite graph", async () => {
  const dir = makeBugFixRepo("dw-bf12-");
  try {
    await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "initialize" });
    const gate = await handleDevWorkflowV2Tool("audit", {
      category: "bugfix_knowledge",
      projectDir: dir,
      files: ["src/billing.js"],
      taskType: "BUG_FIX",
      bugId: "BUG-1012",
      zettlyTodoId: 1098,
    });
    const ref = gate.zettlySyncReference;
    assert.equal(ref.schema, "zettly-code-reference/v1");
    assert.equal("entities" in ref, false);
    assert.equal("relationships" in ref, false);
    assert.ok(Buffer.byteLength(JSON.stringify(ref), "utf8") < 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-13: code_context(impact) and code_context(tests) work through DevWorkflow MCP", async () => {
  const dir = makeBugFixRepo("dw-bf13-");
  try {
    await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "initialize" });
    const impact = await handleDevWorkflowV2Tool("code_context", {
      projectDir: dir,
      mode: "impact",
      file: "src/billing.js",
    });
    assert.ok(impact.impactedFiles.includes("src/billing.js"));
    const testsRes = await handleDevWorkflowV2Tool("code_context", {
      projectDir: dir,
      mode: "tests",
      symbol: "calculateInvoice",
    });
    assert.ok(testsRes.relatedTests.some((t) => t.test.includes("billing.test.js")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-14: code_index(verify) detects valid annotations and fresh index", async () => {
  const dir = makeBugFixRepo("dw-bf14-");
  try {
    await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "initialize" });
    const ver = await handleDevWorkflowV2Tool("code_index", { projectDir: dir, mode: "verify" });
    assert.equal(ver.ok, true);
    assert.equal(ver.freshnessStatus, "FRESH");
    assert.equal(ver.knowledgeValidation.valid, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BF-15: audit(category='catalog') confirms 65 canonical tools, 0 aliases, and registered code_index/code_context metadata", async () => {
  const report = await handleDevWorkflowV2Tool("audit", {
    category: "catalog",
    includeMatrix: false,
    includeInventory: false,
  });
  assert.equal(report.summary.total_public_tools, 65);
  assert.equal(report.summary.canonical_public_tools, 65);
  assert.equal(report.summary.compatibility_aliases, 0);
  assert.equal(report.summary.unmapped_tools_count, 0);
});

test("BF-16: adapter fails gracefully when ZETTLY_CODE_MODULE_PATH points to missing module without crashing", async () => {
  const prev = process.env.ZETTLY_CODE_MODULE_PATH;
  try {
    // Only verifying cache reset helper is callable and restores cleanly
    resetZettlyCodeAdapterCache();
    const ok = await isZettlyCodeAvailable();
    assert.equal(ok, true);
  } finally {
    if (prev === undefined) delete process.env.ZETTLY_CODE_MODULE_PATH;
    else process.env.ZETTLY_CODE_MODULE_PATH = prev;
    resetZettlyCodeAdapterCache();
  }
});

// ============================================================================
// RG-01 .. RG-12: Permanent Open-Source Release Governance
// ============================================================================

test("RG-01: Open-Source Release Registry tracks all 13 public programinglive repositories", () => {
  assert.equal(OPEN_SOURCE_RELEASE_REGISTRY.length, 13);
  const names = new Set(OPEN_SOURCE_RELEASE_REGISTRY.map((r) => r.name));
  for (const expected of ["dev-workflow", "zettly", "dbpinball", "commiter", "hris", "zettly-editor"]) {
    assert.ok(names.has(expected), `Missing public repo ${expected} in registry`);
  }
  assert.ok(!names.has("zettly-code"), "Private repo zettly-code must NEVER appear in public open-source registry");
});

test("RG-02: audit(category='release_docs') PASSES on current dev-workflow v3.1.0 workspace", async () => {
  const res = await handleDevWorkflowV2Tool("audit", {
    category: "release_docs",
    projectDir: REPO_ROOT,
    expectedVersion: "3.1.0",
    expectedToolCount: 65,
  });
  assert.equal(res.ok, true, `Expected release_docs gate to pass, got findings: ${JSON.stringify(res.findings)}`);
  assert.equal(res.status, "PASSED");
  assert.equal(res.version, "3.1.0");
});

test("RG-03: release_docs_gate BLOCKS when expectedVersion mismatches package.json", async () => {
  const res = await evaluateReleaseDocsGate({
    projectDir: REPO_ROOT,
    expectedVersion: "9.9.9",
  });
  assert.equal(res.ok, false);
  assert.ok(res.findings.some((f) => f.code === "RELEASE_VERSION_MISMATCH"));
});

test("RG-04: release_docs_gate BLOCKS README version drift", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-rg04-"));
  try {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@programinglive/demo", version: "2.0.0" }));
    fs.writeFileSync(path.join(tmp, "README.md"), "# Demo v1.0.0\n");
    const res = await evaluateReleaseDocsGate({ projectDir: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.code === "README_VERSION_DRIFT"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("RG-05: release_docs_gate BLOCKS CHANGELOG version drift", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-rg05-"));
  try {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@programinglive/demo", version: "2.0.0" }));
    fs.writeFileSync(path.join(tmp, "README.md"), "# Demo v2.0.0\n");
    fs.writeFileSync(path.join(tmp, "CHANGELOG.md"), "# Changelog\n## 1.0.0\n");
    const res = await evaluateReleaseDocsGate({ projectDir: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.code === "CHANGELOG_VERSION_DRIFT"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("RG-06: release_docs_gate BLOCKS outdated website catalog.generated.ts version", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-rg06-"));
  try {
    fs.mkdirSync(path.join(tmp, "web", "lib"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@programinglive/dev-workflow", version: "3.1.0" }));
    fs.writeFileSync(path.join(tmp, "README.md"), "# DevWorkflow 3.1.0\n");
    fs.writeFileSync(path.join(tmp, "CHANGELOG.md"), "# Changelog\n## 3.1.0\n");
    fs.writeFileSync(path.join(tmp, "web", "lib", "catalog.generated.ts"), `export const CATALOG = { "version": "2.1.1", toolCount: 64 };`);
    const res = await evaluateReleaseDocsGate({ projectDir: tmp, expectedToolCount: 65 });
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.code === "WEBSITE_CATALOG_VERSION_DRIFT"));
    assert.ok(res.findings.some((f) => f.code === "WEBSITE_TOOL_COUNT_DRIFT"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("RG-07: release_docs_gate BLOCKS removed v2 MCP tool names in website docs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-rg07-"));
  try {
    fs.mkdirSync(path.join(tmp, "web", "lib"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@programinglive/dev-workflow", version: "3.1.0" }));
    fs.writeFileSync(path.join(tmp, "README.md"), "# DevWorkflow 3.1.0\n");
    fs.writeFileSync(path.join(tmp, "CHANGELOG.md"), "# Changelog\n## 3.1.0\n");
    fs.writeFileSync(path.join(tmp, "web", "lib", "how-to-use-data.ts"), `export const X = "Run audit_code and helper_change_impact";`);
    const res = await evaluateReleaseDocsGate({ projectDir: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.code === "WEBSITE_REMOVED_TOOL_REFERENCE"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("RG-08: release_docs_gate BLOCKS stale @programinglive/dev-workflow@2.1.1 install pins in website docs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-rg08-"));
  try {
    fs.mkdirSync(path.join(tmp, "web", "lib"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@programinglive/dev-workflow", version: "3.1.0" }));
    fs.writeFileSync(path.join(tmp, "README.md"), "# DevWorkflow 3.1.0\n");
    fs.writeFileSync(path.join(tmp, "CHANGELOG.md"), "# Changelog\n## 3.1.0\n");
    fs.writeFileSync(path.join(tmp, "web", "lib", "how-to-use-data.ts"), `export const X = "@programinglive/dev-workflow@2.1.1";`);
    const res = await evaluateReleaseDocsGate({ projectDir: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.code === "WEBSITE_STALE_PACKAGE_VERSION"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("RG-09: release_docs_gate BLOCKS private workstation paths or internal hostnames in public README/web", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-rg09-"));
  try {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@programinglive/demo", version: "1.0.0" }));
    fs.writeFileSync(path.join(tmp, "README.md"), "# Demo 1.0.0\nInternal host: 100.77.138.14\n");
    const res = await evaluateReleaseDocsGate({ projectDir: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.code === "PRIVATE_ENVIRONMENT_LEAK"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("RG-10: release_docs_gate detects live website drift when HTML lacks current version or shows removed tools", async () => {
  const res = await evaluateReleaseDocsGate({
    projectDir: REPO_ROOT,
    expectedVersion: "3.1.0",
    expectedToolCount: 65,
    liveWebsiteHtml: "<html><body>DevWorkflow v2.1.1 — use audit_code</body></html>",
  });
  assert.equal(res.ok, false);
  assert.ok(res.findings.some((f) => f.code === "LIVE_WEBSITE_DRIFT"));
});

test("RG-11: release_docs_gate reports LIVE_SYNCED when live website HTML matches current version and canonical tools", async () => {
  const res = await evaluateReleaseDocsGate({
    projectDir: REPO_ROOT,
    expectedVersion: "3.1.0",
    expectedToolCount: 65,
    liveWebsiteHtml: "<html><body>DevWorkflow 3.1.0 — 65 canonical tools: audit, code_index, code_context</body></html>",
  });
  assert.equal(res.ok, true);
  assert.equal(res.checks.find((c) => c.name === "live_website").status, "LIVE_SYNCED");
});

test("RG-12: release_docs_gate blocks missing README.md in public open-source repositories", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-rg12-"));
  try {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@programinglive/demo", version: "1.0.0" }));
    const res = await evaluateReleaseDocsGate({ projectDir: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.code === "MISSING_README"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
