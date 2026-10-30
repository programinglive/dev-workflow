import { textResponse, isReleaseSatisfied, resetToCommitIfWorkingChanges, summarizeHistory } from "./shared.js";

export async function handleSkipRelease(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Please start a task first using 'start_task' before skipping release.");
  }

  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) {
    return textResponse("⚠️ Provide a non-empty 'reason' explaining why the release step is being skipped.");
  }

  if (workflowState.state.releaseSkipped) {
    workflowState.state.releaseSkippedReason = reason;
    await workflowState.save();
    return textResponse(
      `ℹ️ Release step was already skipped for this task.\nUpdated reason: ${reason}\n\nNext: run 'complete_task' to wrap up.`
    );
  }

  if (workflowState.state.released) {
    return textResponse("⚠️ A release command has already been recorded. Continue with 'complete_task'.");
  }

  if (!workflowState.state.readyCheckCompleted) {
    return textResponse("⚠️ Please run 'check_ready_to_commit' and ensure all prerequisites pass before skipping release.");
  }

  if (!workflowState.state.commitAndPushCompleted) {
    return textResponse("⚠️ Please complete 'commit_and_push' before skipping release.");
  }

  workflowState.state.releaseSkipped = true;
  workflowState.state.releaseSkippedReason = reason;
  workflowState.state.released = false;
  workflowState.state.releaseCommand = "(skipped)";
  workflowState.state.releaseNotes = "";
  workflowState.state.currentPhase = "ready_to_complete";
  await workflowState.save();

  return textResponse(
    `⚠️ Release step skipped.\nReason: ${reason}\n\n✅ Next: run 'complete_task' with your final commit message to close out the workflow.`
  );
}

export async function handlePerformRelease(args, context) {
  const { workflowState, exec, git, utils } = context;

  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Please start a task first using 'start_task'!");
  }

  let hasNewChanges;
  try {
    hasNewChanges = await resetToCommitIfWorkingChanges(workflowState, git);
  } catch (error) {
    return textResponse(
      `❌ Tidak bisa memeriksa repository Git, jadi status rilis tidak dapat diverifikasi.\n\n` +
      `Penyebab: ${error.message}\n\n` +
      `Set WORKFLOW_PROJECT_DIR ke direktori proyek, atau jalankan server MCP dari dalam direktori proyek.`
    );
  }

  if (hasNewChanges) {
    return textResponse(
      "⚠️ Detected new changes after the last commit. Please run 'commit_and_push' again before recording a release."
    );
  }

  if (!workflowState.state.readyCheckCompleted) {
    return textResponse(
      "⚠️ Please run 'check_ready_to_commit' and ensure all checks pass before releasing!"
    );
  }

  if (!workflowState.state.commitAndPushCompleted) {
    let hasWorkingChanges;
    try {
      hasWorkingChanges = await git.hasWorkingChanges();
    } catch (error) {
      return textResponse(
        `❌ Tidak bisa memeriksa repository Git, jadi status rilis tidak dapat diverifikasi.\n\n` +
        `Penyebab: ${error.message}\n\n` +
        `Set WORKFLOW_PROJECT_DIR ke direktori proyek, atau jalankan server MCP dari dalam direktori proyek.`
      );
    }

    if (hasWorkingChanges) {
      return textResponse(
        "⚠️ Please run 'commit_and_push' after the ready check before recording a release!"
      );
    }

    workflowState.state.currentPhase = "commit";
    await workflowState.save();

    return textResponse(
      "⚠️ Please run 'commit_and_push' after the ready check before recording a release!"
    );
  }

  const rawReleaseCommand = typeof args.command === "string" ? args.command.trim() : "";
  const releaseTypeArg =
    typeof args.releaseType === "string" ? args.releaseType.trim().toLowerCase() : "";
  const presetArg = typeof args.preset === "string" ? args.preset.trim().toLowerCase() : "";
  const recognizedTypes = new Set(["major", "minor", "patch"]);

  const tokens = rawReleaseCommand
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  let releaseType = "";
  if (recognizedTypes.has(releaseTypeArg)) {
    releaseType = releaseTypeArg;
  } else if (recognizedTypes.has(presetArg)) {
    releaseType = presetArg;
  } else if (tokens.length > 0) {
    const possibleType = tokens[tokens.length - 1];
    if (recognizedTypes.has(possibleType)) {
      releaseType = possibleType;
    }
  }

  let releaseCommand = rawReleaseCommand;
  if (releaseCommand && recognizedTypes.has(releaseCommand.toLowerCase())) {
    releaseType = releaseCommand.toLowerCase();
    releaseCommand = "";
  }

  const scriptTypeMatch = /release:(major|minor|patch)/i.exec(releaseCommand);
  if (scriptTypeMatch) {
    releaseType = scriptTypeMatch[1].toLowerCase();
  }

  if (!releaseCommand && releaseType) {
    releaseCommand = `npm run release:${releaseType}`;
  }

  if (!releaseCommand) {
    return textResponse("⚠️ Please provide a non-empty 'command' when using 'perform_release'.");
  }

  let statusOutput;
  try {
    const { stdout } = await exec("git status --porcelain");
    statusOutput = stdout;
  } catch (error) {
    const details = error.stderr || error.stdout || error.message || "Unknown error";
    return textResponse(
      `⚠️ Unable to verify Git status. Refusing to run the release command until the repository state can be checked.\n\nDetails:\n${details}`
    );
  }

  const statusSummary = git.workingTreeSummary(statusOutput);
  if (statusSummary.hasChanges) {
    const changeDetails =
      statusSummary.lines.length > 0
        ? statusSummary.lines.map((line) => `• ${line}`).join("\n")
        : "• (unable to list changes)";

    return textResponse(
      `⚠️ Working tree not clean! Please commit or stash all changes before running 'perform_release'.\n\nDetected changes:\n${changeDetails}`
    );
  }

  const lastCommitMessage = await git.getLastCommitMessage();
  if (!releaseType) {
    releaseType = utils.determineReleaseTypeFromCommit(
      lastCommitMessage || workflowState.state.lastCommitMessage
    );
  }

  const finalCommand =
    releaseCommand.includes("--release-as") || /release:(major|minor|patch)/i.test(releaseCommand)
      ? releaseCommand
      : `${releaseCommand} -- --release-as ${releaseType}`;

  try {
    await exec(finalCommand);
  } catch (error) {
    return textResponse(
      `❌ Release command failed:\n\n${error.stderr || error.stdout || error.message}`
    );
  }

  const branchForPush = workflowState.state.lastPushBranch || (await git.getCurrentBranch()) || "";
  const pushCommand = branchForPush
    ? `git push --follow-tags origin ${utils.shellEscape(branchForPush)}`
    : "git push --follow-tags";

  try {
    await exec(pushCommand);
  } catch (error) {
    return textResponse(
      `❌ git push (with tags) failed:\n\n${error.stderr || error.stdout || error.message}`
    );
  }

  workflowState.state.released = true;
  workflowState.state.releaseCommand = finalCommand;
  workflowState.state.releaseNotes = typeof args.notes === "string" ? args.notes : "";
  workflowState.state.currentPhase = "ready_to_complete";
  await workflowState.save();

  const message = summarizeHistory(workflowState.state.history, args.limit || 10);
  if (!message) {
    return textResponse("📜 No workflow history yet.");
  }

  return textResponse(message);
}
