import { textResponse, isReleaseSatisfied, resetToCommitIfWorkingChanges, summarizeHistory } from "./shared.js";
import { resolveProjectDir, setActiveProjectDir, getActiveProjectDir } from "../../exec.js";

/**
 * Label repo yang dipakai, untuk ditampilkan di laporan.
 *
 * Sama seperti di commit-handlers: laporan harus menyebut repo yang benar-benar
 * dipakai, bukan tebakan.
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
 * Menjalankan perintah git yang hasilnya hanya dipakai untuk laporan.
 *
 * Kegagalan di sini tidak boleh menggagalkan rilis: kalau `git describe`
 * tidak menemukan tag, itu bukan alasan untuk berhenti. Yang penting adalah
 * rilis tetap berjalan dan laporannya jujur tentang apa yang tidak diketahui.
 */
async function safeExecStdout(exec, command) {
  try {
    const { stdout } = await exec(command);
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

const RELEASE_TAG_Version_REGEX = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const RELEASE_COMMIT_VERSION_REGEX =
  /^(?:chore\(release\)|release(?:\([^)]+\))?):\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/i;

/**
 * Detects whether HEAD is already a release commit or already has a semver
 * release tag pointing directly at HEAD.
 *
 * Why this exists: when an agent or release script has already created the
 * `chore(release): X.Y.Z` commit and `vX.Y.Z` tag before calling `perform_release`
 * to record it, re-running `npm run release` on top of HEAD triggers a second
 * full verification/release cycle and hangs or creates duplicate release commits.
 */
async function detectExistingReleaseOnHead(git, fallbackLastCommitMessage = "") {
  let tags = [];
  if (typeof git?.getTagsAtHead === "function") {
    try {
      const rawTags = await git.getTagsAtHead();
      if (Array.isArray(rawTags)) {
        tags = rawTags.map((t) => String(t || "").trim()).filter(Boolean);
      }
    } catch {
      tags = [];
    }
  }

  let matchedTag = "";
  let tagVersion = "";
  for (const tag of tags) {
    const m = RELEASE_TAG_Version_REGEX.exec(tag);
    if (m) {
      matchedTag = tag;
      tagVersion = m[1];
      break;
    }
  }

  let lastCommitMessage = "";
  if (typeof git?.getLastCommitMessage === "function") {
    try {
      lastCommitMessage = String((await git.getLastCommitMessage()) || "").trim();
    } catch {
      lastCommitMessage = "";
    }
  }
  if (!lastCommitMessage && fallbackLastCommitMessage) {
    lastCommitMessage = String(fallbackLastCommitMessage).trim();
  }

  const firstLine = lastCommitMessage.split(/\r?\n/)[0] || "";
  const commitMatch = RELEASE_COMMIT_VERSION_REGEX.exec(firstLine);
  const commitVersion = commitMatch ? commitMatch[1] : "";

  return {
    alreadyReleased: Boolean(matchedTag || commitVersion),
    matchedTag,
    tagVersion,
    commitVersion,
    lastCommitMessage,
  };
}

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

/**
 * Perubahan yang BUKAN berasal dari sebelum task.
 *
 * Dipakai untuk menyebutkan berkas mana yang menghalangi rilis. Pesan lama
 * hanya berkata "detected new changes" tanpa menyebut apa pun, sehingga orang
 * harus menebak sendiri yang mana.
 */
async function unexpectedChanges(git, baselineEntries) {
  try {
    const statusOutput = await git.getStatusOutput();
    if (typeof git.parseStatusEntries !== "function") {
      return [];
    }
    const known = new Set(
      (Array.isArray(baselineEntries) ? baselineEntries : [])
        .map((entry) => String(entry?.path || "").trim())
        .filter(Boolean),
    );
    return git.parseStatusEntries(statusOutput).filter((entry) => !known.has(entry.path));
  } catch {
    return [];
  }
}

export async function handlePerformRelease(args, context) {
  const { workflowState, exec, git, utils } = context;

  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Please start a task first using 'start_task'!");
  }

  // Sama seperti commit_and_push: projectDir eksplisit menang atas repo sesi.
  const requestedProjectDir =
    typeof args.projectDir === "string" ? args.projectDir.trim() : "";
  if (requestedProjectDir) {
    try {
      setActiveProjectDir(resolveProjectDir({ explicit: requestedProjectDir }).dir);
    } catch (error) {
      return textResponse(`❌ projectDir tidak valid: ${error.message}`);
    }
    workflowState.state.projectDir = getActiveProjectDir();
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
    const unexpected = await unexpectedChanges(git, workflowState.state.dirtyAtStart);
    const details = unexpected.length > 0
      ? `\n\nBerkas yang bukan bagian dari pekerjaan task ini:\n` +
        unexpected.map((entry) => `   • ${entry.code.padEnd(3)} ${entry.path}`).join("\n")
      : "";
    return textResponse(
      "⚠️ Detected new changes after the last commit. Please run 'commit_and_push' again before recording a release." +
        details
    );
  }

  if (!workflowState.state.readyCheckCompleted) {
    return textResponse(
      "⚠️ Please run 'check_ready_to_commit' and ensure all checks pass before releasing!"
    );
  }

  const existingRelease = await detectExistingReleaseOnHead(
    git,
    workflowState.state.lastCommitMessage
  );
  const isAlreadyReleasedMode =
    (existingRelease.alreadyReleased || args.recordOnly === true) &&
    args.forceRun !== true;

  if (!workflowState.state.commitAndPushCompleted) {
    let hasWorkingChanges;
    try {
      hasWorkingChanges = await git.hasWorkingChanges();
    } catch (error) {
      return textResponse(
        `❌ Tidak bisa memeriksa repository Git, jadi status rilis tidak dapat diverifikasi.\n\n` +
        `Penyebab: ${error.message}\n\n` +
        `Sebutkan 'projectDir' pada 'perform_release' untuk menunjuk repo yang benar.`
      );
    }

    if (hasWorkingChanges || !isAlreadyReleasedMode) {
      if (!hasWorkingChanges) {
        workflowState.state.currentPhase = "commit";
        await workflowState.save();
      }
      return textResponse(
        "⚠️ Please run 'commit_and_push' after the ready check before recording a release!"
      );
    }

    // Break deadlock when HEAD is already a release commit/tag and working tree is clean
    workflowState.state.commitAndPushCompleted = true;
    if (existingRelease.lastCommitMessage && !workflowState.state.lastCommitMessage) {
      workflowState.state.lastCommitMessage = existingRelease.lastCommitMessage;
    }
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

  if (!releaseCommand && !isAlreadyReleasedMode) {
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

  // "Bersih" di sini berarti: tidak ada perubahan yang BELUM kita putuskan.
  // Berkas yang sudah kotor sejak `start_task` adalah pekerjaan sesi lain yang
  // sengaja ditinggalkan `commit_and_push` - rilis boleh lanjut, asalkan
  // disebutkan supaya tidak tampak seperti repo yang bersih total.
  const onlyForeign =
    typeof git.hasOnlyForeignChanges === "function" &&
    git.hasOnlyForeignChanges(workflowState.state.dirtyAtStart, statusOutput);

  if (statusSummary.hasChanges && !onlyForeign) {
    const changeDetails =
      statusSummary.lines.length > 0
        ? statusSummary.lines.map((line) => `• ${line}`).join("\n")
        : "• (unable to list changes)";

    return textResponse(
      `⚠️ Working tree not clean! Please commit or stash all changes before running 'perform_release'.\n\nDetected changes:\n${changeDetails}`
    );
  }

  const leftOverNote = onlyForeign && statusSummary.lines.length > 0
    ? `\n\nℹ️ Dibiarkan tidak ter-commit (sudah kotor sebelum task ini, milik sesi lain):\n` +
      statusSummary.lines.map((line) => `   • ${line}`).join("\n")
    : "";

  const explicitVersion =
    typeof args.version === "string" ? args.version.trim().replace(/^v/i, "") : "";
  const explicitNotes =
    typeof args.notes === "string"
      ? args.notes
      : typeof args.releaseNotes === "string"
        ? args.releaseNotes
        : "";

  if (isAlreadyReleasedMode) {
    const branchForPush =
      workflowState.state.lastPushBranch || (await git.getCurrentBranch()) || "";
    const pushCommand = branchForPush
      ? `git push --follow-tags origin ${utils.shellEscape(branchForPush)}`
      : "git push --follow-tags";

    let headSha = "";
    try {
      headSha = await git.getHeadSha();
    } catch {
      headSha = "";
    }

    let alreadyOnRemote = false;
    if (headSha && branchForPush) {
      try {
        const remoteSha = await git.getRemoteBranchSha(branchForPush);
        if (remoteSha === headSha) {
          alreadyOnRemote = true;
        }
      } catch {
        // Ignore remote SHA read error
      }
      if (!alreadyOnRemote && typeof git.isCommitOnRemoteBranch === "function") {
        try {
          alreadyOnRemote = Boolean(
            await git.isCommitOnRemoteBranch(headSha, branchForPush)
          );
        } catch {
          alreadyOnRemote = false;
        }
      }
    }

    if (!alreadyOnRemote) {
      try {
        await exec(pushCommand);
      } catch (error) {
        return textResponse(
          `❌ Push rilis GAGAL. Rilis TIDAK tercatat sebagai selesai.\n\n` +
          `Repo: ${repoLabel()}\nBranch: ${branchForPush || "(tidak diketahui)"}\n` +
          `Penyebab: ${error.stderr || error.stdout || error.message}`
        );
      }
    }

    const resolvedVersion =
      explicitVersion ||
      existingRelease.tagVersion ||
      existingRelease.commitVersion ||
      "";
    const recordedCommand =
      releaseCommand ||
      (existingRelease.matchedTag
        ? `(existing release tag ${existingRelease.matchedTag})`
        : "(existing release commit on HEAD)");

    workflowState.state.released = true;
    if (resolvedVersion) {
      workflowState.state.releaseVersion = resolvedVersion;
    }
    workflowState.state.releaseCommand = recordedCommand;
    workflowState.state.releaseNotes = explicitNotes;
    workflowState.state.currentPhase = "ready_to_complete";
    await workflowState.save();

    const message = summarizeHistory(workflowState.state.history, args.limit || 10);
    const summaryBlock = message ? `\n\n${message}` : "";
    return textResponse(
      `✅ Release recorded (already exists on HEAD${resolvedVersion ? `: v${resolvedVersion}` : ""}; skipped re-running release script).` +
      `${leftOverNote}${summaryBlock}`
    );
  }

  const lastCommitMessage = existingRelease.lastCommitMessage || (await git.getLastCommitMessage());
  if (!releaseType) {
    releaseType = utils.determineReleaseTypeFromCommit(
      lastCommitMessage || workflowState.state.lastCommitMessage
    );
  }

  // Tipe rilis WAJIB sah sebelum perintah disusun.
  //
  // 31 Oktober 2026: `determineReleaseTypeFromCommit` mengembalikan string kosong,
  // lalu perintahnya menjadi `npm run release -- --release-as ` + "null" ->
  // standard-version menulis `"version": null` dan membuat tag `vnull`, lalu
  // keduanya di-push. Yang salah bukan hanya hasilnya: perintah yang mustahil
  // itu tetap dijalankan tanpa perlawanan.
  if (!recognizedTypes.has(releaseType)) {
    return textResponse(
      `⚠️ Tipe rilis tidak bisa ditentukan dari commit terakhir, jadi rilis TIDAK dijalankan.\n\n` +
      `Commit terakhir: ${lastCommitMessage || "(kosong)"}\n\n` +
      `Sebutkan tipe rilisnya secara eksplisit:\n` +
      `  • 'perform_release' dengan releaseType: "patch" | "minor" | "major"\n` +
      `  • atau command: "npm run release:patch"\n\n` +
      `Tanpa itu perintahnya akan menjadi "--release-as null", yang menghasilkan tag vnull ` +
      `dan package.json berversi null.`
    );
  }

  const finalCommand =
    releaseCommand.includes("--release-as") || /release:(major|minor|patch)/i.test(releaseCommand)
      ? releaseCommand
      : `${releaseCommand} -- --release-as ${releaseType}`;

  // Jaring pengaman terakhir: apa pun yang terjadi di atas, jangan pernah
  // menjalankan perintah yang membawa tipe rilis kosong.
  if (/--release-as\s+(?:null|undefined|)\s*$/i.test(finalCommand) || /\snull\b/i.test(finalCommand)) {
    return textResponse(
      `⚠️ Perintah rilis akan berisi tipe rilis yang tidak sah, jadi TIDAK dijalankan:\n\n` +
      `  ${finalCommand}\n\n` +
      `Sebutkan tipe rilisnya: releaseType "patch" | "minor" | "major".`
    );
  }

  // Catat keadaan SEBELUM rilis supaya, kalau push gagal, kita bisa menyebut
  // persis apa yang tertinggal di mesin.
  const headBefore = await safeExecStdout(exec, "git rev-parse HEAD");
  const tagBefore = await safeExecStdout(exec, "git describe --tags --abbrev=0");

  try {
    await exec(finalCommand);
  } catch (error) {
    return textResponse(
      `❌ Release command failed:\n\n${error.stderr || error.stdout || error.message}`
    );
  }

  const headAfter = await safeExecStdout(exec, "git rev-parse HEAD");
  const tagAfter = await safeExecStdout(exec, "git describe --tags --abbrev=0");

  const branchForPush = workflowState.state.lastPushBranch || (await git.getCurrentBranch()) || "";
  const pushCommand = branchForPush
    ? `git push --follow-tags origin ${utils.shellEscape(branchForPush)}`
    : "git push --follow-tags";

  try {
    await exec(pushCommand);
  } catch (error) {
    // Rilis SUDAH membuat commit dan tag di mesin; hanya push yang gagal.
    // Tanpa menyebut yang tertinggal, tidak jelas apa yang harus dibereskan -
    // dan pada 31 Oktober 2026 hal itu membuat rilis tampak selesai.
    const leftBehind = [];
    if (headAfter && headAfter !== headBefore) {
      leftBehind.push(`  • commit rilis ${headAfter.slice(0, 8)}`);
    }
    if (tagAfter && tagAfter !== tagBefore) {
      leftBehind.push(`  • tag ${tagAfter}`);
    }

    return textResponse(
      `❌ Push rilis GAGAL. Rilis TIDAK tercatat sebagai selesai.\n\n` +
      `Repo: ${repoLabel()}\nBranch: ${branchForPush || "(tidak diketahui)"}\n` +
      `Penyebab: ${error.stderr || error.stdout || error.message}\n\n` +
      (leftBehind.length > 0
        ? `Tertinggal di mesin (belum sampai ke remote):\n${leftBehind.join("\n")}\n\n`
        : "") +
      `Pemulihan:\n` +
      `  1. periksa: git log --oneline -3 && git tag --points-at HEAD\n` +
      `  2. kirim ulang: git push --follow-tags origin ${branchForPush || "<branch>"}\n` +
      `  3. atau batalkan rilis lokal: git reset --hard HEAD~1 && git tag -d ${tagAfter || "<tag>"}\n\n` +
      `Jangan tandai task selesai sebelum tag benar-benar ada di remote.`
    );
  }

  const resolvedTagVersion = tagAfter ? String(tagAfter).replace(/^v/i, "") : "";
  workflowState.state.released = true;
  if (explicitVersion || resolvedTagVersion) {
    workflowState.state.releaseVersion = explicitVersion || resolvedTagVersion;
  }
  workflowState.state.releaseCommand = finalCommand;
  workflowState.state.releaseNotes = explicitNotes;
  workflowState.state.currentPhase = "ready_to_complete";
  await workflowState.save();

  const message = summarizeHistory(workflowState.state.history, args.limit || 10);
  if (!message) {
    return textResponse(`📜 No workflow history yet.${leftOverNote}`);
  }

  return textResponse(`${message}${leftOverNote}`);
}
