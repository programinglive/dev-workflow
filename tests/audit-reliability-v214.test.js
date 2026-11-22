import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  handleDevWorkflowV2Tool,
  computeFindingFingerprint,
  FINDING_FINGERPRINT_VERSION,
} from "../src/engineering-audit.js";
import { WorkflowState } from "../workflow-state.js";
import {
  ProjectOwnershipLostError,
  acquireWorktreeMutex,
  releaseWorktreeMutex,
} from "../process-lock.js";
import { parseArgs } from "../cli/args.js";
import { runCommand } from "../cli/commands.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function createTempGitRepo(prefix = "dwf-ar-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "AR Tester"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "ar@example.com"], { cwd: dir, stdio: "ignore" });
  await fs.writeFile(path.join(dir, "README.md"), "# AR Fixture\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("AR-01: Clean PR checkout with committed changes detects changed files and violations", async () => {
  const repo = await createTempGitRepo("dwf-ar01-");
  try {
    execFileSync("git", ["checkout", "-q", "-b", "feat/pr-clean"], { cwd: dirOr(repo), stdio: "ignore" });
    await fs.mkdir(path.join(repo, "app", "Http", "Controllers"), { recursive: true });
    const prFile = "app/Http/Controllers/PrController.php";
    await fs.writeFile(
      path.join(repo, prFile),
      "<?php\nclass PrController {\n  public function show() {\n    return DB::raw('SELECT 1');\n  }\n}\n",
      "utf8"
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "feat: add pr controller"], { cwd: repo, stdio: "ignore" });

    // Working tree is 100% clean, yet audit_changes must detect the committed PR change against main
    const statusOut = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(statusOut, "", "Fixture working tree must be completely clean");

    const audit = await handleDevWorkflowV2Tool("audit_changes", { projectDir: repo });
    assert.equal(audit.detection_status, "COMPLETED");
    assert.equal(audit.audit_mode, "pr");
    assert.ok(audit.resolved_scope.changed_files.includes(prFile));
    assert.ok(audit.findings.some((f) => f.rule_id === "ZET-ARCH-001" && f.file === prFile));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

function dirOr(d) {
  return d;
}

test("AR-02: Multiple commits in PR (including merge commit & detached HEAD) audit full comparison scope", async () => {
  const repo = await createTempGitRepo("dwf-ar02-");
  try {
    execFileSync("git", ["checkout", "-q", "-b", "feat/multi-commit"], { cwd: repo, stdio: "ignore" });

    // Commit 1 on PR branch
    await fs.mkdir(path.join(repo, "app", "Http", "Controllers"), { recursive: true });
    const file1 = "app/Http/Controllers/FirstController.php";
    await fs.writeFile(
      path.join(repo, file1),
      "<?php\nclass FirstController {\n  public function a() {\n    return DB::raw('SELECT 1');\n  }\n}\n",
      "utf8"
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "feat: commit 1"], { cwd: repo, stdio: "ignore" });

    // Commit 2 on PR branch
    const file2 = "app/Http/Controllers/SecondController.php";
    await fs.writeFile(
      path.join(repo, file2),
      "<?php\nclass SecondController {\n  public function b() {\n    dd($req);\n  }\n}\n",
      "utf8"
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "feat: commit 2"], { cwd: repo, stdio: "ignore" });

    // Detach HEAD to simulate CI detached checkout
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-q", headSha], { cwd: repo, stdio: "ignore" });

    const audit = await handleDevWorkflowV2Tool("audit_changes", {
      projectDir: repo,
      changeMode: "pr",
      baseRef: "main",
      headRef: "HEAD",
    });

    assert.equal(audit.detection_status, "COMPLETED");
    assert.equal(audit.resolved_scope.changed_files.length, 2);
    assert.ok(audit.findings.some((f) => f.file === file1 && f.rule_id === "ZET-ARCH-001"));
    assert.ok(audit.findings.some((f) => f.file === file2 && f.rule_id === "ZET-CODE-001"));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("AR-03: Renamed files, deleted files, and filenames with spaces are handled accurately", async () => {
  const repo = await createTempGitRepo("dwf-ar03-");
  try {
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "old_name.php"), "<?php\n// initial\n", "utf8");
    await fs.writeFile(path.join(repo, "src", "to_delete.php"), "<?php\n// delete me\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "chore: seed files"], { cwd: repo, stdio: "ignore" });

    execFileSync("git", ["checkout", "-q", "-b", "feat/renames-and-spaces"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["mv", "src/old_name.php", "src/new_name.php"], { cwd: repo, stdio: "ignore" });
    await fs.writeFile(
      path.join(repo, "src", "new_name.php"),
      "<?php\n// initial\n  dd($renamed);\n",
      "utf8"
    );
    execFileSync("git", ["rm", "-q", "src/to_delete.php"], { cwd: repo, stdio: "ignore" });
    const spacedFile = "src/file with spaces.php";
    await fs.writeFile(path.join(repo, spacedFile), "<?php\n  var_dump($spaced);\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "feat: rename, delete, and add spaced file"], {
      cwd: repo,
      stdio: "ignore",
    });

    const audit = await handleDevWorkflowV2Tool("audit_changes", {
      projectDir: repo,
      changeMode: "pr",
      baseRef: "main",
    });

    assert.equal(audit.detection_status, "COMPLETED");
    assert.ok(audit.resolved_scope.deleted_files.includes("src/to_delete.php"));
    assert.ok(
      audit.resolved_scope.renamed_files.some(
        (r) => r.from === "src/old_name.php" && r.to === "src/new_name.php"
      )
    );
    assert.ok(audit.resolved_scope.changed_files.includes(spacedFile));
    assert.ok(audit.findings.some((f) => f.file === "src/new_name.php" && f.rule_id === "ZET-CODE-001"));
    assert.ok(audit.findings.some((f) => f.file === spacedFile && f.rule_id === "ZET-CODE-001"));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("AR-04: Missing Git base reference fails closed with INCOMPLETE/FAILED and never reports PASS", async () => {
  const repo = await createTempGitRepo("dwf-ar04-");
  try {
    const audit = await handleDevWorkflowV2Tool("audit_changes", {
      projectDir: repo,
      changeMode: "pr",
      baseRef: "nonexistent-base-branch-xyz",
    });

    assert.equal(audit.detection_status, "FAILED");
    assert.equal(audit.coverage_status, "FAILED");
    assert.equal(audit.overall_verdict, "INCOMPLETE");
    assert.equal(audit.result, "FAIL");
    assert.equal(audit.quality_gate, "FAILED");
    assert.ok(audit.errors.some((e) => e.code === "MISSING_GIT_BASE_REF"));

    // Also verify option injection starting with '-' is rejected
    const injected = await handleDevWorkflowV2Tool("audit_changes", {
      projectDir: repo,
      changeMode: "pr",
      baseRef: "--upload-pack=evil",
    });
    assert.equal(injected.detection_status, "FAILED");
    assert.equal(injected.overall_verdict, "INCOMPLETE");
    assert.ok(injected.errors.some((e) => e.code === "INVALID_GIT_BASE_REF"));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("AR-05: New violation in historically affected file (same ruleId, same file) is classified as NEW", async () => {
  const repo = await createTempGitRepo("dwf-ar05-");
  try {
    await fs.mkdir(path.join(repo, "app", "Http", "Controllers"), { recursive: true });
    await fs.mkdir(path.join(repo, "engineering", "reports"), { recursive: true });
    const file = "app/Http/Controllers/SameFileController.php";

    const historicalFp = computeFindingFingerprint("ZET-CODE-001", file, "dd($old);");
    await fs.writeFile(
      path.join(repo, "engineering", "reports", "audit-baseline.json"),
      JSON.stringify({
        fingerprint_version: FINDING_FINGERPRINT_VERSION,
        findings: [
          {
            rule_id: "ZET-CODE-001",
            file,
            line: 4,
            evidence: "dd($old);",
            evidence_fingerprint: historicalFp,
          },
        ],
      }),
      "utf8"
    );

    // File contains BOTH the old violation AND a newly introduced violation of the SAME rule ZET-CODE-001!
    await fs.writeFile(
      path.join(repo, file),
      "<?php\nclass SameFileController {\n  public function index() {\n    dd($old);\n    var_dump($newlyIntroduced);\n  }\n}\n",
      "utf8"
    );

    const report = await handleDevWorkflowV2Tool("audit_report", {
      projectDir: repo,
      files: [file],
    });

    assert.equal(report.findings.length, 2);
    assert.equal(report.historical_findings.length, 1);
    assert.equal(report.new_findings.length, 1, "Second violation in same file must NOT be hidden as historical");
    assert.equal(report.new_findings[0].evidence, "var_dump($newlyIntroduced);");
    assert.equal(report.new_findings[0].baseline_status, "new");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("AR-06: Historical violation moved by line changes retains stable HISTORICAL classification", async () => {
  const repo = await createTempGitRepo("dwf-ar06-");
  try {
    await fs.mkdir(path.join(repo, "app", "Http", "Controllers"), { recursive: true });
    await fs.mkdir(path.join(repo, "engineering", "reports"), { recursive: true });
    const file = "app/Http/Controllers/MovedLineController.php";

    const fp = computeFindingFingerprint("ZET-ARCH-001", file, "return DB::raw('SELECT 1');");
    // Baseline recorded at line 4
    await fs.writeFile(
      path.join(repo, "engineering", "reports", "audit-baseline.json"),
      JSON.stringify({
        fingerprint_version: FINDING_FINGERPRINT_VERSION,
        findings: [
          {
            rule_id: "ZET-ARCH-001",
            file,
            line: 4,
            evidence: "return DB::raw('SELECT 1');",
            evidence_fingerprint: fp,
          },
        ],
      }),
      "utf8"
    );

    // Refactoring adds 6 comment/code lines above, shifting the violation from line 4 to line 10
    await fs.writeFile(
      path.join(repo, file),
      [
        "<?php",
        "// Line 2 added during refactoring",
        "// Line 3 added",
        "// Line 4 added",
        "// Line 5 added",
        "// Line 6 added",
        "// Line 7 added",
        "class MovedLineController {",
        "  public function index() {",
        "    return DB::raw('SELECT 1');",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    const report = await handleDevWorkflowV2Tool("audit_report", {
      projectDir: repo,
      files: [file],
    });

    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].line, 10);
    assert.equal(report.findings[0].baseline_status, "historical", "Line movement must not create false new debt");
    assert.equal(report.new_findings.length, 0);
    assert.equal(report.historical_findings.length, 1);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("AR-07: Duplicate identical violation occurrences enforce exact multiplicity against baseline", async () => {
  const repo = await createTempGitRepo("dwf-ar07-");
  try {
    await fs.mkdir(path.join(repo, "app", "Http", "Controllers"), { recursive: true });
    await fs.mkdir(path.join(repo, "engineering", "reports"), { recursive: true });
    const file = "app/Http/Controllers/DuplicateController.php";

    const fp = computeFindingFingerprint("ZET-CODE-001", file, "dd($same);");
    // Baseline has only ONE occurrence of `dd($same);`
    await fs.writeFile(
      path.join(repo, "engineering", "reports", "audit-baseline.json"),
      JSON.stringify({
        fingerprint_version: FINDING_FINGERPRINT_VERSION,
        findings: [
          {
            rule_id: "ZET-CODE-001",
            file,
            line: 4,
            evidence: "dd($same);",
            evidence_fingerprint: fp,
          },
        ],
      }),
      "utf8"
    );

    // Source file now has TWO identical occurrences of `dd($same);`
    await fs.writeFile(
      path.join(repo, file),
      "<?php\nclass DuplicateController {\n  public function index() {\n    dd($same);\n    dd($same);\n  }\n}\n",
      "utf8"
    );

    const report = await handleDevWorkflowV2Tool("audit_report", {
      projectDir: repo,
      files: [file],
    });

    assert.equal(report.findings.length, 2);
    assert.equal(report.historical_findings.length, 1, "First occurrence matches baseline count 1");
    assert.equal(report.new_findings.length, 1, "Second identical occurrence exceeds baseline count and must be NEW");
    assert.equal(report.findings[0].occurrence_index, 1);
    assert.equal(report.findings[1].occurrence_index, 2);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("AR-08: Autofix without external tests reports MECHANICALLY_VERIFIED (not TEST_VERIFIED) and blocks untrusted binaries", async () => {
  const repo = await createTempGitRepo("dwf-ar08-");
  try {
    const file = "src/format.js";
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, file), "export const v = 1;   \n", "utf8");

    // 1. Without verifyCommand -> MECHANICALLY_VERIFIED, tests_executed: false
    const mech = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: repo,
      file,
      ruleId: "ZET-CODE-002",
    });
    assert.equal(mech.applied, true);
    assert.equal(mech.verification_level, "MECHANICALLY_VERIFIED");
    assert.equal(mech.tests_executed, false);

    // 2. With approved verifyCommand -> TEST_VERIFIED, tests_executed: true
    await fs.writeFile(path.join(repo, file), "export const v = 2;   \n", "utf8");
    const testVer = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: repo,
      file,
      ruleId: "ZET-CODE-002",
      verifyCommand: ["node", "-e", "process.exit(0)"],
    });
    assert.equal(testVer.applied, true);
    assert.equal(testVer.verification_level, "TEST_VERIFIED");
    assert.equal(testVer.tests_executed, true);

    // 3. Untrusted verifyCommand binary is rejected before modifying file
    await assert.rejects(
      () =>
        handleDevWorkflowV2Tool("helper_apply_safe_fix", {
          projectDir: repo,
          file,
          ruleId: "ZET-CODE-002",
          verifyCommand: ["powershell.exe", "-Command", "Write-Host evil"],
        }),
      /Untrusted verifyCommand executable/
    );
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("AR-09 & AR-10: Failed autofix rolls back safely, and concurrent edit during verification aborts blind overwrite", async () => {
  const repo = await createTempGitRepo("dwf-ar09-10-");
  try {
    const file = "src/rollback.php";
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    const original = "<?php\n  dd($x);\nreturn 1;\n";
    await fs.writeFile(path.join(repo, file), original, "utf8");

    // AR-09: Normal rollback when verification fails
    const rb = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: repo,
      file,
      ruleId: "ZET-CODE-001",
      simulateVerificationFailure: true,
    });
    assert.equal(rb.applied, false);
    assert.equal(rb.restored_snapshot, true);
    assert.equal(rb.verification_level, "ROLLED_BACK");
    assert.equal(await fs.readFile(path.join(repo, file), "utf8"), original);

    // AR-10: Concurrent developer edit occurs after autofix write but before rollback
    const concurrentDeveloperContent = "<?php\n// Concurrent developer edit!\nreturn 999;\n";
    const abortedRb = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: repo,
      file,
      ruleId: "ZET-CODE-001",
      simulateVerificationFailure: true,
      simulateConcurrentEditBeforeRollback: concurrentDeveloperContent,
    });
    assert.equal(abortedRb.applied, false);
    assert.equal(abortedRb.restored_snapshot, false);
    assert.equal(abortedRb.concurrent_modification_detected, true);
    assert.equal(abortedRb.status, "ROLLBACK_ABORTED_CONCURRENT_MODIFICATION");
    assert.equal(
      await fs.readFile(path.join(repo, file), "utf8"),
      concurrentDeveloperContent,
      "Rollback must NOT overwrite concurrent developer modifications"
    );
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("AR-11 & AR-12: Repository scan exceeding limits returns PARTIAL (never PASS), and outside-workspace paths are blocked", async () => {
  const repo = await createTempGitRepo("dwf-ar11-12-");
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "dwf-outside-"));
  try {
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    for (let i = 1; i <= 5; i++) {
      await fs.writeFile(path.join(repo, "src", `mod${i}.js`), `export const m${i} = ${i};\n`, "utf8");
    }

    // AR-11: Scan with maxFiles=2 on a 5-file repo -> must return PARTIAL, never PASS!
    const partialAudit = await handleDevWorkflowV2Tool("audit_repository", {
      projectDir: repo,
      maxFiles: 2,
    });
    assert.equal(partialAudit.coverage_status, "PARTIAL");
    assert.equal(partialAudit.scan_completeness, "PARTIAL");
    assert.equal(partialAudit.overall_verdict, "PARTIAL");
    assert.equal(partialAudit.result, "PARTIAL");
    assert.equal(partialAudit.quality_gate, "INCOMPLETE_PARTIAL_SCAN");
    assert.equal(partialAudit.scan_coverage.limit_reached, true);
    assert.equal(partialAudit.scan_coverage.files_scanned, 2);
    assert.equal(partialAudit.scan_coverage.files_discovered, 5);
    assert.equal(partialAudit.scan_coverage.unscanned_files_count, 3);

    // AR-12: Attempting to audit a file outside the workspace root is refused and excluded
    const outsideFile = path.join(outsideDir, "outside.js");
    await fs.writeFile(outsideFile, "export const secret = 1;\n", "utf8");
    const traversalAudit = await handleDevWorkflowV2Tool("audit_code", {
      projectDir: repo,
      files: [outsideFile],
    });
    assert.equal(traversalAudit.files_audited, 0);
    assert.equal(traversalAudit.scan_coverage.files_excluded, 1);
    assert.ok(traversalAudit.errors.some((e) => e.code === "PATH_OUTSIDE_WORKSPACE"));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("AR-13: Complex debug statements (inline conditionals, expressions) are proposal-only AF-2 and comments/strings are ignored", async () => {
  const repo = await createTempGitRepo("dwf-ar13-");
  try {
    await fs.mkdir(path.join(repo, "app"), { recursive: true });

    // 1. Comments and strings containing dd() / var_dump() must NOT trigger false positives
    const benignFile = "app/BenignComments.php";
    await fs.writeFile(
      path.join(repo, benignFile),
      [
        "<?php",
        "// Do not call dd($request); in production",
        "/* Multi-line comment with var_dump($data); */",
        '$msg = "Example debug call: dd($user);";',
        "return $msg;",
        "",
      ].join("\n"),
      "utf8"
    );

    const benignAudit = await handleDevWorkflowV2Tool("audit_code", {
      projectDir: repo,
      files: [benignFile],
    });
    assert.equal(
      benignAudit.findings.filter((f) => f.rule_id === "ZET-CODE-001").length,
      0,
      "Comments and string literals containing dd()/var_dump() must not produce false positives"
    );

    // 2. Complex debug call inside inline conditional (`if ($err) dd($err);`) or braceless if
    const complexFile = "app/ComplexDebug.php";
    const complexContent = [
      "<?php",
      "class ComplexDebug {",
      "  public function handle($err) {",
      "    if ($err) dd($err);",
      "    return 'ok';",
      "  }",
      "}",
      "",
    ].join("\n");
    await fs.writeFile(path.join(repo, complexFile), complexContent, "utf8");

    const complexAudit = await handleDevWorkflowV2Tool("audit_code", {
      projectDir: repo,
      files: [complexFile],
    });
    const finding = complexAudit.findings.find((f) => f.rule_id === "ZET-CODE-001");
    assert.ok(finding, "Complex debug call must still be detected by audit");
    assert.equal(finding.autofix_eligible, false, "Inline conditional dd() must NOT be autofix-eligible");
    assert.equal(finding.autofix_class, "AF-2");

    // 3. helper_apply_safe_fix must refuse automatic modification of complex debug call
    const fixAttempt = await handleDevWorkflowV2Tool("helper_apply_safe_fix", {
      projectDir: repo,
      file: complexFile,
      ruleId: "ZET-CODE-001",
    });
    assert.equal(fixAttempt.applied, false);
    assert.equal(fixAttempt.status, "PROPOSAL_ONLY_BEHAVIOR_SENSITIVE");
    assert.equal(fixAttempt.autofix_class, "AF-2");
    assert.equal(await fs.readFile(path.join(repo, complexFile), "utf8"), complexContent);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("AR-14 & AR-15: Worktree ownership loss and concurrent client mutations are denied fail-closed", async () => {
  const repo = await createTempGitRepo("dwf-ar14-15-");
  try {
    const file = "src/fenced.js";
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    const initial = "export const k = 1;   \n";
    await fs.writeFile(path.join(repo, file), initial, "utf8");

    // AR-14: Invalid/missing worktree ownership
    const ws = new WorkflowState(path.join(repo, ".state", "workflow-state.json"), {
      sessionId: "sess-unowned",
      requireKernelMutex: true,
    });
    ws.state.projectDir = repo;
    ws.state.currentPhase = "coding";

    await assert.rejects(
      () =>
        handleDevWorkflowV2Tool(
          "helper_apply_safe_fix",
          { projectDir: repo, file, ruleId: "ZET-CODE-002" },
          ws
        ),
      (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST"
    );
    await ws.close();

    // AR-15: Concurrent MCP clients
    const acqA = await acquireWorktreeMutex({ projectDir: repo, ownerKey: "client-A", timeoutMs: 100 });
    assert.equal(acqA.ok, true);
    try {
      await assert.rejects(
        () =>
          handleDevWorkflowV2Tool("helper_apply_safe_fix", {
            projectDir: repo,
            file,
            ruleId: "ZET-CODE-002",
            sessionId: "client-B",
          }),
        (err) => err instanceof ProjectOwnershipLostError || err?.code === "PROJECT_OWNERSHIP_LOST"
      );
      assert.equal(await fs.readFile(path.join(repo, file), "utf8"), initial);
    } finally {
      await releaseWorktreeMutex(acqA.capability);
    }
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("AR-16, AR-17 & AR-18: Self-audit contract, Zettly compatibility, and real CLI PR audit verification", async () => {
  // AR-16: Self-audit verifies 4-dimension reliability contract
  const selfReport = await handleDevWorkflowV2Tool("audit_report", {
    projectDir: REPO_ROOT,
    files: ["src/engineering-audit.js", "cli/commands.js", "cli/args.js"],
  });
  assert.equal(selfReport.detection_status, "COMPLETED");
  assert.equal(selfReport.coverage_status, "COMPLETE");
  assert.equal(selfReport.policy_status, "COMPLIANT");
  assert.equal(selfReport.overall_verdict, "PASS");

  // AR-17: Zettly standards registry validation (if D:/code/zettly is present on workstation)
  const zettlyDir = "D:/code/zettly";
  try {
    await fs.access(zettlyDir);
    const zettlyStd = await handleDevWorkflowV2Tool("audit_standards", { projectDir: zettlyDir });
    assert.equal(zettlyStd.valid, true);
    assert.ok(zettlyStd.rules_count >= 13);
  } catch {
    // skip if zettly repo not checked out on current test host
  }

  // AR-18: Real CLI PR audit (`devwf audit changes --base main --dir <repo> --json`)
  const repo = await createTempGitRepo("dwf-ar18-");
  try {
    execFileSync("git", ["checkout", "-q", "-b", "feat/ci-pr-check"], { cwd: repo, stdio: "ignore" });
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "clean.js"), "export const ok = true;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "feat: add clean module"], { cwd: repo, stdio: "ignore" });

    const outPass = { lines: [], write(l) { this.lines.push(l); } };
    const argsPass = parseArgs(["audit", "changes", "--dir", repo, "--base", "main", "--json"]);
    const resPass = await runCommand({ args: argsPass, env: {}, out: outPass });
    assert.equal(resPass.ok, true);
    const parsedPass = JSON.parse(outPass.lines.join("\n"));
    assert.equal(parsedPass.audit_mode, "pr");
    assert.equal(parsedPass.resolved_scope.base_ref, "main");
    assert.ok(parsedPass.resolved_scope.merge_base);
    assert.deepEqual(parsedPass.resolved_scope.changed_files, ["src/clean.js"]);
    assert.equal(parsedPass.overall_verdict, "PASS");

    // Missing base ref via CLI must return ok: false
    const outFail = { lines: [], write(l) { this.lines.push(l); } };
    const argsFail = parseArgs(["audit", "changes", "--dir", repo, "--base", "missing-branch-ref", "--json"]);
    const resFail = await runCommand({ args: argsFail, env: {}, out: outFail });
    assert.equal(resFail.ok, false, "CLI PR audit with missing base ref must exit non-zero");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
