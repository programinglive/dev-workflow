import { textResponse, isReleaseSatisfied, formatChecklist } from "./shared.js";
import { handleReadyCheck } from "./status-handlers.js";
import { containsTestFilesInStatus } from "../../git-helpers.js";
import { resolveProjectDir, setActiveProjectDir, getActiveProjectDir } from "../../exec.js";

/**
 * Label repo yang benar-benar dipakai, untuk ditampilkan di setiap jawaban.
 *
 * Tanpa ini, "No changes detected" tidak bisa dibedakan antara "sudah commit"
 * dan "git berjalan di repo yang salah". Itu persis yang menyamarkan commit
 * salah arah pada 30 Oktober 2026.
 */
function repoLabel() {
  try {
    const resolved = resolveProjectDir({
      explicit: getActiveProjectDir(),
      env: process.env,
      candidates: [process.cwd(), process.env.INIT_CWD],
    });
    const origin = resolved.source === "env" ? " — dari WORKFLOW_PROJECT_DIR (global)" : "";
    return resolved.dir + origin;
  } catch {
    return "(tidak bisa ditentukan)";
  }
}

/**
 * Terapkan `projectDir` dari argumen tool bila ada.
 * Mengembalikan pesan kesalahan, atau null bila tidak ada masalah.
 */
function applyProjectDirOverride(args) {
  const requested = typeof args.projectDir === "string" ? args.projectDir.trim() : "";
  if (!requested) {
    return null;
  }

  try {
    const resolved = resolveProjectDir({ explicit: requested });
    setActiveProjectDir(resolved.dir);
    return null;
  } catch (error) {
    return `❌ projectDir tidak valid: ${error.message}`;
  }
}

export async function handleCommitAndPush(args, context) {
  const { workflowState, exec, git, utils } = context;

  const projectDirError = applyProjectDirOverride(args);
  if (projectDirError) {
    return textResponse(projectDirError);
  }

  workflowState.state.projectDir = getActiveProjectDir() || workflowState.state.projectDir || "";

  if (!workflowState.state.readyToCommit || !workflowState.state.readyCheckCompleted) {
    const readyResponse = await handleReadyCheck(workflowState);
    if (workflowState.state.currentPhase !== "commit") {
      return readyResponse;
    }
  }

  const providedCommitMessage =
    typeof args.commitMessage === "string" ? args.commitMessage.trim() : "";

  const requestedBranch = typeof args.branch === "string" ? args.branch.trim() : "";

  // Preflight: kalau git tidak bisa dijalankan, jangan menebak. Dulu rantai ini
  // gagal, error ditelan helper, lalu tool menjawab "No changes detected" dan
  // menandai commit selesai padahal tidak ada commit sama sekali.
  let primaryBranch;
  let currentBranch;
  let hasWorkingChanges;
  try {
    primaryBranch = await git.getPrimaryBranch();
    currentBranch = await git.getCurrentBranch();
    hasWorkingChanges = await git.hasWorkingChanges();
  } catch (error) {
    return textResponse(
      `❌ Tidak bisa memeriksa repository Git, jadi tidak ada yang di-commit.\n\n` +
      `Repo: ${repoLabel()}\n` +
      `Penyebab: ${error.message}\n\n` +
      `Sebutkan 'projectDir' pada 'start_task' atau 'commit_and_push' untuk menunjuk repo yang benar.`
    );
  }

  const branchForPush = requestedBranch || primaryBranch || currentBranch || "";

  if (!hasWorkingChanges) {
    const lastCommitMessage = await git.getLastCommitMessage();
    const effectiveCommitMessage = lastCommitMessage || providedCommitMessage;

    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.lastCommitMessage = effectiveCommitMessage || "";
    workflowState.state.lastPushBranch = branchForPush;
    workflowState.state.currentPhase = isReleaseSatisfied(workflowState.state) ? "ready_to_complete" : "release";
    await workflowState.save();

    return textResponse(
      `ℹ️ No changes detected. Assuming commit and push already completed.\nRepo: ${repoLabel()}\nLast commit: ${effectiveCommitMessage || "(unavailable)"
      }\n\nNext: Run 'perform_release' to handle the release and push tags.`
    );
  }

  const statusOutput = await git.getStatusOutput();

  if (!workflowState.state.testsSkipped && !containsTestFilesInStatus(statusOutput)) {
    return textResponse("⚠️ Please include test updates in your changes before running 'commit_and_push'. Ensure at least one test file is modified.");
  }

  try {
    await exec("git add .");
  } catch (error) {
    return textResponse(
      `❌ Failed to stage files:\n\n${error.stderr || error.stdout || error.message}`
    );
  }

  const stagedChanges = await git.getStagedChanges();
  const { summary: generatedSummary, body: commitBody } = utils.createCommitMessageParts(
    stagedChanges,
    providedCommitMessage
  );

  if (!generatedSummary) {
    return textResponse("⚠️ Unable to generate commit message. Please provide a 'commitMessage' manually.");
  }

  try {
    const commitArguments=['commit','-m',generatedSummary];
    if(commitBody)commitArguments.push('-m',commitBody);
    await exec('git commit',{executable:'git',arguments:commitArguments});
  } catch (error) {
    const output = error.stderr || error.stdout || error.message || "Unknown error";
    if (output.includes("nothing to commit")) {
      return textResponse(
        "⚠️ Nothing to commit. Make additional changes before running 'commit_and_push'."
      );
    }

    return textResponse(`❌ git commit failed:\n\n${output}`);
  }

  try {
    const pushCommand = branchForPush
      ? `git push origin ${utils.shellEscape(branchForPush)}`
      : "git push";
    await exec(pushCommand);
  } catch (error) {
    return textResponse(
      `❌ git push failed:\n\n${error.stderr || error.stdout || error.message}`
    );
  }

  workflowState.state.commitAndPushCompleted = true;
  workflowState.state.lastCommitMessage = generatedSummary;
  workflowState.state.lastPushBranch = branchForPush;
  workflowState.state.currentPhase = isReleaseSatisfied(workflowState.state) ? "ready_to_complete" : "release";
  await workflowState.save();

  return textResponse(
    `✅ Commit and push completed!\nRepo: ${repoLabel()}\n\nCommit message: ${generatedSummary}\nPushed to: ${branchForPush || "(default upstream)"
    }\n\nNext: Run 'perform_release' to handle the release and push tags.`
  );
}

export async function handleCompleteTask(args, workflowState) {
  const entry = {
    taskDescription: workflowState.state.taskDescription,
    taskType: workflowState.state.taskType,
    commitMessage: args.commitMessage,
  };

  workflowState.addToHistory(entry);
  workflowState.reset();
  await workflowState.save();

  return textResponse(
    `✅ Task completed!\n\nCommit message: ${args.commitMessage}\nHistory recorded.`
  );
}

export async function handleForceCompleteTask(args, workflowState) {
  const commitMessageArg =
    typeof args.commitMessage === "string" ? args.commitMessage.trim() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";

  const commitMessage =
    commitMessageArg || workflowState.state.lastCommitMessage || "(no commit recorded)";

  workflowState.addToHistory({
    taskDescription: workflowState.state.taskDescription,
    taskType: workflowState.state.taskType,
    commitMessage,
    forced: true,
    forceReason: reason,
  });

  workflowState.reset();
  await workflowState.save();

  const reasonText = reason ? reason : "(none provided)";

  return textResponse(
    `⚠️ Task force-completed.\n\nRecorded commit message: ${commitMessage}\nReason: ${reasonText}\nWorkflow state reset. Start a new task when ready.`
  );
}

export async function handleDropTask(args, workflowState) {
  workflowState.addToHistory({
    taskDescription: workflowState.state.taskDescription,
    taskType: workflowState.state.taskType,
    commitMessage: workflowState.state.lastCommitMessage,
    dropped: true,
    dropReason: typeof args.reason === "string" ? args.reason : "",
  });
  workflowState.reset();
  await workflowState.save();

  return textResponse("⚠️ Task dropped. Workflow state reset.");
}
