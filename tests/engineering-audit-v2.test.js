import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  DEVWORKFLOW_V2_TOOL_DEFINITIONS,
  handleDevWorkflowV2Tool,
} from "../src/engineering-audit.js";
import { getToolList } from "../tools/definitions.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("DevWorkflow V3.1 registers the 6 canonical engineering & Zettly Code tools (audit, analyze_change, plan_fix, apply_safe_fix, code_index, code_context) with zero legacy duplicate names", () => {
  const catalogNames = new Set(getToolList().map((t) => t.name));
  assert.equal(DEVWORKFLOW_V2_TOOL_DEFINITIONS.length, 6);
  for (const def of DEVWORKFLOW_V2_TOOL_DEFINITIONS) {
    assert.ok(catalogNames.has(def.name), `Missing canonical V3 tool '${def.name}' in getToolList()`);
  }
  for (const removed of ["audit_code", "audit_changes", "audit_repository", "helper_suggest_tests", "helper_change_impact", "helper_apply_safe_fix", "project_summary_data", "project_summary_db"]) {
    assert.equal(catalogNames.has(removed), false, `Removed legacy tool '${removed}' must not appear in getToolList()`);
  }
});

test("audit ({ category: 'standards' }) validates Engineering Standards Registry without errors", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devwf-v3-standards-"));
  try {
    await fs.mkdir(path.join(tmpDir, "engineering", "standards"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "engineering", "exceptions"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "engineering", "standards", "architecture.yaml"),
      [
        "rules:",
        "  - id: ZET-ARCH-001",
        "    title: Deep modules with clear responsibility boundaries",
        "    severity: medium",
        "    enforcement: advisory",
        "    rationale: Controllers should delegate complex queries to service modules.",
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(tmpDir, "engineering", "exceptions", "approved-exceptions.yaml"),
      [
        "exceptions:",
        "  - id: EXC-001",
        "    rule_id: ZET-ARCH-001",
        "    file: app/Http/Controllers/LegacyReportController.php",
        "    reason: Legacy report export pending migration",
        "    approved_by: architecture-review",
      ].join("\n"),
      "utf8"
    );

    const res = await handleDevWorkflowV2Tool("audit", { category: "standards", projectDir: tmpDir });
    assert.equal(res.valid, true, `Expected valid registry, got issues: ${JSON.stringify(res.issues)}`);
    assert.equal(res.has_registry_directory, true);
    assert.ok(res.rules_count >= 11);
    assert.ok(res.approved_exceptions_count >= 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Automatic Code Audit Engine (canonical 'audit' & 'plan_fix') detects seeded violations across categories and generates formatted report", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devwf-v3-audit-"));
  try {
    await fs.mkdir(path.join(tmpDir, "app", "Http", "Controllers"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "database", "migrations"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "app", "Services", "ReleaseSafety"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "app", "Http", "Controllers", "SampleController.php"),
      "<?php\nclass SampleController {\n  public function index() {\n    dd($request);\n    return DB::raw('SELECT 1');   \n  }\n}\n",
      "utf8"
    );

    await fs.writeFile(
      path.join(tmpDir, "database", "migrations", "2026_11_22_000001_drop_users_col.php"),
      "<?php\nreturn new class {\n  public function up() {\n    Schema::dropIfExists('legacy_users');\n  }\n  public function down() {}\n};\n",
      "utf8"
    );

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

    const report = await handleDevWorkflowV2Tool("audit", {
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

    const candidates = await handleDevWorkflowV2Tool("plan_fix", {
      mode: "candidates",
      projectDir: tmpDir,
      files: changedFiles,
    });
    assert.ok(candidates.candidates.length >= 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Bounded Self-Healing Autofix (canonical 'apply_safe_fix') applies AF-0/AF-1 fixes, restores snapshot on verification failure, and blocks protected paths", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devwf-v3-fix-"));
  try {
    const sampleFile = path.join(tmpDir, "sample.php");
    const initial = "<?php\n  dd($debug);\n$x = 1;   \n";
    await fs.writeFile(sampleFile, initial, "utf8");

    const rolledBack = await handleDevWorkflowV2Tool("apply_safe_fix", {
      projectDir: tmpDir,
      file: "sample.php",
      ruleId: "ZET-CODE-001",
      simulateVerificationFailure: true,
    });
    assert.equal(rolledBack.applied, false);
    assert.equal(rolledBack.restored_snapshot, true);
    assert.equal(rolledBack.status, "ROLLED_BACK_ON_VERIFICATION_FAILURE");
    assert.equal(await fs.readFile(sampleFile, "utf8"), initial);

    const fixedAf1 = await handleDevWorkflowV2Tool("apply_safe_fix", {
      projectDir: tmpDir,
      file: "sample.php",
      ruleId: "ZET-CODE-001",
    });
    assert.equal(fixedAf1.applied, true);
    assert.equal(fixedAf1.status, "VERIFIED_APPLIED");
    const afterAf1 = await fs.readFile(sampleFile, "utf8");
    assert.ok(!afterAf1.includes("dd($debug)"));

    const fixedAf0 = await handleDevWorkflowV2Tool("apply_safe_fix", {
      projectDir: tmpDir,
      file: "sample.php",
      ruleId: "ZET-CODE-002",
    });
    assert.equal(fixedAf0.applied, true);
    assert.equal(await fs.readFile(sampleFile, "utf8"), "<?php\n$x = 1;\n");

    await assert.rejects(
      () =>
        handleDevWorkflowV2Tool("apply_safe_fix", {
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

test("Canonical 'analyze_change' and 'plan_fix' explain violations, plan fixes, analyze change impact, and propose standards without auto-activating blocking rules", async () => {
  const explained = await handleDevWorkflowV2Tool("analyze_change", {
    mode: "explain",
    ruleId: "ZET-DB-001",
    file: "database/migrations/2026_11_21_drop.php",
  });
  assert.equal(explained.rule_id, "ZET-DB-001");
  assert.ok(explained.engineering_principle.includes("Reversible Changes"));

  const plan = await handleDevWorkflowV2Tool("plan_fix", {
    mode: "plan",
    ruleId: "ZET-ARCH-001",
    files: ["app/Http/Controllers/TodoController.php"],
  });
  assert.equal(plan.rule_id, "ZET-ARCH-001");

  const impact = await handleDevWorkflowV2Tool("analyze_change", {
    mode: "impact",
    files: ["app/Services/ReleaseSafety/AutonomousDeploymentPolicy.php"],
  });
  assert.equal(impact.risk_level, "HIGH");
  assert.ok(impact.recommended_tests.some((t) => t.includes("V16ReleaseSafetyAndAiOrgTest")));

  const proposed = await handleDevWorkflowV2Tool("analyze_change", {
    mode: "propose_standard",
    proposedId: "ZET-PERF-001",
    title: "Avoid N+1 queries in Todo controllers",
    problemDescription: "Repeated eager-loading omissions in list endpoints.",
  });
  assert.equal(proposed.auto_activated, false);
  assert.equal(proposed.proposed_enforcement, "advisory");
});

test("DevWorkflow V3.0 self-audits its own codebase cleanly via canonical 'audit'", async () => {
  const selfAudit = await handleDevWorkflowV2Tool("audit", {
    category: "code",
    projectDir: REPO_ROOT,
    files: [
      "src/engineering-audit.js",
      "tools/definitions.js",
      "session-scope.js",
      "tests/engineering-audit-v2.test.js",
    ],
  });
  assert.equal(selfAudit.result, "PASS", `Self-audit failed: ${JSON.stringify(selfAudit.findings)}`);
});
