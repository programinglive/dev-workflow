import { classify } from '../../security/policy.js';
import { textResponse, isReleaseSatisfied, isErrorResponse, ensurePrdExists } from "./shared.js";

export async function handleStartTask(args, workflowState) {
  // Selamatkan dulu pekerjaan yang mungkin tertimpa. Ini menangani dua kasus:
  //   1. Proses MCP LAIN menulis berkas state setelah kita memuatnya.
  //   2. Task kita sendiri yang belum selesai lalu diganti task baru.
  const preservedBeforeSave = await workflowState.reconcileWithDisk();
  const { archivedTask } = workflowState.reset({ archive: true });

  workflowState.state.currentPhase = "coding";
  workflowState.state.classification = classify(args);
  workflowState.state.taskDescription = args.description;
  workflowState.state.taskType = args.type;
  workflowState.state.testsSkipped = false;
  workflowState.state.testsSkippedReason = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";
  // start_task memang bermaksud MENGGANTI task, jadi ia boleh menang atas
  // task berjalan. Task yang diganti tetap diarsipkan oleh reconcileWithDisk,
  // bukan dihapus.
  const reconciled = await workflowState.save({ allowReplaceRunningTask: true });

  const warnings = [];
  const preservedForeign = reconciled?.preservedTask || preservedBeforeSave?.preservedTask;
  if (preservedForeign) {
    warnings.push(
      `⚠️ Ada task yang SEDANG BERJALAN dari proses agen lain dan hampir tertimpa:\n` +
        `   "${preservedForeign}"\n` +
        `   Task itu sudah disimpan ke history sebagai 'interrupted', bukan dihapus.\n` +
        `   State workflow di mesin ini dipakai bersama antar sesi - periksa sebelum commit.`
    );
  }
  if (archivedTask) {
    warnings.push(
      `ℹ️ Task sebelumnya belum selesai dan diganti: "${archivedTask}".\n` +
        `   Disimpan ke history sebagai 'interrupted'.`
    );
  }
  if (reconciled?.mergedHistory > 0) {
    warnings.push(
      `ℹ️ ${reconciled.mergedHistory} entri history dari proses lain digabungkan, tidak ditimpa.`
    );
  }

  const warningBlock = warnings.length > 0 ? `\n\n${warnings.join("\n\n")}` : "";

  return textResponse(
    `✅ Task Started: ${args.description}${warningBlock}\n\n🎯 Be conscious about what you're coding!\n\nWorkflow Steps:\n1. ✓ Start task (current)\n2. ⏳ Describe feature flow with Mermaid\n3. ⏳ Fix/implement the feature\n4. ⏳ Create tests\n5. ⏳ Run tests (must pass!)\n6. ⏳ Create documentation\n7. ⏳ Run 'check_ready_to_commit'\n8. ⏳ Run 'commit_and_push' (commits and pushes)\n9. ⏳ Run 'perform_release' (handles versioning and tags) or 'skip_release' (when no release is needed)\n10. ⏳ Complete task\n\nReminder: Focus on writing clean, maintainable code!`
  );
}

export async function handleMarkBugFixed(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Please start a task first using 'start_task'!");
  }

  if (workflowState.state.bugFixed) {
    const summary = typeof args.summary === "string" ? args.summary : "";
    if (summary && summary.trim() !== "") {
      workflowState.state.fixSummary = summary;
    }

    if (workflowState.state.testsPassed && workflowState.state.documentationCreated) {
      workflowState.state.currentPhase = "ready";
      workflowState.state.readyToCommit = true;
    } else if (workflowState.state.testsCreated) {
      workflowState.state.currentPhase = "testing";
    }
    workflowState.state.readyCheckCompleted = false;
    workflowState.state.commitAndPushCompleted = false;
    await workflowState.save();

    return textResponse(
      "ℹ️ Already marked as fixed; kept existing tests/documentation. Continue with the next step."
    );
  }

  workflowState.state.bugFixed = true;
  workflowState.state.testsCreated = false;
  workflowState.state.currentPhase = "testing";
  workflowState.state.testsSkipped = false;
  workflowState.state.testsSkippedReason = "";
  workflowState.state.fixSummary = args.summary;
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.released = false;
  workflowState.state.releaseSkipped = false;
  workflowState.state.releaseSkippedReason = "";
  workflowState.state.releaseCommand = "";
  workflowState.state.releaseNotes = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";
  await workflowState.save();

  return textResponse(
    `✅ Feature/Bug marked as fixed!\n\n⚠️ CRITICAL REMINDER: You MUST create tests now!\n\nNext Steps:\n1. ✓ Fix/implement feature\n2. ⏳ Create tests for: ${args.summary}\n3. ⏳ Run tests (must be green!)\n4. ⏳ Create documentation\n5. ⏳ Run 'check_ready_to_commit'\n6. ⏳ Run 'commit_and_push'\n7. ⏳ Run 'perform_release' (or 'skip_release' if no release applies)\n8. ⏳ Complete task\n\n🚫 DO NOT SKIP TESTING!`
  );
}

export async function handleCreateFeatureFlow(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Please start a task first using 'start_task'!");
  }

  const mermaidCode = typeof args.mermaidCode === "string" ? args.mermaidCode.trim() : "";
  const description = typeof args.description === "string" ? args.description.trim() : "";

  if (!mermaidCode || !description) {
    return textResponse("⚠️ Please provide both 'mermaidCode' and 'description' when creating a feature flow.");
  }

  workflowState.state.featureFlowCreated = true;
  workflowState.state.mermaidCode = mermaidCode;
  workflowState.state.featureFlowDescription = description;
  workflowState.state.readyCheckCompleted = false;
  await workflowState.save();

  return textResponse(
    `✅ Feature flow recorded!\n\nDescription: ${description}\n\nNext Steps:\n1. ✓ Start task\n2. ✓ Describe feature flow\n3. ⏳ Fix/implement the feature\n4. ⏳ Create tests\n5. ⏳ Run tests\n6. ⏳ Create documentation\n7. ⏳ Run 'check_ready_to_commit'\n8. ⏳ Run 'commit_and_push'\n9. ⏳ Run 'perform_release'\n10. ⏳ Complete task`
  );
}

export async function handleCreateTests(workflowState) {
  if (!workflowState.state.bugFixed) {
    return textResponse("⚠️ Please mark your feature/bug as fixed first using 'mark_bug_fixed'!");
  }

  workflowState.state.testsCreated = true;
  workflowState.state.testsSkipped = false;
  workflowState.state.testsSkippedReason = "";
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.released = false;
  workflowState.state.releaseSkipped = false;
  workflowState.state.releaseSkippedReason = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";
  await workflowState.save();

  return textResponse(
    "✅ Tests recorded!\n\nNext Steps:\n1. ✓ Fix/implement feature\n2. ✓ Create tests\n3. ⏳ Run tests (must be green!)\n4. ⏳ Create documentation\n5. ⏳ Run 'check_ready_to_commit'\n6. ⏳ Run 'commit_and_push'\n7. ⏳ Run 'perform_release' (or 'skip_release' if appropriate)\n8. ⏳ Complete task\n\n🧪 Run your test command and record the results using 'run_tests'."
  );
}

export async function handleSkipTests(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ No active task. Use 'start_task' before skipping tests.");
  }

  if (!workflowState.state.bugFixed) {
    return textResponse("⚠️ Please mark your feature/bug as fixed first using 'mark_bug_fixed'!");
  }

  const reason = typeof args.reason === "string" ? args.reason.trim() : "";

  if (!reason) {
    return textResponse("⚠️ Provide a non-empty justification when skipping tests.");
  }

  workflowState.state.testsCreated = true;
  workflowState.state.testsPassed = true;
  workflowState.state.testsSkipped = true;
  workflowState.state.testsSkippedReason = reason;
  workflowState.state.currentPhase = "documentation";
  workflowState.state.readyToCommit = false;
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.released = false;
  workflowState.state.releaseSkipped = false;
  workflowState.state.releaseSkippedReason = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";
  await workflowState.save();

  return textResponse(
    `⚠️ Tests skipped for this task.
Reason: ${reason}

Manual verification is now required.

Next Steps:
1. ✓ Fix/implement feature
2. ⚠️ Tests skipped (ensure manual QA)
3. ⏳ Create/update documentation
4. ⏳ Run 'check_ready_to_commit'
5. ⏳ Run 'commit_and_push'
6. ⏳ Run 'perform_release' or 'skip_release'
7. ⏳ Complete task`
  );
}

export async function handleRunTests(args, workflowState) {
  if (!workflowState.state.bugFixed) {
    return textResponse("⚠️ Please mark your feature/bug as fixed first using 'mark_bug_fixed'!");
  }

  if (!workflowState.state.testsCreated) {
    return textResponse("⚠️ Please create tests first using 'create_tests' before recording test results!");
  }

  if (
    typeof args.passed !== "boolean" ||
    typeof args.testCommand !== "string" ||
    args.testCommand.trim() === ""
  ) {
    return textResponse(
      "⚠️ Please provide both 'passed' (boolean) and 'testCommand' (non-empty string) when recording test results."
    );
  }

  workflowState.state.testsPassed = args.passed;
  workflowState.state.testCommand = args.testCommand;
  workflowState.state.testDetails = typeof args.details === "string" ? args.details : "";
  workflowState.state.testsSkipped = false;
  workflowState.state.testsSkippedReason = "";
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.released = false;
  workflowState.state.releaseSkipped = false;
  workflowState.state.releaseSkippedReason = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";

  if (!args.passed) {
    workflowState.state.currentPhase = "testing";
    await workflowState.save();

    return textResponse(
      `❌ TESTS FAILED!\n\n🚫 STOP! DO NOT COMMIT OR PUSH!\n\nYou must:\n1. Fix the failing tests\n2. Run tests again until they pass\n\nTest command: ${args.testCommand}\n\nNever skip or ignore failing tests!`
    );
  }

  workflowState.state.currentPhase = "documentation";
  await workflowState.save();

  return textResponse(
    `✅ All tests passed! 🎉\n\nTest command: ${args.testCommand}\n\n📝 Now create or update documentation using 'create_documentation' with:\n- documentationType: "PRD", "README", "RELEASE_NOTES", "inline-comments", "API-docs", "changelog", or "other"\n- summary: Brief description of what was documented\n\nNext Steps:\n1. ✓ Fix/implement feature\n2. ✓ Create tests\n3. ✓ Run tests (GREEN!)\n4. ⏳ Create/update documentation\n5. ⏳ Run 'check_ready_to_commit'\n6. ⏳ Run 'commit_and_push'\n7. ⏳ Run 'perform_release' (or use 'skip_release' if no release is needed)\n8. ⏳ Complete task`
  );
}

export async function handleCreateDocumentation(args, workflowState) {
  if (!workflowState.state.testsPassed) {
    return textResponse("⚠️ Please ensure tests are passing first! Run 'run_tests' with passed=true.");
  }

  if (!ensurePrdExists()) {
    return textResponse(
      `⚠️ PRD file not found!\n\nExpected location: docs/PRD.md\n\nPlease create or update the PRD before marking documentation as complete.`
    );
  }

  workflowState.state.documentationCreated = true;
  workflowState.state.documentationType = args.documentationType;
  workflowState.state.documentationSummary = args.summary;
  workflowState.state.currentPhase = "ready";
  workflowState.state.readyToCommit = true;
  workflowState.state.readyCheckCompleted = false;
  workflowState.state.released = false;
  workflowState.state.releaseSkipped = false;
  workflowState.state.releaseSkippedReason = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";
  await workflowState.save();

  return textResponse(
    `✅ Documentation created/updated!\n\nType: ${args.documentationType}\nSummary: ${args.summary}\n✅ PRD verified: docs/product/PRD.md exists\n\n🎉 You're ready to verify your work!\n\nNext Steps:\n1. ✓ Fix/implement feature\n2. ✓ Create tests\n3. ✓ Run tests (GREEN!)\n4. ✓ Create/update documentation\n5. ⏳ Run 'check_ready_to_commit' to verify\n6. ⏳ Run 'commit_and_push'\n7. ⏳ Run 'perform_release' (or 'skip_release' when applicable)\n8. ⏳ Mark as complete with 'complete_task'`
  );
}
