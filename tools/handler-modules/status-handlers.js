import { textResponse, formatChecklist, isReleaseSatisfied, getContinueGuidance, resetToCommitIfWorkingChanges } from "./shared.js";
import { handleCommitAndPush } from "./commit-handlers.js";

export async function handleGetWorkflowStatus(workflowState) {
  const status = workflowState.state;
  const nextStep = status ? status.currentPhase : "idle";

  // Deteksi berkas state yang terakhir ditulis proses MCP lain. Tanpa
  // peringatan ini, agen bisa meng-commit atas nama task orang lain.
  let sharedWarning = "";
  try {
    const disk = await workflowState.readDiskState();
    if (workflowState.isForeignWrite(disk)) {
      const owner = disk.owner || {};
      sharedWarning =
        `\n\n⚠️ PERINGATAN: berkas state ini terakhir ditulis proses MCP LAIN ` +
        `(${owner.processMarker || "tanpa-token"}, pid ${owner.pid ?? "?"}).\n` +
        `   State workflow dipakai bersama antar sesi di mesin ini.\n` +
        `   Periksa apakah "Task:" di atas benar-benar milik Anda SEBELUM commit_and_push.`;
      if (disk.currentPhase && disk.currentPhase !== "idle" && disk.taskDescription) {
        sharedWarning += `\n   Proses itu sedang mengerjakan: "${disk.taskDescription}"`;
      }
    }
  } catch {
    // Status tetap ditampilkan walau pemeriksaan berkas gagal.
  }

  return textResponse(
    `📊 Current Workflow Status:

Phase: ${status.currentPhase}
Task: ${status.taskDescription || "(none)"}
Feature flow: ${status.featureFlowCreated ? "✅" : "❌"}
Bug fixed: ${status.bugFixed ? "✅" : "❌"}
Tests created: ${status.testsCreated ? "✅" : "❌"}
Tests passed: ${status.testsPassed ? "✅" : "❌"}
Documentation: ${status.documentationCreated ? "✅" : "❌"}
Ready check: ${status.readyCheckCompleted ? "✅" : "❌"}
Commit & push: ${status.commitAndPushCompleted ? "✅" : "❌"}
Released: ${status.released ? "✅" : "❌"}

Next step: ${nextStep}${sharedWarning}`
  );
}

export async function handleReadyCheck(workflowState) {
  const status = workflowState.state;
  const testsCreatedDone = status.testsSkipped || status.testsCreated;
  const testsPassedDone = status.testsSkipped || status.testsPassed;
  const checks = [
    { name: "Task started", done: status.currentPhase !== "idle" },
    { name: "Feature flow described", done: status.featureFlowCreated },
    { name: "Feature/bug fixed", done: status.bugFixed },
    {
      name: status.testsSkipped ? "Tests skipped (manual QA documented)" : "Tests created",
      done: testsCreatedDone,
    },
    {
      name: status.testsSkipped ? "Tests skipped acknowledged" : "Tests passed",
      done: testsPassedDone,
    },
    { name: "Documentation created", done: status.documentationCreated },
  ];

  const allDone = checks.every((c) => c.done);
  const checkList = formatChecklist(checks);

  workflowState.state.readyCheckCompleted = allDone;
  if (allDone) {
    if (workflowState.state.commitAndPushCompleted) {
      workflowState.state.currentPhase = isReleaseSatisfied(workflowState.state) ? "ready_to_complete" : "release";
    } else {
      workflowState.state.currentPhase = "commit";
    }
  }
  await workflowState.save();

  if (allDone) {
    return textResponse(
      `🎉 ALL CHECKS PASSED!\n\n${checkList}\n\n✅ Next actions:\n1. Run 'commit_and_push' (commits and pushes your changes)\n2. Run 'perform_release' (handles versioning, tags, and final push)\n3. Finish with 'complete_task'\n\nTip: Provide the optional 'branch' argument to 'commit_and_push' to push to a non-default branch.\n\nTask: ${status.taskDescription}`
    );
  }

  return textResponse(`⚠️ NOT READY TO COMMIT!\n\n${checkList}\n\nPlease complete all steps before committing.`);
}

export async function handleContinueWorkflow(workflowState, context) {
  const status = workflowState.state;

  if (!status || status.currentPhase === "idle") {
    return textResponse("⚠️ No active workflow. Use 'start_task' to kick off a new task before continuing.");
  }

  if (await resetToCommitIfWorkingChanges(workflowState, context.git)) {
    return textResponse(
      "⚠️ Detected new changes after the last commit. Workflow moved back to the commit phase. Run 'commit_and_push' to capture the latest updates before continuing."
    );
  }

  if (status.currentPhase === "ready") {
    return handleReadyCheck(workflowState);
  }

  if (status.currentPhase === "commit") {
    return handleCommitAndPush({}, context);
  }

  if (status.currentPhase === "release") {
    return textResponse(
      "⚠️ Release phase requires explicit command. Run 'perform_release' with your release command (e.g., 'npm run release')."
    );
  }

  const sections = [
    `📊 Current Phase: ${status.currentPhase}`,
    `📝 Task: ${status.taskDescription || "(none)"}`,
  ];

  if (status.testsSkipped) {
    sections.push(`⚠️ Tests skipped: ${status.testsSkippedReason || "(no reason provided)"}`);
  }

  if (
    status.currentPhase === "testing" &&
    status.testsCreated &&
    !status.testsPassed &&
    typeof status.testCommand === "string" &&
    status.testCommand.trim() !== ""
  ) {
    sections.push(`🧪 Last test command: ${status.testCommand}`);
  }

  sections.push(`➡️ ${getContinueGuidance(status)}`);

  return textResponse(sections.join("\n\n"));
}

export async function handleRerunWorkflow(workflowState) {
  const currentDescription = workflowState.state.taskDescription;
  const currentType = workflowState.state.taskType;

  if (!currentDescription) {
    return textResponse("⚠️ No active task to rerun. Use 'start_task' to begin a new workflow.");
  }

  workflowState.reset();

  workflowState.state.currentPhase = "coding";
  workflowState.state.taskDescription = currentDescription;
  workflowState.state.taskType = currentType;
  await workflowState.save();

  return textResponse(
    `🔄 Rerunning workflow from the start!\n\nTask: ${currentDescription}\nType: ${currentType}\n\nWorkflow Steps:\n1. ✓ Start task (current)\n2. ⏳ Describe feature flow with Mermaid\n3. ⏳ Fix/implement the feature\n4. ⏳ Create tests\n5. ⏳ Run tests (must pass!)\n6. ⏳ Create documentation\n7. ⏳ Run 'check_ready_to_commit'\n8. ⏳ Run 'commit_and_push' (commits and pushes)\n9. ⏳ Run 'perform_release' (handles versioning and tags)\n10. ⏳ Complete task\n\n🎯 Be conscious about what you're coding!`
  );
}
