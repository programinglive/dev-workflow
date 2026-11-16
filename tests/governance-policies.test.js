import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { WorkflowState } from "../workflow-state.js";
import { handleStartTask, handleCreateDocumentation, handleWaiveDocumentation } from "../tools/handler-modules/workflow-handlers.js";
import { handleMarkDodItem } from "../tools/handler-modules/dod-handlers.js";
import { handleCompleteTask, handleForceCompleteTask } from "../tools/handler-modules/commit-handlers.js";
import { classifyTask } from "../governance/classifier.js";
import { evaluateGovernanceGate, loadPolicies } from "../governance/engine.js";
import { validatePolicyException } from "../governance/exceptions.js";
import { runCiGovernanceValidation } from "../governance/ci-validator.js";

function makeTempGitRepo(remoteUrl = "https://github.com/programinglive/dev-workflow-mcp-server.git") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gov-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "# Test Repo\n\nInitial documentation content for testing.\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "chore: init"], { cwd: dir });
  return dir;
}

function makeWorkflowState(dir) {
  const ws = new WorkflowState(path.join(dir, ".dev-workflow", "state.json"));
  ws.requireKernelMutex = false;
  return ws;
}

function validDocBody() {
  return "# Feature Documentation\n\n## Purpose\nExplains the new headless calculation service and CLI options.\n\n## Usage\nRun `devwf governance validate --policy all --json` (exit code 0).\n";
}

function validEvidence(overrides = {}) {
  const policies = loadPolicies();
  return {
    cliFirstEvidence: {
      summary: "node --test tests/governance-policies.test.js -> 25 pass, headless service verified",
      headlessTestsPassed: true,
      repository: "programinglive/dev-workflow-mcp-server",
      revision: 0,
      policyVersion: policies.policies["architecture.cli_first"].version,
      policyDigest: policies.digest,
    },
    documentationEvidence: {
      status: "UPDATED",
      files: ["docs/GOVERNANCE.md"],
      repository: "programinglive/dev-workflow-mcp-server",
      revision: 0,
      policyVersion: policies.policies["engineering.documentation_required"].version,
      policyDigest: policies.digest,
    },
    ...overrides,
  };
}

test("CLI-First 1-5: rejects missing/fake/divergent evidence, accepts verified headless, exempts presentation-only", () => {
  const policies = loadPolicies();
  const baseState = {
    taskType: "feature",
    taskDescription: "Implement new purchasing tax rule",
    governance: {
      effectiveMode: "enforce",
      repository: "programinglive/dev-workflow-mcp-server",
      policyDigest: policies.digest,
      policyVersions: {
        "architecture.cli_first": "1.0.0",
        "engineering.documentation_required": "1.0.0",
      },
      ...validEvidence(),
    },
  };

  // 1. Business feature without CLI-First evidence -> reject
  const missingCli = structuredClone(baseState);
  missingCli.governance.cliFirstEvidence = null;
  const r1 = evaluateGovernanceGate({
    state: missingCli,
    changedPaths: ["app/Services/TaxService.php", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": validDocBody() },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.violations[0].code, "CLI_FIRST_ASSESSMENT_MISSING");

  // 2. Business feature with verified shared service/headless evidence -> accept
  const r2 = evaluateGovernanceGate({
    state: baseState,
    changedPaths: ["app/Services/TaxService.php", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": validDocBody() },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(r2.ok, true);

  // 3. Presentation-only change -> no CLI command requirement
  const cssState = structuredClone(baseState);
  cssState.taskType = "other";
  cssState.taskDescription = "Update button CSS spacing";
  cssState.governance.cliFirstEvidence = null;
  cssState.governance.documentationEvidence = {
    status: "NOT_REQUIRED_WITH_REASON",
    rationale: "CSS-only button padding adjustment without behavior change.",
    repository: "programinglive/dev-workflow-mcp-server",
    revision: 0,
    policyVersion: "1.0.0",
    policyDigest: policies.digest,
  };
  const r3 = evaluateGovernanceGate({
    state: cssState,
    changedPaths: ["public/css/app.css"],
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.classification.taskClass, "PRESENTATION_ONLY");

  // 4. CLI/UI behavioral divergence -> fail
  const divState = structuredClone(baseState);
  divState.governance.cliFirstEvidence.behavioralDivergenceDetected = true;
  const r4 = evaluateGovernanceGate({
    state: divState,
    changedPaths: ["app/Services/TaxService.php", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": validDocBody() },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(r4.ok, false);
  assert.equal(r4.violations[0].code, "CLI_FIRST_EVIDENCE_INVALID");

  // 5. Fake CLI compliance declaration -> reject
  for (const fake of ["cli_first=ok", "Services folder exists", "Artisan command exists", "true"]) {
    const fakeState = structuredClone(baseState);
    fakeState.governance.cliFirstEvidence.summary = fake;
    fakeState.governance.cliFirstEvidence.headlessTestsPassed = false;
    const r5 = evaluateGovernanceGate({
      state: fakeState,
      changedPaths: ["app/Services/TaxService.php", "docs/GOVERNANCE.md"],
      docContents: { "docs/GOVERNANCE.md": validDocBody() },
      currentRepo: "programinglive/dev-workflow-mcp-server",
      currentRevision: 0,
    });
    assert.equal(r5.ok, false, `Expected fake "${fake}" to be rejected`);
  }
});

test("Documentation 6-14: enforces documentation quality, contracts, stale protection, and security", () => {
  const policies = loadPolicies();
  const baseState = {
    taskType: "feature",
    taskDescription: "Add CLI command for governance",
    governance: {
      effectiveMode: "enforce",
      repository: "programinglive/dev-workflow-mcp-server",
      policyDigest: policies.digest,
      policyVersions: {
        "architecture.cli_first": "1.0.0",
        "engineering.documentation_required": "1.0.0",
      },
      ...validEvidence(),
    },
  };

  // 6. New feature without documentation -> reject
  const noDoc = structuredClone(baseState);
  noDoc.governance.documentationEvidence = null;
  const r6 = evaluateGovernanceGate({
    state: noDoc,
    changedPaths: ["src/feature.js"],
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(r6.ok, false);
  assert.equal(r6.violations[0].code, "DOCUMENTATION_REQUIRED");

  // 7. New feature with valid documentation -> accept
  const r7 = evaluateGovernanceGate({
    state: baseState,
    changedPaths: ["src/feature.js", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": validDocBody() },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(r7.ok, true);

  // 8. Empty/placeholder README or unrelated file -> reject
  const emptyDoc = evaluateGovernanceGate({
    state: baseState,
    changedPaths: ["src/feature.js", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": "# Title\nTODO: fill later" },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(emptyDoc.ok, false);
  assert.equal(emptyDoc.violations[0].code, "DOCUMENTATION_EVIDENCE_INVALID");

  // 9. New CLI command without usage/options documentation -> reject
  const cliNoDocs = evaluateGovernanceGate({
    state: baseState,
    changedPaths: ["bin/cli.js", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": "# Feature\n\nThis document describes internal refactoring of files only.\n\nMore prose here." },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(cliNoDocs.ok, false);
  assert.equal(cliNoDocs.violations[0].code, "DOCUMENTATION_EVIDENCE_INVALID");

  // 10. New API without contract documentation -> reject
  const apiNoDocs = evaluateGovernanceGate({
    state: baseState,
    changedPaths: ["routes/api_v2.php", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": "# Feature\n\nUpdated internal notes for the team.\n\nNo technical details." },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(apiNoDocs.ok, false);
  assert.equal(apiNoDocs.violations[0].code, "DOCUMENTATION_EVIDENCE_INVALID");

  // 11. Documentation-only task -> no unnecessary CLI-First requirement
  const docOnly = structuredClone(baseState);
  docOnly.taskType = "other";
  docOnly.taskDescription = "Update governance documentation";
  docOnly.governance.cliFirstEvidence = null;
  const r11 = evaluateGovernanceGate({
    state: docOnly,
    changedPaths: ["docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": validDocBody() },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(r11.ok, true);
  assert.equal(r11.classification.taskClass, "DOCUMENTATION_ONLY");

  // 12. Internal bug fix without doc impact & verified rationale -> allow
  const bugFix = structuredClone(baseState);
  bugFix.taskType = "bugfix";
  bugFix.taskDescription = "Fix internal null guard";
  bugFix.governance.documentationEvidence = {
    status: "NOT_REQUIRED_WITH_REASON",
    rationale: "Internal null check fix; no documented CLI, API, or user-facing behavior changed.",
    repository: "programinglive/dev-workflow-mcp-server",
    revision: 0,
    policyVersion: "1.0.0",
    policyDigest: policies.digest,
  };
  const r12 = evaluateGovernanceGate({
    state: bugFix,
    changedPaths: ["src/guard.js"],
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(r12.ok, true);

  // 13. Stale documentation evidence -> reject
  const staleDoc = evaluateGovernanceGate({
    state: baseState,
    changedPaths: ["src/feature.js", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": validDocBody() },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 2,
  });
  assert.equal(staleDoc.ok, false);
  assert.equal(staleDoc.violations[0].code, "POLICY_EVIDENCE_STALE");

  // 14. Documentation containing credentials -> fail security check
  const credDoc = evaluateGovernanceGate({
    state: baseState,
    changedPaths: ["src/feature.js", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": `${validDocBody()}\nToken: ghp_1234567890abcdef1234567890abcdef1234\n` },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(credDoc.ok, false);
  assert.equal(credDoc.violations[0].code, "DOCUMENTATION_SECURITY_VIOLATION");
});

test("Workflow Governance 15-25: exceptions, repo/commit binding, CI failure, version mismatch, scope expansion, and MCP handlers", async () => {
  const policies = loadPolicies();

  // 17 & 18. Unauthorized vs authorized exceptions
  const selfApproved = validatePolicyException(
    {
      policyId: "architecture.cli_first",
      repository: "programinglive/dev-workflow-mcp-server",
      justification: "Legacy module",
      scope: "one controller",
      risk: "low",
      owner: "agent-a",
      approver: "agent-a",
    },
    { policyId: "architecture.cli_first", repository: "programinglive/dev-workflow-mcp-server" }
  );
  assert.equal(selfApproved.ok, false);

  const authorizedEx = validatePolicyException(
    {
      policyId: "architecture.cli_first",
      repository: "programinglive/dev-workflow-mcp-server",
      justification: "Legacy controller migration scheduled in Focus #96",
      scope: "LegacyReportController",
      risk: "low",
      owner: "agent-a",
      approver: "mahar",
      expiresAt: "2099-01-01T00:00:00Z",
    },
    { policyId: "architecture.cli_first", repository: "programinglive/dev-workflow-mcp-server" }
  );
  assert.equal(authorizedEx.ok, true);

  // 19. Wrong repository evidence -> reject
  const wrongRepo = evaluateGovernanceGate({
    state: {
      taskType: "feature",
      taskDescription: "Feature",
      governance: {
        effectiveMode: "enforce",
        repository: "programinglive/dev-workflow-mcp-server",
        ...validEvidence(),
      },
    },
    changedPaths: ["src/a.js", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": validDocBody() },
    currentRepo: "beautyworld_repository/clinic",
    currentRevision: 0,
  });
  assert.equal(wrongRepo.ok, false);

  // 20. Incorrect commit evidence -> reject
  const wrongCommitState = {
    taskType: "feature",
    taskDescription: "Feature",
    governance: {
      effectiveMode: "enforce",
      repository: "programinglive/dev-workflow-mcp-server",
      ...validEvidence({
        cliFirstEvidence: {
          summary: "npm test -> 100 pass",
          headlessTestsPassed: true,
          repository: "programinglive/dev-workflow-mcp-server",
          commitSha: "deadbeef1234",
          policyVersion: "1.0.0",
          policyDigest: policies.digest,
        },
      }),
    },
  };
  const wrongCommit = evaluateGovernanceGate({
    state: wrongCommitState,
    changedPaths: ["src/a.js", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": validDocBody() },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: "cafebabe5678",
  });
  assert.equal(wrongCommit.ok, false);

  // 22. Legacy task compatibility
  const legacyRes = evaluateGovernanceGate({ state: { taskType: "feature", governance: null } });
  assert.equal(legacyRes.ok, true);
  assert.equal(legacyRes.mode, "legacy");

  // 23. Required CI failed -> reject
  const ciFailed = evaluateGovernanceGate({
    state: {
      taskType: "feature",
      taskDescription: "Feature",
      governance: {
        effectiveMode: "enforce",
        repository: "programinglive/dev-workflow-mcp-server",
        ...validEvidence(),
      },
    },
    changedPaths: ["src/a.js", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": validDocBody() },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
    ciStatus: "failed",
  });
  assert.equal(ciFailed.ok, false);
  assert.equal(ciFailed.violations[0].code, "REQUIRED_CI_FAILED");

  // 24. Policy version mismatch -> reject
  const versionMismatch = evaluateGovernanceGate({
    state: {
      taskType: "feature",
      taskDescription: "Feature",
      governance: {
        effectiveMode: "enforce",
        repository: "programinglive/dev-workflow-mcp-server",
        ...validEvidence({
          cliFirstEvidence: {
            summary: "npm test -> 100 pass",
            headlessTestsPassed: true,
            repository: "programinglive/dev-workflow-mcp-server",
            revision: 0,
            policyVersion: "0.9.0",
            policyDigest: policies.digest,
          },
        }),
      },
    },
    changedPaths: ["src/a.js", "docs/GOVERNANCE.md"],
    docContents: { "docs/GOVERNANCE.md": validDocBody() },
    currentRepo: "programinglive/dev-workflow-mcp-server",
    currentRevision: 0,
  });
  assert.equal(versionMismatch.ok, false);

  // 25. Scope expands from UI-only to business logic -> re-evaluate both policies
  const scopeExpanded = classifyTask({
    taskType: "other",
    description: "Adjust CSS button styling",
    changedPaths: ["public/css/app.css", "app/Services/PricingService.php"],
  });
  assert.equal(scopeExpanded.taskClass, "NEW_FEATURE");
  assert.equal(scopeExpanded.cliFirstApplicability, "REQUIRED");
  assert.equal(scopeExpanded.documentationApplicability, "REQUIRED");

  // End-to-end MCP handler integration test: start_task -> mark_dod_item -> complete_task refuses missing -> create_documentation -> complete_task succeeds
  const repoDir = makeTempGitRepo();
  const ws = makeWorkflowState(repoDir);
  const startRes = await handleStartTask(
    {
      description: "Add new governance validation command",
      type: "feature",
      projectDir: repoDir,
      definitionOfDone: ["CLI-First headless service tests pass", "Documentation updated"],
      plan: ["Implement service", "Document and test"],
      mermaidFlow: "flowchart TD\nA[Start] --> B[Done]",
      governanceMode: "enforce",
    },
    ws,
    null
  );
  assert.ok(!startRes.content[0].text.startsWith("⚠️"), startRes.content[0].text);
  assert.equal(ws.state.governance.effectiveMode, "enforce");

  // Marking CLI-First DoD with fake evidence is rejected by handleMarkDodItem
  const fakeDodRes = await handleMarkDodItem({ id: "dod-1", evidence: "cli_first=ok" }, ws);
  assert.ok(fakeDodRes.content[0].text.includes("CLI_FIRST_EVIDENCE_INVALID"));

  // Marking CLI-First DoD with valid test evidence succeeds
  const okDod1 = await handleMarkDodItem(
    { id: "dod-1", evidence: "node --test tests/governance-policies.test.js -> 3 pass" },
    ws
  );
  assert.ok(okDod1.content[0].text.startsWith("✅"));

  const okDod2 = await handleMarkDodItem(
    { id: "dod-2", evidence: "docs/GOVERNANCE.md updated with CLI usage and options" },
    ws
  );
  assert.ok(okDod2.content[0].text.startsWith("✅"));

  // Attempting complete_task without create_documentation -> blocked by governance gate!
  ws.state.testsPassed = true;
  ws.state.releaseSkipped = true;
  ws.state.releaseSkippedReason = "Unit test only";
  await ws.save();

  const blockedComplete = await handleCompleteTask(
    {
      commitMessage: "feat: add governance",
      nextSteps: ["Monitor pilot rollout in clinic"],
    },
    ws,
    {
      governanceInput: {
        changedPaths: ["bin/cli.js"],
        docContents: {},
        repository: "programinglive/dev-workflow-mcp-server",
        revision: 0,
      },
    }
  );
  assert.ok(blockedComplete.content[0].text.includes("DOCUMENTATION_REQUIRED"), blockedComplete.content[0].text);

  // Now create actual documentation file and record it via handleCreateDocumentation
  mkdirSync(path.join(repoDir, "docs"), { recursive: true });
  writeFileSync(path.join(repoDir, "docs", "GOVERNANCE.md"), validDocBody());
  const docRes = await handleCreateDocumentation(
    {
      documentationType: "guide",
      summary: "Added CLI-First and Documentation-as-Code governance guide",
      files: ["docs/GOVERNANCE.md"],
    },
    ws,
    {
      git: {
        getStatusOutput: async () => "?? docs/GOVERNANCE.md\n",
      },
    }
  );
  assert.ok(docRes.content[0].text.startsWith("✅"), docRes.content[0].text);

  // Now complete_task succeeds!
  const okComplete = await handleCompleteTask(
    {
      commitMessage: "feat: add governance",
      nextSteps: ["Monitor pilot rollout in clinic"],
    },
    ws,
    {
      governanceInput: {
        changedPaths: ["bin/cli.js", "docs/GOVERNANCE.md"],
        docContents: { "docs/GOVERNANCE.md": validDocBody() },
        repository: "programinglive/dev-workflow-mcp-server",
        revision: 0,
      },
    }
  );
  assert.ok(!okComplete.content[0].text.includes("⚠️"), okComplete.content[0].text);

  // CI validator on repoDir without evidence fails with exitCode 1
  const ciFail = runCiGovernanceValidation({ projectDir: repoDir, policy: "all" });
  assert.equal(ciFail.ok, false);
  assert.equal(ciFail.exitCode, 1);

  // force_complete_task cannot silently bypass governance
  const repoDir2 = makeTempGitRepo();
  const ws2 = makeWorkflowState(repoDir2);
  await handleStartTask(
    {
      description: "Implement new billing CLI",
      type: "feature",
      projectDir: repoDir2,
      definitionOfDone: ["Done"],
      plan: ["Step 1"],
      mermaidFlow: "flowchart TD\nA-->B",
      governanceMode: "enforce",
    },
    ws2,
    null
  );
  const silentForce = await handleForceCompleteTask(
    { commitMessage: "wip", reason: "" },
    ws2,
    {
      governanceInput: {
        changedPaths: ["bin/cli.js"],
        docContents: {},
        repository: "programinglive/dev-workflow-mcp-server",
        revision: 0,
      },
    }
  );
  assert.ok(silentForce.content[0].text.includes("POLICY_FORCE_REASON_REQUIRED"));

  // Reason alone without privileged authorization is rejected (POLICY_OVERRIDE_UNAUTHORIZED)
  const reasonOnlyForce = await handleForceCompleteTask(
    { commitMessage: "wip", reason: "Long enough reason string without approval" },
    ws2,
    {
      governanceInput: {
        changedPaths: ["bin/cli.js"],
        docContents: {},
        repository: "programinglive/dev-workflow-mcp-server",
        revision: 0,
      },
    }
  );
  assert.ok(reasonOnlyForce.content[0].text.includes("POLICY_OVERRIDE_UNAUTHORIZED"));

  // Self-approval by an agent is rejected
  const selfApprovedForce = await handleForceCompleteTask(
    {
      commitMessage: "wip",
      reason: "Emergency rollback; remediation tracked in Todo #900",
      approvedBy: "codex",
      approvalTicket: "INC-900",
    },
    ws2,
    {
      governanceInput: {
        changedPaths: ["bin/cli.js"],
        docContents: {},
        repository: "programinglive/dev-workflow-mcp-server",
        revision: 0,
      },
    }
  );
  assert.ok(selfApprovedForce.content[0].text.includes("POLICY_OVERRIDE_UNAUTHORIZED"));

  // Privileged owner authorization succeeds and records audit trail
  const auditedForce = await handleForceCompleteTask(
    {
      commitMessage: "wip",
      reason: "Emergency rollback; remediation tracked in Todo #900",
      approvedBy: "mahar",
      approvalTicket: "OWNER-INC-900",
    },
    ws2,
    {
      governanceInput: {
        changedPaths: ["bin/cli.js"],
        docContents: {},
        repository: "programinglive/dev-workflow-mcp-server",
        revision: 0,
      },
    }
  );
  assert.ok(auditedForce.content[0].text.includes("force-completed"));
  const lastHistory = ws2.state.history.at(-1);
  assert.equal(lastHistory.governanceBypassed, true);
  assert.equal(lastHistory.approvedBy, "mahar");
  assert.equal(lastHistory.approvalTicket, "OWNER-INC-900");
  assert.ok(lastHistory.governanceViolations.length >= 1);
});
