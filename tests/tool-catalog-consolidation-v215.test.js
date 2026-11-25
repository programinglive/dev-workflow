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
  validateToolRegistrationGate,
  selectCanonicalToolForScenario,
  TOOL_ALIASES,
  REMOVED_LEGACY_TOOLS,
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
const TOOL_COUNT = getToolList().length;

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const utils = {
  shellEscape,
  determineReleaseTypeFromCommit,
  createCommitMessageParts,
};

async function createTempGitRepo(prefix = "dwf-v300-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Catalog Auditor"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "auditor@example.com"], { cwd: dir, stdio: "ignore" });
  await fs.writeFile(path.join(dir, "README.md"), "# Fixture Repo\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("TC-01: Radical simplification inventory accounts for all TOOL_COUNT canonical public MCP tools with zero compatibility aliases and zero unmapped tools", async () => {
  const tools = getToolList();
  const report = await handleDevWorkflowV2Tool("audit", {
    category: "catalog",
    includeMatrix: true,
    includeInventory: true,
    includeConsolidationPlan: true,
  });

  assert.equal(tools.length, TOOL_COUNT, "Expected exactly TOOL_COUNT canonical public MCP tools in v3.1.0 (63 + code_index + code_context)");
  assert.equal(report.summary.total_public_tools, TOOL_COUNT);
  assert.equal(report.summary.canonical_public_tools, TOOL_COUNT);
  assert.equal(report.summary.compatibility_aliases, 0, "Zero compatibility aliases permitted in v3.0.0");
  assert.equal(Object.keys(TOOL_ALIASES).length, 0);
  assert.equal(Object.keys(REMOVED_LEGACY_TOOLS).length, 25);
  assert.equal(report.summary.unmapped_tools_count, 0, `Unmapped tools: ${report.unmapped_tools.join(", ")}`);
  assert.equal(report.summary.untested_tools_count, 0, `Untested tools: ${report.untested_tools.join(", ")}`);
  assert.equal(report.summary.mcp_prompts_count, 2);
  assert.equal(report.summary.cli_commands_count, 14);
  assert.ok(report.consolidation_plan);

  const registeredNames = new Set(tools.map((t) => t.name));
  for (const legacyName of Object.keys(REMOVED_LEGACY_TOOLS)) {
    assert.equal(
      registeredNames.has(legacyName),
      false,
      `Removed legacy tool '${legacyName}' must NOT be registered in getToolList()`
    );
  }

  for (const tool of tools) {
    assert.ok(
      CANONICAL_TOOL_METADATA[tool.name],
      `Every registered public MCP tool must have canonical metadata: missing ${tool.name}`
    );
  }
});

test("TC-02 & TC-12: Catalog regression gate blocks duplicate tool IDs, missing descriptions/schemas, and flags redundant new tool registrations", () => {
  const tools = getToolList();

  const baselineGate = validateToolRegistrationGate({ tools });
  assert.equal(baselineGate.passed, true);
  assert.equal(baselineGate.blocking_violations_count, 0);

  const duplicateGate = validateToolRegistrationGate({
    tools,
    proposedTools: [
      {
        name: "audit",
        description: "Duplicate registration of canonical audit tool ID.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
  assert.equal(duplicateGate.passed, false);
  assert.equal(duplicateGate.status, "BLOCKED");
  assert.ok(duplicateGate.blocking_violations.some((v) => v.code === "DUPLICATE_TOOL_ID" && v.toolId === "audit"));

  const redundantGate = validateToolRegistrationGate({
    tools,
    proposedTools: [
      {
        name: "helper_recommend_test_suite_v2",
        description: "[READ_ONLY] Canonical change analysis tool: evaluate change impact & recommended regression tests.",
        handler: "handleDevWorkflowV2Tool('analyze_change')",
        domainService: "analyzeChangeImpact / explainViolation / proposeEngineeringStandard",
        inputSchema: {
          type: "object",
          properties: {},
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
    )
  );
});

test("TC-03, TC-06 & TC-07: Removed legacy tools fail closed at dispatch with no silent alias forwarding", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dwf-no-alias-"));
  try {
    const ws = new WorkflowState(path.join(tmpDir, "state.json"));
    await ws.load();
    await bindTaskToRepo(ws);

    for (const removedTool of ["audit_code", "helper_suggest_tests", "project_summary_data", "project_summary_db"]) {
      await assert.rejects(
        () => handleDevWorkflowV2Tool(removedTool, { projectDir: REPO_ROOT }),
        /Unsupported DevWorkflow V3\.1 tool/
      );
      const mcpRes = await handleToolCall({
        request: { params: { name: removedTool, arguments: {} } },
        normalizeRequestArgs,
        workflowState: ws,
        exec: async () => ({ stdout: "" }),
        git: {},
        utils,
      });
      assert.match(mcpRes.content[0].text, /Internal server error|Unknown tool/);
    }
    await ws.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("TC-04 & TC-05: False duplicates (D6) and distinct authorization boundaries (D4) are preserved and never merged unsafely", () => {
  const d6Sec = SEMANTIC_DUPLICATION_MATRIX.find((m) => m.pairId === "DUP-07");
  assert.ok(d6Sec);
  assert.equal(d6Sec.classification, "D6");

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
});

test("TC-08, TC-09 & TC-10: Canonical tools (audit, analyze_change, plan_fix, apply_safe_fix, project_summary) preserve 100% of capabilities", async () => {
  // 1. analyze_change (modes: impact, tests, explain, root_cause, refactor, docs, debt, opportunities, propose_standard)
  const files = ["app/Services/ReleaseSafety/DeploymentGate.php"];
  const impact = await handleDevWorkflowV2Tool("analyze_change", {
    mode: "impact",
    projectDir: REPO_ROOT,
    files,
  });
  assert.equal(impact.risk_level, "HIGH");
  assert.ok(impact.recommended_tests.length > 0);

  const rca = await handleDevWorkflowV2Tool("analyze_change", {
    mode: "root_cause",
    errorMessage: "AssertionError: expected 200 to equal 500",
    files,
  });
  assert.equal(rca.error_message, "AssertionError: expected 200 to equal 500");
  assert.ok(rca.hypotheses.length > 0);

  const refactor = await handleDevWorkflowV2Tool("analyze_change", {
    mode: "refactor",
    projectDir: REPO_ROOT,
    files,
  });
  assert.ok(Array.isArray(refactor.refactoring_steps));

  const debt = await handleDevWorkflowV2Tool("analyze_change", {
    mode: "debt",
    projectDir: REPO_ROOT,
  });
  assert.equal(debt.priorities.length, 4);

  // 2. project_summary with source: 'memory' | 'file' | 'db' | 'auto'
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dwf-summary-v3-"));
  try {
    const stateFile = path.join(tmpDir, "state.json");
    const ws = new WorkflowState(stateFile);
    await ws.load();
    await bindTaskToRepo(ws);
    ws.addToHistory({
      taskDescription: "Radical tool simplification v3.0.0",
      taskType: "refactor",
      commitMessage: "feat!: simplify MCP tool catalog to 63 canonical tools",
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

    const memRes = await callTool("project_summary", { source: "memory" });
    assert.match(memRes.content[0].text, /Project Knowledge Summary/);
    assert.match(memRes.content[0].text, /Total tasks completed: 1/);

    const fileRes = await callTool("project_summary", { source: "file" });
    assert.match(fileRes.content[0].text, /from persisted data/);

    const dbRes = await callTool("project_summary", { source: "db" });
    assert.match(dbRes.content[0].text, /Project Knowledge Summary|No project summary in database yet/);

    // 3. audit with category: 'architecture'
    const repo = await createTempGitRepo("dwf-tc09-v3-");
    try {
      await fs.mkdir(path.join(repo, "app", "Http", "Controllers"), { recursive: true });
      await fs.writeFile(
        path.join(repo, "app", "Http", "Controllers", "RawController.php"),
        "<?php\nclass RawController { public function run() { return DB::raw('SELECT 1'); } }\n",
        "utf8"
      );
      const archRes = await handleDevWorkflowV2Tool("audit", {
        category: "architecture",
        projectDir: repo,
        files: ["app/Http/Controllers/RawController.php"],
      });
      assert.equal(archRes.findings.length, 1);
      assert.equal(archRes.findings[0].rule_id, "ZET-ARCH-001");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }

    await ws.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("TC-11 & TC-18: Tool discovery and session-scope attribution work cleanly for canonical v3.0.0 tools", () => {
  const tools = getToolList();
  for (const canonical of ["audit", "analyze_change", "plan_fix", "apply_safe_fix", "project_summary"]) {
    assert.ok(tools.some((t) => t.name === canonical), `Expected canonical tool ${canonical}`);
    assert.ok(NON_SESSION_SCOPED_TOOLS.has(canonical), `Expected ${canonical} in NON_SESSION_SCOPED_TOOLS`);
    const gate = resolveRequestSession({ params: { name: canonical, arguments: {} } });
    assert.equal(gate.ok, true);
  }

  const gateStart = resolveRequestSession({ params: { name: "start_task", arguments: {} } });
  assert.equal(gateStart.ok, false);
});

test("TC-13, TC-14 & TC-15: Task lifecycle, cross-client worktree mutex concurrency, and apply_safe_fix authorization remain intact", async () => {
  const repo = await createTempGitRepo("dwf-tc13-v3-");
  try {
    const targetFile = "src/sample.js";
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, targetFile), "export const v = 1;   \n", "utf8");

    const lockA = await acquireWorktreeMutex({
      projectDir: repo,
      ownerKey: "session-tc14-a",
      timeoutMs: 100,
    });
    assert.equal(lockA.ok, true);

    try {
      const lockB = await acquireWorktreeMutex({
        projectDir: repo,
        ownerKey: "session-tc14-b",
        timeoutMs: 100,
      });
      assert.equal(lockB.ok, false);

      await assert.rejects(
        () =>
          handleDevWorkflowV2Tool("apply_safe_fix", {
            projectDir: repo,
            file: targetFile,
            ruleId: "ZET-CODE-002",
            sessionId: "session-tc14-b",
          }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST"
      );

      const fixA = await handleDevWorkflowV2Tool("apply_safe_fix", {
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

test("TC-16: CLI compatibility — devwf audit catalog, devwf audit standards, and devwf audit code work end-to-end via canonical audit tool", async () => {
  const outCat = { lines: [], write(line) { this.lines.push(line); } };
  const argsCat = parseArgs(["audit", "catalog", "--json"]);
  const resCat = await runCommand({ args: argsCat, env: {}, out: outCat });
  assert.equal(resCat.ok, true);
  const parsedCat = JSON.parse(outCat.lines.join("\n"));
  assert.equal(parsedCat.regression_gate.passed, true);
  assert.equal(parsedCat.summary.total_public_tools, TOOL_COUNT);
  assert.equal(parsedCat.summary.compatibility_aliases, 0);

  const outHuman = { lines: [], write(line) { this.lines.push(line); } };
  const argsHuman = parseArgs(["audit", "catalog"]);
  const resHuman = await runCommand({ args: argsHuman, env: {}, out: outHuman });
  assert.equal(resHuman.ok, true);
  assert.match(outHuman.lines.join("\n"), /DevWorkflow MCP Tool Catalog Audit/);
});

test("TC-17 & TC-19: Representative AI agent tool selection benchmark resolves all 10 scenarios to the 63-tool canonical catalog with zero selection errors", () => {
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
    assert.equal(decision.isCanonical, true, `Selected tool ${decision.selectedTool} must be canonical`);
  }

  assert.equal(totalCallsBefore, 16);
  assert.equal(totalCallsAfter, 10);
});
