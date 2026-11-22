import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleDevWorkflowV2Tool } from "../src/engineering-audit.js";
import { WorkflowState } from "../workflow-state.js";
import {
  ProjectOwnershipLostError,
  acquireWorktreeMutex,
  releaseWorktreeMutex,
} from "../process-lock.js";
import { parseArgs } from "../cli/args.js";
import { runCommand } from "../cli/commands.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function createTempGitRepo(prefix = "dwf-accept-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Acceptance Tester"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: dir, stdio: "ignore" });
  await fs.writeFile(path.join(dir, "README.md"), "# Fixture Repo\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("Scenario 1 — Formatting Violation: detects trailing whitespace and marks eligible for AF-0 safe correction", async () => {
  const repo = await createTempGitRepo("dwf-scen1-");
  try {
    const file = "src/service.js";
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, file), "export const x = 1;    \n", "utf8");

    // Verify audit_changes auto-discovers git modified/untracked files without explicit files[]
    const audit = await handleDevWorkflowV2Tool("audit_changes", { projectDir: repo });
    const finding = audit.findings.find((f) => f.rule_id === "ZET-CODE-002" && f.file === file);
    assert.ok(finding, "Expected ZET-CODE-002 formatting violation on trailing whitespace");
    assert.equal(finding.autofix_eligible, true);
    assert.equal(finding.autofix_class, "AF-0");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("Scenario 2 — Forbidden Dependency: detects architecture boundary violation with rule ID and evidence", async () => {
  const repo = await createTempGitRepo("dwf-scen2-");
  try {
    await fs.mkdir(path.join(repo, "resources", "js", "Pages"), { recursive: true });
    const uiFile = "resources/js/Pages/Dashboard.jsx";
    await fs.writeFile(
      path.join(repo, uiFile),
      'import sqliteAdapter from "../../../db/adapters/sqlite.js";\nexport default function Dashboard() { return null; }\n',
      "utf8"
    );

    const audit = await handleDevWorkflowV2Tool("audit_architecture", {
      projectDir: repo,
      files: [uiFile],
    });
    const archViolation = audit.findings.find((f) => f.rule_id === "ZET-ARCH-003");
    assert.ok(archViolation, "Expected ZET-ARCH-003 forbidden dependency finding");
    assert.equal(archViolation.file, uiFile);
    assert.equal(archViolation.line, 1);
    assert.match(archViolation.evidence, /db\/adapters\/sqlite\.js/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("Scenario 3 — Secret Detection: detects synthetic credential without exposing the raw secret value", async () => {
  const repo = await createTempGitRepo("dwf-scen3-");
  try {
    const secretFile = "config/client.js";
    await fs.mkdir(path.join(repo, "config"), { recursive: true });
    // Construct synthetic credential dynamically so the test file itself has no literal token
    const syntheticToken = ["ghp", "_1234567890abcdefghijklmnopqrstuvwx"].join("");
    await fs.writeFile(
      path.join(repo, secretFile),
      `// Config\nexport const token = "${syntheticToken}";\n`,
      "utf8"
    );

    const report = await handleDevWorkflowV2Tool("audit_report", {
      projectDir: repo,
      files: [secretFile],
    });
    assert.equal(report.result, "FAIL");
    const secFinding = report.findings.find((f) => f.rule_id === "ZET-SEC-001");
    assert.ok(secFinding, "Expected ZET-SEC-001 secret finding");
    assert.equal(secFinding.line, 2);
    assert.equal(
      secFinding.evidence.includes(syntheticToken),
      false,
      "Evidence must NEVER expose raw credential value"
    );
    assert.equal(
      report.formatted_report.includes(syntheticToken),
      false,
      "Formatted report must NEVER expose raw credential value"
    );
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("Scenario 4 — Missing Regression Protection: flags critical module modification without test changes", async () => {
  const repo = await createTempGitRepo("dwf-scen4-");
  try {
    const critFile = "app/Services/ReleaseSafety/DeploymentGate.php";
    await fs.mkdir(path.join(repo, "app", "Services", "ReleaseSafety"), { recursive: true });
    await fs.writeFile(path.join(repo, critFile), "<?php\nclass DeploymentGate {}\n", "utf8");

    const audit = await handleDevWorkflowV2Tool("audit_tests", {
      projectDir: repo,
      files: [critFile],
    });
    const testGap = audit.findings.find((f) => f.rule_id === "ZET-TEST-001");
    assert.ok(testGap, "Expected ZET-TEST-001 finding when critical module changed without tests");
    assert.equal(testGap.severity, "high");

    const impact = await handleDevWorkflowV2Tool("helper_suggest_tests", {
      projectDir: repo,
      files: [critFile],
    });
    assert.equal(impact.risk_level, "HIGH");
    assert.ok(impact.recommended_tests.length > 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("Scenario 5 — Safe Autofix: applies deterministic fix in authorized workspace without unrelated changes", async () => {
  const repo = await createTempGitRepo("dwf-scen5-");
  try {
    const targetFile = "app/Service.php";
    const untouchedFile = "README.md";
    const untouchedBefore = await fs.readFile(path.join(repo, untouchedFile), "utf8");
    await fs.mkdir(path.join(repo, "app"), { recursive: true });
    await fs.writeFile(
      path.join(repo, targetFile),
      "<?php\nclass Service {\n  public function run() {\n    dd($debug);\n    return 42;   \n  }\n}\n",
      "utf8"
    );

    const fixAf1 = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: repo,
      file: targetFile,
      ruleId: "ZET-CODE-001",
    });
    assert.equal(fixAf1.applied, true);
    assert.equal(fixAf1.status, "VERIFIED_APPLIED");

    const fixAf0 = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: repo,
      file: targetFile,
      ruleId: "ZET-CODE-002",
    });
    assert.equal(fixAf0.applied, true);

    const afterTarget = await fs.readFile(path.join(repo, targetFile), "utf8");
    assert.equal(
      afterTarget,
      "<?php\nclass Service {\n  public function run() {\n    return 42;\n  }\n}\n"
    );
    assert.equal(await fs.readFile(path.join(repo, untouchedFile), "utf8"), untouchedBefore);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("Scenario 6 — Failed Autofix: forces post-fix verification failure and restores exact pre-change snapshot", async () => {
  const repo = await createTempGitRepo("dwf-scen6-");
  try {
    const targetFile = "app/BrokenFix.php";
    await fs.mkdir(path.join(repo, "app"), { recursive: true });
    const original = "<?php\n  var_dump($payload);\nreturn true;\n";
    await fs.writeFile(path.join(repo, targetFile), original, "utf8");

    const res = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: repo,
      file: targetFile,
      ruleId: "ZET-CODE-001",
      simulateVerificationFailure: true,
    });
    assert.equal(res.applied, false);
    assert.equal(res.restored_snapshot, true);
    assert.equal(res.status, "ROLLED_BACK_ON_VERIFICATION_FAILURE");
    assert.equal(await fs.readFile(path.join(repo, targetFile), "utf8"), original);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("Scenario 7 — Ownership Loss: mutating helper without valid worktree ownership fails closed", async () => {
  const repo = await createTempGitRepo("dwf-scen7-");
  try {
    const targetFile = "src/owned.js";
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    const original = "export const a = 1;   \n";
    await fs.writeFile(path.join(repo, targetFile), original, "utf8");

    // 1. WorkflowState with requireKernelMutex=true but no bound capability must fail closed
    const stateFile = path.join(repo, ".state", "workflow-state.json");
    const ws = new WorkflowState(stateFile, {
      sessionId: "sess-ownerless",
      requireKernelMutex: true,
    });
    ws.state.projectDir = repo;
    ws.state.currentPhase = "coding";

    await assert.rejects(
      () =>
        handleDevWorkflowV2Tool(
          "helper_apply_safe_fix",
          { projectDir: repo, file: targetFile, ruleId: "ZET-CODE-002" },
          ws
        ),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST"
    );

    // 2. Direct call with requireOwnership: true and no held capability also fails closed
    await assert.rejects(
      () =>
        handleDevWorkflowV2Tool("helper_apply_safe_fix", {
          projectDir: repo,
          file: targetFile,
          ruleId: "ZET-CODE-002",
          requireOwnership: true,
        }),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST"
    );

    // File must remain completely untouched
    assert.equal(await fs.readFile(path.join(repo, targetFile), "utf8"), original);
    await ws.close();
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("Scenario 8 — Concurrent Clients: two clients attempting conflicting mutations prevent unauthorized concurrent writes", async () => {
  const repo = await createTempGitRepo("dwf-scen8-");
  try {
    const targetFile = "src/concurrent.js";
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    const original = "export const shared = 1;   \n";
    await fs.writeFile(path.join(repo, targetFile), original, "utf8");

    // Client A acquires worktree mutex for session-client-a
    const acqA = await acquireWorktreeMutex({
      projectDir: repo,
      ownerKey: "session-client-a",
      timeoutMs: 100,
    });
    assert.equal(acqA.ok, true);

    try {
      // Client B (different session) attempts helper_apply_safe_fix on the same worktree -> MUST fail closed!
      await assert.rejects(
        () =>
          handleDevWorkflowV2Tool("helper_apply_safe_fix", {
            projectDir: repo,
            file: targetFile,
            ruleId: "ZET-CODE-002",
            sessionId: "session-client-b",
          }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST"
      );
      assert.equal(
        await fs.readFile(path.join(repo, targetFile), "utf8"),
        original,
        "Client B must not mutate file owned by Client A"
      );

      // Client A (rightful owner) applies fix -> succeeds!
      const resA = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
        projectDir: repo,
        file: targetFile,
        ruleId: "ZET-CODE-002",
        sessionId: "session-client-a",
      });
      assert.equal(resA.applied, true);
      assert.equal(await fs.readFile(path.join(repo, targetFile), "utf8"), "export const shared = 1;\n");
    } finally {
      await releaseWorktreeMutex(acqA.capability);
    }
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("Scenario 9 — Standards Change: proposing a blocking standard without authorization records proposal but never activates rule", async () => {
  const repo = await createTempGitRepo("dwf-scen9-");
  try {
    const proposal = await handleDevWorkflowV2Tool("helper_propose_standard", {
      projectDir: repo,
      proposedId: "ZET-CUSTOM-999",
      title: "Forbid raw array returns in domain services",
      problemDescription: "Inconsistent return types across legacy domain services.",
      proposedSeverity: "high",
      proposedEnforcement: "blocking",
      persistProposal: true,
    });

    assert.equal(proposal.auto_activated, false);
    assert.equal(proposal.active_in_registry, false);
    assert.equal(proposal.requested_enforcement, "blocking");
    assert.equal(proposal.proposed_enforcement, "advisory");
    assert.equal(proposal.blocking_activation_refused, true);
    assert.equal(proposal.status, "PROPOSED_PENDING_REVIEW");
    assert.ok(proposal.proposal_file);

    // Verify rule is NOT active in the project's standards registry
    const standards = await handleDevWorkflowV2Tool("audit_standards", { projectDir: repo });
    const loadedAudit = await handleDevWorkflowV2Tool("audit_repository", { projectDir: repo });
    assert.equal(
      loadedAudit.findings.some((f) => f.rule_id === "ZET-CUSTOM-999"),
      false,
      "Unapproved proposed rule must not be active in audit engine"
    );
    assert.equal(standards.valid, true);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("Scenario 10 — Existing Technical Debt: baseline-aware audit distinguishes new violations from historical findings", async () => {
  const repo = await createTempGitRepo("dwf-scen10-");
  try {
    await fs.mkdir(path.join(repo, "app", "Http", "Controllers"), { recursive: true });
    await fs.mkdir(path.join(repo, "engineering", "reports"), { recursive: true });

    const legacyFile = "app/Http/Controllers/LegacyController.php";
    const newFile = "app/Http/Controllers/NewFeatureController.php";

    await fs.writeFile(
      path.join(repo, legacyFile),
      "<?php\nclass LegacyController {\n  public function index() {\n    dd($old);\n  }\n}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(repo, newFile),
      "<?php\nclass NewFeatureController {\n  public function store() {\n    var_dump($new);\n  }\n}\n",
      "utf8"
    );

    // Save baseline containing only the legacy warning
    const baselinePath = path.join(repo, "engineering", "reports", "audit-baseline.json");
    await fs.writeFile(
      baselinePath,
      JSON.stringify({
        findings: [{ rule_id: "ZET-CODE-001", file: legacyFile, line: 4 }],
      }),
      "utf8"
    );

    const report = await handleDevWorkflowV2Tool("audit_report", {
      projectDir: repo,
      files: [legacyFile, newFile],
    });

    assert.equal(report.baseline_active, true);
    assert.equal(report.summary.new_violations, 1);
    assert.equal(report.summary.historical_debt, 1);
    assert.equal(report.new_findings.length, 1);
    assert.equal(report.new_findings[0].file, newFile);
    assert.equal(report.new_findings[0].baseline_status, "new");
    assert.equal(report.historical_findings.length, 1);
    assert.equal(report.historical_findings[0].file, legacyFile);
    assert.equal(report.historical_findings[0].baseline_status, "historical");
    assert.match(report.formatted_report, /\[HISTORICAL DEBT\]/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("CLI Integration & Dogfooding: devwf audit standards and devwf audit code validate DevWorkflow itself", async () => {
  const outStd = { lines: [], write(line) { this.lines.push(line); } };
  const argsStd = parseArgs(["audit", "standards", "--dir", REPO_ROOT, "--json"]);
  const resStd = await runCommand({ args: argsStd, env: {}, out: outStd });
  assert.equal(resStd.ok, true);
  const parsedStd = JSON.parse(outStd.lines.join("\n"));
  assert.equal(parsedStd.valid, true);
  assert.equal(parsedStd.has_registry_directory, true);
  assert.ok(parsedStd.rules_count >= 12);

  const outCode = { lines: [], write(line) { this.lines.push(line); } };
  const argsCode = parseArgs(["audit", "code", "--dir", REPO_ROOT, "--json"]);
  const resCode = await runCommand({ args: argsCode, env: {}, out: outCode });
  assert.equal(resCode.ok, true, `Expected devwf audit code to pass on REPO_ROOT, got: ${outCode.lines.join("\n")}`);
});
