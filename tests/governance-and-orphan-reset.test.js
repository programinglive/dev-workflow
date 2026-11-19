import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyTask, CLI_FIRST_APPLICABILITY } from "../governance/classifier.js";
import { evaluateGovernanceGate, loadPolicies } from "../governance/engine.js";
import { handleToolCall } from "../tools/handlers.js";
import { WorkflowState } from "../workflow-state.js";

function baseGovState(overrides = {}) {
  const policies = loadPolicies();
  return {
    taskType: "bugfix",
    taskDescription: "Audit 6 unresolved Sentry issues against production release",
    taskStartedAt: "2026-11-19T02:00:00.000Z",
    dodRevision: 0,
    governance: {
      schemaVersion: policies.schemaVersion,
      rolloutStage: "PILOT_BLOCKING",
      effectiveMode: "enforce",
      policyDigest: policies.digest,
      policyVersions: {
        "architecture.cli_first": "1.0.0",
        "engineering.documentation_required": "1.0.0",
      },
      repository: "beautyworld_repository/clinic",
      cliFirstEvidence: null,
      documentationEvidence: {
        status: "NOT_REQUIRED_WITH_REASON",
        rationale: "Read-only audit with zero source code modifications.",
        repository: "beautyworld_repository/clinic",
        revision: 0,
        policyVersion: "1.0.0",
        policyDigest: policies.digest,
      },
      exceptions: [],
      legacyExempt: false,
    },
    ...overrides,
  };
}

test("CLI-First is NOT_APPLICABLE for read-only audits, bugfixes, refactors, and maintenance without CLI changes", () => {
  const audit = classifyTask({
    taskType: "bugfix",
    description: "Audit 6 Sentry issues in clinic",
    changedPaths: [],
  });
  assert.equal(audit.cliFirstApplicability, CLI_FIRST_APPLICABILITY.NOT_APPLICABLE);

  const bugfix = classifyTask({
    taskType: "bugfix",
    description: "Fix null pointer in SalesInvoiceController",
    changedPaths: ["app/Http/Controllers/SalesInvoiceController.php"],
  });
  assert.equal(bugfix.cliFirstApplicability, CLI_FIRST_APPLICABILITY.NOT_APPLICABLE);

  const maintenance = classifyTask({
    taskType: "other",
    description: "Bump lockfile and clean stale cache",
    changedPaths: [],
  });
  assert.equal(maintenance.cliFirstApplicability, CLI_FIRST_APPLICABILITY.NOT_APPLICABLE);

  // New feature still requires CLI-First assessment
  const feature = classifyTask({
    taskType: "feature",
    description: "Implement new invoice export module",
    changedPaths: ["app/Services/InvoiceExportService.php"],
  });
  assert.equal(feature.cliFirstApplicability, CLI_FIRST_APPLICABILITY.REQUIRED);

  // Read-only audit passes evaluateGovernanceGate without cliFirstEvidence
  const gate = evaluateGovernanceGate({
    state: baseGovState(),
    changedPaths: [],
    currentRepo: "beautyworld_repository/clinic",
    currentRevision: 0,
  });
  assert.equal(gate.ok, true, `Expected read-only audit to pass gate, got: ${JSON.stringify(gate.violations)}`);
});

test("force_complete_task and drop_task succeed when projectDir worktree was already deleted", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devwf-orphan-state-"));
  const deletedWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "devwf-deleted-wt-"));
  const stateFile = path.join(stateRoot, ".state", "workflow-state.json");

  try {
    const ws = new WorkflowState(stateFile, { requireKernelMutex: true });
    await ws.load();

    // Simulate active task bound to a worktree that gets deleted before force_complete_task
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "Audit task in temporary worktree";
    ws.state.taskType = "bugfix";
    ws.state.projectDir = deletedWorktree;
    ws.state.definitionOfDone = [{ id: "dod-1", text: "Audit done", status: "done", revision: 0 }];
    ws.state.dodRevision = 0;

    // Delete the worktree directory BEFORE calling force_complete_task
    fs.rmSync(deletedWorktree, { recursive: true, force: true });

    const forceRes = await handleToolCall({
      request: {
        params: {
          name: "force_complete_task",
          arguments: {
            commitMessage: "chore(audit): done",
            reason: "Worktree already cleaned up after read-only audit.",
          },
        },
      },
      normalizeRequestArgs: (a) => ({ args: a || {} }),
      workflowState: ws,
      zettlyOptions: { env: { ZETTLY_SYNC_ENABLED: "false" } },
    });

    assert.equal(Boolean(forceRes.isError), false, `force_complete_task failed: ${forceRes.content?.[0]?.text}`);
    assert.match(forceRes.content[0].text, /Task force-completed/);
    assert.equal(ws.state.currentPhase, "idle");

    // Repeat with drop_task on a deleted projectDir
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "Second task in deleted worktree";
    ws.state.projectDir = deletedWorktree;

    const dropRes = await handleToolCall({
      request: {
        params: {
          name: "drop_task",
          arguments: { reason: "Cleaning up orphaned session" },
        },
      },
      normalizeRequestArgs: (a) => ({ args: a || {} }),
      workflowState: ws,
      zettlyOptions: { env: { ZETTLY_SYNC_ENABLED: "false" } },
    });

    assert.equal(Boolean(dropRes.isError), false, `drop_task failed: ${dropRes.content?.[0]?.text}`);
    assert.match(dropRes.content[0].text, /Task dropped/);
    assert.equal(ws.state.currentPhase, "idle");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    if (fs.existsSync(deletedWorktree)) {
      fs.rmSync(deletedWorktree, { recursive: true, force: true });
    }
  }
});
