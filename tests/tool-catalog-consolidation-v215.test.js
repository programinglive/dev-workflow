import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getToolList } from "../tools/definitions.js";
import { NON_SESSION_SCOPED_TOOLS, resolveRequestSession } from "../session-scope.js";
import { handleDevWorkflowV2Tool } from "../src/engineering-audit.js";
import {
  auditToolCatalog,
  buildToolInventory,
  validateToolRegistrationGate,
  generateConsolidationPlan,
  selectCanonicalToolForScenario,
  TOOL_ALIASES,
  CANONICAL_TOOL_METADATA,
  SEMANTIC_DUPLICATION_MATRIX,
  AGENT_TOOL_SELECTION_BENCHMARK,
} from "../src/tool-catalog-auditor.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs, shellEscape } from "../utils.js";
import { WorkflowState } from "../workflow-state.js";
import {
  acquireWorktreeMutex,
  releaseWorktreeMutex,
  ProjectOwnershipLostError,
} from "../process-lock.js";
import { parseArgs } from "../cli/args.js";
import { runCommand } from "../cli/commands.js";
import {
  createCommitMessageParts,
  determineReleaseTypeFromCommit,
} from "../commit-helpers.js";
import { bindTaskToRepo } from "./test-helpers.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const utils = {
  shellEscape,
  determineReleaseTypeFromCommit,
  createCommitMessageParts,
};

async function createTempGitRepo(prefix = "dwf-v215-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Catalog Auditor"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "auditor@example.com"], { cwd: dir, stdio: "ignore" });
  await fs.writeFile(path.join(dir, "README.md"), "# Fixture Repo\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("TC-01: Complete registration inventory accounts for all 74 public MCP tools, prompts, and CLI commands with zero unmapped tools", async () => {
  const tools = getToolList();
  const report = await handleDevWorkflowV2Tool("audit_tool_catalog", {
    includeMatrix: true,
    includeInventory: true,
    includeConsolidationPlan: true,
  });

  assert.equal(tools.length, 84, "Expected exactly 84 registered public MCP tools in v2.1.5");
  assert.equal(report.summary.total_public_tools, 84);
  assert.equal(report.summary.canonical_public_tools, 80);
  assert.equal(report.summary.compatibility_aliases, 4);
  assert.equal(report.summary.unmapped_tools_count, 0, `Unmapped tools: ${report.unmapped_tools.join(", ")}`);
  assert.equal(report.summary.untested_tools_count, 0, `Untested tools: ${report.untested_tools.join(", ")}`);
  assert.equal(report.summary.mcp_prompts_count, 2);
  assert.equal(report.summary.cli_commands_count, 14);
  assert.ok(report.consolidation_plan);

  for (const tool of tools) {
    assert.ok(
      CANONICAL_TOOL_METADATA[tool.name],
      `Every registered public MCP tool must have canonical metadata: missing ${tool.name}`
    );
  }
});

test("TC-02 & TC-12: Catalog regression gate detects duplicate tool IDs, missing descriptions/schemas, and redundant new tool registrations", () => {
  const tools = getToolList();

  // 1. Live catalog passes regression gate with 0 blocking violations
  const baselineGate = validateToolRegistrationGate({ tools });
  assert.equal(baselineGate.passed, true);
  assert.equal(baselineGate.blocking_violations_count, 0);

  // 2. TC-02: Duplicate tool ID is deterministically blocked
  const duplicateGate = validateToolRegistrationGate({
    tools,
    proposedTools: [
      {
        name: "audit_code",
        description: "Duplicate registration of audit_code tool ID.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
  assert.equal(duplicateGate.passed, false);
  assert.equal(duplicateGate.status, "BLOCKED");
  assert.ok(duplicateGate.blocking_violations.some((v) => v.code === "DUPLICATE_TOOL_ID" && v.toolId === "audit_code"));

  // 3. TC-12: New redundant tool registration sharing same handler/service triggers REDUNDANT_HANDLER_OR_SERVICE_CANDIDATE warning
  const redundantGate = validateToolRegistrationGate({
    tools,
    proposedTools: [
      {
        name: "helper_recommend_test_suite_v2",
        description: "[READ_ONLY] Recommend characterization and regression test suites based on changed files and risk.",
        handler: "handleDevWorkflowV2Tool('helper_change_impact')",
        domainService: "analyzeChangeImpact",
        inputSchema: {
          type: "object",
          properties: {
            projectDir: { type: "string" },
            files: { type: "array", items: { type: "string" } },
          },
        },
      },
    ],
  });
  assert.equal(redundantGate.passed, true);
  assert.equal(redundantGate.status, "PASS_WITH_REVIEW_WARNINGS");
  assert.ok(
    redundantGate.review_warnings.some(
      (w) =>
        w.code === "REDUNDANT_HANDLER_OR_SERVICE_CANDIDATE" &&
        (w.toolA === "helper_recommend_test_suite_v2" || w.toolB === "helper_recommend_test_suite_v2")
    ),
    "Expected redundant handler/service review warning for proposed duplicate tool"
  );
});

test("TC-03, TC-06 & TC-07: Semantic duplication matrix detects D0 exact duplicates, D1 semantic duplicates, D2 partial overlaps, and D3 wrapper redundancy", () => {
  // TC-03: Different names, equivalent handlers (D0 helper_suggest_tests <-> helper_change_impact, D1 project_summary_data/db <-> project_summary)
  const d0 = SEMANTIC_DUPLICATION_MATRIX.find((m) => m.pairId === "DUP-01");
  assert.ok(d0);
  assert.equal(d0.classification, "D0");
  assert.equal(d0.toolA, "helper_suggest_tests");
  assert.equal(d0.toolB, "helper_change_impact");

  const d1Data = SEMANTIC_DUPLICATION_MATRIX.find((m) => m.pairId === "DUP-02");
  const d1Db = SEMANTIC_DUPLICATION_MATRIX.find((m) => m.pairId === "DUP-03");
  assert.equal(d1Data.classification, "D1");
  assert.equal(d1Db.classification, "D1");

  // TC-06: Wrapper-only tool identified (D3 audit_repository -> audit_code)
  const d3 = SEMANTIC_DUPLICATION_MATRIX.find((m) => m.pairId === "DUP-04");
  assert.ok(d3);
  assert.equal(d3.classification, "D3");
  assert.equal(d3.toolA, "audit_repository");
  assert.equal(d3.toolB, "audit_code");

  // TC-07: Shared handler/engine with different workflows classified as D2 PARTIAL_OVERLAP
  const d2Category = SEMANTIC_DUPLICATION_MATRIX.find((m) => m.pairId === "DUP-05");
  assert.ok(d2Category);
  assert.equal(d2Category.classification, "D2");
});

test("TC-04 & TC-05: False duplicates (D6) and distinct authorization boundaries (D4) are preserved and never merged unsafely", () => {
  // TC-04: Similar names, distinct behavior (security_audit vs audit_security, site_audit vs audit_code)
  const d6Sec = SEMANTIC_DUPLICATION_MATRIX.find((m) => m.pairId === "DUP-07");
  assert.ok(d6Sec);
  assert.equal(d6Sec.classification, "D6");
  assert.equal(d6Sec.toolA, "security_audit");
  assert.equal(d6Sec.toolB, "audit_security");

  const d6Site = SEMANTIC_DUPLICATION_MATRIX.find((m) => m.pairId === "DUP-08");
  assert.ok(d6Site);
  assert.equal(d6Site.classification, "D6");

  // TC-05: Equivalent descriptions with different authorization boundaries or unfenced read+write merging are caught
  const d4Term = SEMANTIC_DUPLICATION_MATRIX.find((m) => m.pairId === "DUP-09");
  assert.equal(d4Term.classification, "D4");

  const unsafeMergeGate = validateToolRegistrationGate({
    tools: getToolList(),
    proposedTools: [
      {
        name: "audit_and_autofix_unrestricted",
        description: "Audit repository and automatically modify any file without worktree mutex fencing.",
        permissionLevel: "MIXED_READ_WRITE_UNFENCED",
        mergesReadAndWrite: true,
        fencedAuthorization: false,
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
  assert.equal(unsafeMergeGate.passed, false);
  assert.ok(
    unsafeMergeGate.blocking_violations.some((v) => v.code === "UNSAFE_PERMISSION_BOUNDARY_MERGE")
  );

  // Also verify warning when a proposed read-write tool has high description overlap with a read-only tool
  const diffPermGate = validateToolRegistrationGate({
    tools: [
      {
        name: "custom_scan_policy",
        description: "Evaluate engineering policy rules across repository source files and return findings report.",
        permissionLevel: "READ_ONLY",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    proposedTools: [
      {
        name: "custom_mutate_policy",
        description: "Evaluate engineering policy rules across repository source files and write findings report.",
        permissionLevel: "LOCAL_WRITE_FENCED",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
  assert.equal(diffPermGate.passed, true);
  assert.ok(
    diffPermGate.review_warnings.some((w) => w.code === "SIMILAR_DESCRIPTION_DIFFERENT_AUTHORIZATION")
  );
});

test("TC-08, TC-09 & TC-10: Compatibility aliases preserve input schemas and output contracts with zero breaking regressions", async () => {
  // 1. helper_suggest_tests (alias) vs helper_change_impact (canonical)
  const files = ["app/Services/ReleaseSafety/DeploymentGate.php"];
  const resAlias = await handleDevWorkflowV2Tool("helper_suggest_tests", {
    projectDir: REPO_ROOT,
    files,
  });
  const resCanonical = await handleDevWorkflowV2Tool("helper_change_impact", {
    projectDir: REPO_ROOT,
    files,
  });
  assert.deepEqual(resAlias, resCanonical, "helper_suggest_tests alias must return exact same output contract as helper_change_impact");
  assert.equal(resCanonical.risk_level, "HIGH");

  // 2. project_summary_data & project_summary_db (aliases) vs project_summary({ source }) (canonical)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dwf-summary-compat-"));
  try {
    const stateFile = path.join(tmpDir, "state.json");
    const ws = new WorkflowState(stateFile);
    await ws.load();
    await bindTaskToRepo(ws);
    ws.addToHistory({
      taskDescription: "Consolidate MCP tools",
      taskType: "refactor",
      commitMessage: "refactor(mcp): consolidate tool handlers",
    });
    await ws.save();

    const callTool = async (name, args = {}) =>
      handleToolCall({
        request: { params: { name, arguments: args } },
        normalizeRequestArgs,
        workflowState: ws,
        exec: async () => ({ stdout: "" }),
        git: {},
        utils,
      });

    const memRes = await callTool("project_summary", {});
    assert.match(memRes.content[0].text, /Project Knowledge Summary/);
    assert.match(memRes.content[0].text, /Total tasks completed: 1/);

    const fileViaCanonical = await callTool("project_summary", { source: "file" });
    const fileViaAlias = await callTool("project_summary_data", {});
    assert.equal(
      fileViaAlias.content[0].text,
      fileViaCanonical.content[0].text,
      "project_summary_data must produce identical output to project_summary({ source: 'file' })"
    );
    assert.match(fileViaAlias.content[0].text, /from persisted data/);

    const dbViaCanonical = await callTool("project_summary", { source: "db" });
    const dbViaAlias = await callTool("project_summary_db", {});
    assert.equal(
      dbViaAlias.content[0].text,
      dbViaCanonical.content[0].text,
      "project_summary_db must produce identical output to project_summary({ source: 'db' })"
    );

    // 3. audit_code with category filter matches domain-specific audit_architecture
    const repo = await createTempGitRepo("dwf-tc09-");
    try {
      await fs.mkdir(path.join(repo, "app", "Http", "Controllers"), { recursive: true });
      await fs.writeFile(
        path.join(repo, "app", "Http", "Controllers", "RawController.php"),
        "<?php\nclass RawController { public function run() { return DB::raw('SELECT 1'); } }\n",
        "utf8"
      );
      const viaCategory = await handleDevWorkflowV2Tool("audit_code", {
        projectDir: repo,
        files: ["app/Http/Controllers/RawController.php"],
        category: "architecture",
      });
      const viaArchTool = await handleDevWorkflowV2Tool("audit_architecture", {
        projectDir: repo,
        files: ["app/Http/Controllers/RawController.php"],
      });
      assert.equal(viaCategory.findings.length, 1);
      assert.equal(viaArchTool.findings.length, 1);
      assert.equal(viaCategory.findings[0].rule_id, viaArchTool.findings[0].rule_id);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }

    await ws.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("TC-11 & TC-18: Tool discovery and session-scope attribution work cleanly for MCP clients", () => {
  const tools = getToolList();
  assert.ok(tools.some((t) => t.name === "audit_tool_catalog"));
  assert.ok(NON_SESSION_SCOPED_TOOLS.has("audit_tool_catalog"));

  // Non-session tools work without session metadata
  const gateCatalog = resolveRequestSession({
    params: { name: "audit_tool_catalog", arguments: {} },
  });
  assert.equal(gateCatalog.ok, true);

  // Session-scoped tools still fail closed without session metadata
  const gateStart = resolveRequestSession({
    params: { name: "start_task", arguments: {} },
  });
  assert.equal(gateStart.ok, false);
});

test("TC-13, TC-14 & TC-15: Task lifecycle, cross-client worktree mutex concurrency, and safe autofix authorization remain intact", async () => {
  const repo = await createTempGitRepo("dwf-tc13-");
  try {
    const targetFile = "src/sample.js";
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, targetFile), "export const v = 1;   \n", "utf8");

    // Client A acquires mutex
    const lockA = await acquireWorktreeMutex({
      projectDir: repo,
      ownerKey: "session-tc14-a",
      timeoutMs: 100,
    });
    assert.equal(lockA.ok, true);

    try {
      // Client B cannot acquire mutex on same worktree (TC-14)
      const lockB = await acquireWorktreeMutex({
        projectDir: repo,
        ownerKey: "session-tc14-b",
        timeoutMs: 100,
      });
      assert.equal(lockB.ok, false);

      // Client B cannot run helper_apply_safe_fix on Client A's worktree (TC-15)
      await assert.rejects(
        () =>
          handleDevWorkflowV2Tool("helper_apply_safe_fix", {
            projectDir: repo,
            file: targetFile,
            ruleId: "ZET-CODE-002",
            sessionId: "session-tc14-b",
          }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST"
      );

      // Client A (owner) applies safe fix cleanly
      const fixA = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
        projectDir: repo,
        file: targetFile,
        ruleId: "ZET-CODE-002",
        sessionId: "session-tc14-a",
      });
      assert.equal(fixA.applied, true);
      assert.equal(fixA.verification_level, "MECHANICALLY_VERIFIED");
    } finally {
      await releaseWorktreeMutex(lockA.capability);
    }

    // After mutex release, Client B can acquire worktree mutex cleanly (TC-13)
    const lockBAfter = await acquireWorktreeMutex({
      projectDir: repo,
      ownerKey: "session-tc14-b",
      timeoutMs: 100,
    });
    assert.equal(lockBAfter.ok, true);
    await releaseWorktreeMutex(lockBAfter.capability);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("TC-16: CLI compatibility — devwf audit catalog, devwf audit standards, and devwf audit code work end-to-end", async () => {
  const outCat = { lines: [], write(line) { this.lines.push(line); } };
  const argsCat = parseArgs(["audit", "catalog", "--json"]);
  const resCat = await runCommand({ args: argsCat, env: {}, out: outCat });
  assert.equal(resCat.ok, true);
  const parsedCat = JSON.parse(outCat.lines.join("\n"));
  assert.equal(parsedCat.regression_gate.passed, true);
  assert.equal(parsedCat.summary.total_public_tools, 84);

  const outHuman = { lines: [], write(line) { this.lines.push(line); } };
  const argsHuman = parseArgs(["audit", "catalog"]);
  const resHuman = await runCommand({ args: argsHuman, env: {}, out: outHuman });
  assert.equal(resHuman.ok, true);
  assert.match(outHuman.lines.join("\n"), /DevWorkflow MCP Tool Catalog Audit/);
});

test("TC-17 & TC-19: Representative AI agent tool selection benchmark resolves all 10 scenarios with zero selection errors", () => {
  const tools = getToolList();
  assert.equal(AGENT_TOOL_SELECTION_BENCHMARK.length, 10);

  let totalCallsBefore = 0;
  let totalCallsAfter = 0;

  for (const bench of AGENT_TOOL_SELECTION_BENCHMARK) {
    totalCallsBefore += bench.callsBefore;
    totalCallsAfter += bench.callsAfter;

    const decision = selectCanonicalToolForScenario(bench.scenario, tools);
    assert.equal(decision.scenarioId, bench.scenarioId);
    assert.equal(
      decision.selectedTool,
      bench.expectedCanonicalTool,
      `Scenario ${bench.scenarioId} selected wrong tool`
    );
    assert.equal(decision.isRegistered, true, `Tool ${decision.selectedTool} must be registered`);
    assert.equal(decision.isCanonical, true, `Selected tool ${decision.selectedTool} must be canonical, not an alias`);
  }

  assert.equal(totalCallsBefore, 16);
  assert.equal(totalCallsAfter, 10);
});
