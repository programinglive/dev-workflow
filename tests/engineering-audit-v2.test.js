import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DEVWORKFLOW_V2_TOOL_DEFINITIONS,
  handleDevWorkflowV2Tool,
} from "../src/engineering-audit.js";
import { getToolList } from "../tools/definitions.js";

test("DevWorkflow V2.0 registers all 22 core audit and helper tools in MCP tool catalog", () => {
  const catalogNames = new Set(getToolList().map((t) => t.name));
  assert.equal(DEVWORKFLOW_V2_TOOL_DEFINITIONS.length, 22);
  for (const def of DEVWORKFLOW_V2_TOOL_DEFINITIONS) {
    assert.ok(catalogNames.has(def.name), `Missing V2 tool '${def.name}' in getToolList()`);
  }
});

test("audit_standards validates Zettly Engineering Standards Registry without errors", async () => {
  const zettlyDir = "D:/code/zettly";
  const res = await handleDevWorkflowV2Tool("audit_standards", { projectDir: zettlyDir });
  assert.equal(res.valid, true, `Expected valid registry, got issues: ${JSON.stringify(res.issues)}`);
  assert.equal(res.has_registry_directory, true);
  assert.ok(res.rules_count >= 11);
  assert.ok(res.approved_exceptions_count >= 1);
});

test("Automatic Code Audit Engine detects seeded violations across categories and generates formatted report", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devwf-v2-audit-"));
  try {
    await fs.mkdir(path.join(tmpDir, "app", "Http", "Controllers"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "database", "migrations"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "app", "Services", "ReleaseSafety"), { recursive: true });

    // Seed 1: Controller with DB::raw (ZET-ARCH-001) + dd() debug leftover (ZET-CODE-001) + trailing whitespace (ZET-CODE-002)
    await fs.writeFile(
      path.join(tmpDir, "app", "Http", "Controllers", "SampleController.php"),
      "<?php\nclass SampleController {\n  public function index() {\n    dd($request);\n    return DB::raw('SELECT 1');   \n  }\n}\n",
      "utf8"
    );

    // Seed 2: Destructive migration in up() (ZET-DB-001)
    await fs.writeFile(
      path.join(tmpDir, "database", "migrations", "2026_11_22_000001_drop_users_col.php"),
      "<?php\nreturn new class {\n  public function up() {\n    Schema::dropIfExists('legacy_users');\n  }\n  public function down() {}\n};\n",
      "utf8"
    );

    // Seed 3: Critical ReleaseSafety service modified without test change (ZET-TEST-001)
    await fs.writeFile(
      path.join(tmpDir, "app", "Services", "ReleaseSafety", "Gate.php"),
      "<?php\nclass Gate {}\n",
      "utf8"
    );

    const changedFiles = [
      "app/Http/Controllers/SampleController.php",
      "database/migrations/2026_11_22_000001_drop_users_col.php",
      "app/Services/ReleaseSafety/Gate.php",
    ];

    const report = await handleDevWorkflowV2Tool("audit_report", {
      projectDir: tmpDir,
      files: changedFiles,
      scope: "Pull Request",
    });

    assert.equal(report.result, "FAIL");
    assert.equal(report.quality_gate, "FAILED");
    assert.ok(report.formatted_report.includes("DEVWORKFLOW AUTOMATIC CODE AUDIT"));
    assert.ok(report.formatted_report.includes("QUALITY GATE: FAILED"));

    const ruleIds = new Set(report.findings.map((f) => f.rule_id));
    assert.ok(ruleIds.has("ZET-ARCH-001"), "Should detect DB::raw in Controller");
    assert.ok(ruleIds.has("ZET-CODE-001"), "Should detect dd() debug dump");
    assert.ok(ruleIds.has("ZET-CODE-002"), "Should detect trailing whitespace");
    assert.ok(ruleIds.has("ZET-DB-001"), "Should detect destructive migration");
    assert.ok(ruleIds.has("ZET-TEST-001"), "Should detect critical service change without test");

    // Verify helper_autofix_candidates
    const candidates = await handleDevWorkflowV2Tool("helper_autofix_candidates", {
      projectDir: tmpDir,
      files: changedFiles,
    });
    assert.ok(candidates.candidates.length >= 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Bounded Self-Healing Autofix applies AF-0/AF-1 fixes, restores snapshot on verification failure, and blocks protected paths", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devwf-v2-fix-"));
  try {
    const sampleFile = path.join(tmpDir, "sample.php");
    const initial = "<?php\n  dd($debug);\n$x = 1;   \n";
    await fs.writeFile(sampleFile, initial, "utf8");

    // 1. Simulated verification failure -> must restore exact original content!
    const rolledBack = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: tmpDir,
      file: "sample.php",
      ruleId: "ZET-CODE-001",
      simulateVerificationFailure: true,
    });
    assert.equal(rolledBack.applied, false);
    assert.equal(rolledBack.restored_snapshot, true);
    assert.equal(rolledBack.status, "ROLLED_BACK_ON_VERIFICATION_FAILURE");
    assert.equal(await fs.readFile(sampleFile, "utf8"), initial);

    // 2. AF-1 fix (remove dd()) succeeds and persists
    const fixedAf1 = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: tmpDir,
      file: "sample.php",
      ruleId: "ZET-CODE-001",
    });
    assert.equal(fixedAf1.applied, true);
    assert.equal(fixedAf1.status, "VERIFIED_APPLIED");
    const afterAf1 = await fs.readFile(sampleFile, "utf8");
    assert.ok(!afterAf1.includes("dd($debug)"));

    // 3. AF-0 fix (strip trailing whitespace) succeeds
    const fixedAf0 = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: tmpDir,
      file: "sample.php",
      ruleId: "ZET-CODE-002",
    });
    assert.equal(fixedAf0.applied, true);
    assert.equal(await fs.readFile(sampleFile, "utf8"), "<?php\n$x = 1;\n");

    // 4. Protected governance file is strictly rejected
    await assert.rejects(
      () =>
        handleDevWorkflowV2Tool("helper_apply_safe_fix", {
          projectDir: tmpDir,
          file: "engineering/policies/enforcement.yaml",
          ruleId: "ZET-CODE-002",
        }),
      /Forbidden self-modification/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Helper tools explain violations, plan fixes, analyze change impact, and propose standards without auto-activating blocking rules", async () => {
  const explained = await handleDevWorkflowV2Tool("helper_explain_violation", {
    ruleId: "ZET-DB-001",
    file: "database/migrations/2026_11_21_drop.php",
  });
  assert.equal(explained.rule_id, "ZET-DB-001");
  assert.ok(explained.engineering_principle.includes("Reversible Changes"));

  const plan = await handleDevWorkflowV2Tool("helper_plan_fix", {
    ruleId: "ZET-ARCH-001",
    files: ["app/Http/Controllers/TodoController.php"],
  });
  assert.equal(plan.rule_id, "ZET-ARCH-001");

  const impact = await handleDevWorkflowV2Tool("helper_change_impact", {
    files: ["app/Services/ReleaseSafety/AutonomousDeploymentPolicy.php"],
  });
  assert.equal(impact.risk_level, "HIGH");
  assert.ok(impact.recommended_tests.some((t) => t.includes("V16ReleaseSafetyAndAiOrgTest")));

  const proposed = await handleDevWorkflowV2Tool("helper_propose_standard", {
    proposedId: "ZET-PERF-001",
    title: "Avoid N+1 queries in Todo controllers",
    problemDescription: "Repeated eager-loading omissions in list endpoints.",
  });
  assert.equal(proposed.auto_activated, false);
  assert.equal(proposed.proposed_enforcement, "advisory");
});

test("DevWorkflow V2.0 self-audits its own codebase and Zettly V1.6.1 changes cleanly", async () => {
  const selfAudit = await handleDevWorkflowV2Tool("audit_code", {
    projectDir: "D:/code/dev-workflow-mcp-server",
    files: [
      "src/engineering-audit.js",
      "tools/definitions.js",
      "session-scope.js",
      "tests/engineering-audit-v2.test.js",
    ],
  });
  assert.equal(selfAudit.result, "PASS", `Self-audit failed: ${JSON.stringify(selfAudit.findings)}`);

  const zettlyAudit = await handleDevWorkflowV2Tool("audit_code", {
    projectDir: "D:/code/zettly",
    files: [
      "app/Http/Controllers/Api/CodingAgentWorkerController.php",
      "app/Services/AiOrganization/AiCtoOrchestratorService.php",
      "app/Console/Commands/CodingAgentSafetyCommand.php",
      "agent_worker/executor.py",
      "tests/Feature/CodingAgent/V16ReleaseSafetyAndAiOrgTest.php",
      "agent_worker/test_executor.py",
    ],
  });
  assert.equal(zettlyAudit.result, "PASS", `Zettly V1.6.1 audit failed: ${JSON.stringify(zettlyAudit.findings)}`);
});
