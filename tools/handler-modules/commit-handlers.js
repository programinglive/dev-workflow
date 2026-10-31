import { textResponse, isReleaseSatisfied, formatChecklist } from "./shared.js";
import { handleReadyCheck } from "./status-handlers.js";
import { openItems, renderChecklist, renderOutstanding, summarize } from "./dod.js";
import { containsTestFilesInStatus } from "../../git-helpers.js";
import { resolveProjectDir, setActiveProjectDir, getActiveProjectDir } from "../../exec.js";
import path from "path";

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
 * Apakah dua path menunjuk direktori yang sama.
 *
 * Windows tidak membedakan huruf besar/kecil dan kadang memberi garis miring
 * di akhir, jadi perbandingan string mentah akan salah.
 */
function samePath(a, b) {
  if (!a || !b) return false;
  const normal = (value) => path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  return normal(a) === normal(b);
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

/**
 * Branch yang benar-benar dipakai untuk push.
 *
 * Urutan: `branch` eksplisit -> branch aktif -> primary branch.
 *
 * Sebelum 31 Okt 2026 urutannya primaryBranch lebih dulu, dan `getPrimaryBranch()`
 * selalu menjawab "main" bila `origin/main` ada - tanpa melihat branch aktif.
 * Akibatnya di worktree yang sedang di `feat/...`, tool menjalankan
 * `git push origin main`. Karena `main` lokal sudah sama dengan `origin/main`,
 * perintah itu keluar 0 tanpa mengirim apa pun, lalu tool melaporkan
 * "Commit and push completed". Dua commit nyata tidak pernah ter-push.
 *
 * HEAD yang detached ("HEAD") bukan branch, jadi tidak bisa dipakai.
 */
function pickPushBranch({ requestedBranch, currentBranch, primaryBranch }) {
  if (requestedBranch) return requestedBranch;
  if (currentBranch && currentBranch !== "HEAD") return currentBranch;
  return primaryBranch || currentBranch || "";
}

/**
 * Pastikan remote benar-benar menerima HEAD.
 *
 * `git push` bisa keluar 0 tanpa memindahkan apa pun - itulah yang menyamarkan
 * bug di atas. Satu-satunya bukti yang bisa dipercaya adalah membandingkan SHA.
 */
async function verifyPushed(git, branch) {
  let head;
  try {
    head = await git.getHeadSha();
  } catch (error) {
    return { ok: false, detail: `tidak bisa membaca HEAD: ${error.message}` };
  }

  let remote;
  try {
    remote = await git.getRemoteBranchSha(branch);
  } catch {
    return {
      ok: false,
      detail: `branch origin/${branch} tidak ditemukan di remote setelah push`,
    };
  }

  if (remote !== head) {
    return {
      ok: false,
      detail:
        `origin/${branch} berada di ${remote.slice(0, 8)}, ` +
        `sedangkan HEAD di ${head.slice(0, 8)}`,
    };
  }

  return { ok: true, head };
}

export async function handleCommitAndPush(args, context) {
  const { workflowState, exec, git, utils } = context;

  const projectDirError = applyProjectDirOverride(args);
  if (projectDirError) {
    return textResponse(projectDirError);
  }

  workflowState.state.projectDir = getActiveProjectDir() || workflowState.state.projectDir || "";

  // Guard DoD yang eksplisit. `handleReadyCheck` di bawah sudah menutupi ini
  // secara transitif, tetapi pesannya generik ("NOT READY"); di sini kita bisa
  // menyebut item mana yang menghalangi, sebelum satu perintah git pun jalan.
  const dodItems = Array.isArray(workflowState.state.definitionOfDone)
    ? workflowState.state.definitionOfDone
    : [];
  const outstanding = openItems(dodItems, workflowState.state.dodRevision);
  if (outstanding.length > 0) {
    return textResponse(
      `⚠️ Dibatalkan: ${outstanding.length} item Definition of Done belum terpenuhi.\n\n` +
        `${renderOutstanding(dodItems, workflowState.state.dodRevision)}\n\n` +
        `Buktikan dengan 'mark_dod_item' { id, evidence }, atau kecualikan dengan ` +
        `'waive_dod_item' { id, reason }.\n\n` +
        `Tidak ada yang di-stage dan tidak ada yang di-commit.`
    );
  }

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
  let gitToplevel = "";
  try {
    primaryBranch = await git.getPrimaryBranch();
    currentBranch = await git.getCurrentBranch();
    hasWorkingChanges = await git.hasWorkingChanges();

    // Tempat git BENAR-BENAR berjalan, menurut git sendiri.
    //
    // 31 Oktober 2026 laporan menyebut `portal-beautyworld` untuk commit yang
    // masuk ke repo lain, karena labelnya dibaca dari variabel global yang bisa
    // berubah - bukan dari repo tempat git berjalan. Laporan seperti itu membuat
    // agen percaya commit-nya ada di tempat yang salah.
    if (typeof git.getToplevel === "function") {
      gitToplevel = String((await git.getToplevel()) || "").trim();
    }
  } catch (error) {
    return textResponse(
      `❌ Tidak bisa memeriksa repository Git, jadi tidak ada yang di-commit.\n\n` +
      `Repo: ${repoLabel()}\n` +
      `Penyebab: ${error.message}\n\n` +
      `Sebutkan 'projectDir' pada 'start_task' atau 'commit_and_push' untuk menunjuk repo yang benar.`
    );
  }

  // Kalau git berjalan di repo lain daripada yang diminta, BERHENTI. Commit ke
  // repo yang salah jauh lebih mahal daripada satu pesan kesalahan.
  const requestedRepo = getActiveProjectDir();
  if (gitToplevel && requestedRepo && !samePath(gitToplevel, requestedRepo)) {
    return textResponse(
      `❌ Dibatalkan: git berjalan di repo yang BERBEDA dari yang diminta.\n\n` +
      `Diminta    : ${requestedRepo}\n` +
      `Dipakai git: ${gitToplevel}\n\n` +
      `Tidak ada yang di-commit. Sebutkan 'projectDir' yang benar pada 'commit_and_push', ` +
      `atau jalankan ulang 'start_task' dengan 'projectDir' repo tersebut.`
    );
  }

  // Label laporan memakai repo yang benar-benar dipakai git bila diketahui.
  const repoName = gitToplevel || repoLabel();

  const branchForPush = pickPushBranch({ requestedBranch, currentBranch, primaryBranch });

  if (!hasWorkingChanges) {
    const lastCommitMessage = await git.getLastCommitMessage();
    const effectiveCommitMessage = lastCommitMessage || providedCommitMessage;

    // "Tidak ada perubahan" bukan berarti "sudah ter-push", dan juga bukan
    // berarti "panggilan ini sudah commit". HEAD bisa saja berupa commit yang
    // belum pernah dikirim, dan bisa juga sudah terkirim oleh panggilan
    // SEBELUMNYA. Memeriksanya mencegah tool menandai selesai padahal remote
    // masih tertinggal - dan kalimat "Assuming commit and push already
    // completed" (dipakai sampai 31 Oktober 2026) membuat agen percaya
    // pekerjaannya sudah masuk padahal tidak ada yang dikerjakan sama sekali.
    const pushed = await verifyPushed(git, branchForPush);
    if (!pushed.ok) {
      return textResponse(
        `⚠️ Tidak ada perubahan untuk di-commit, tetapi HEAD BELUM ada di remote.\n` +
        `Repo: ${repoName}\nBranch: ${branchForPush || "(tidak diketahui)"}\n` +
        `Sebab: ${pushed.detail}\n\n` +
        `Jalankan 'commit_and_push' lagi dengan 'branch' yang benar, atau push manual.`
      );
    }

    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.lastCommitMessage = effectiveCommitMessage || "";
    workflowState.state.lastPushBranch = branchForPush;
    workflowState.state.currentPhase = isReleaseSatisfied(workflowState.state) ? "ready_to_complete" : "release";
    await workflowState.save();

    const noActiveTask = workflowState.state.currentPhase === "idle" || !workflowState.state.taskDescription;

    return textResponse(
      `ℹ️ No changes detected. No commit was made by this call.\n` +
      `Repo: ${repoName}\nBranch: ${branchForPush} (verified on remote, HEAD ${pushed.head.slice(0, 8)})\n` +
      `Commit terakhir: ${effectiveCommitMessage || "(tidak terbaca)"}\n\n` +
      (noActiveTask
        ? `Tidak ada task aktif di state workflow (currentPhase "idle"), jadi memang tidak ada ` +
          `yang diharapkan dari panggilan ini.\n\n`
        : "") +
      `Yang terbukti: commit terakhir sudah ada di remote. Yang TIDAK terbukti: commit itu berisi ` +
      `pekerjaan task ini. Kalau perubahan seharusnya ada, berarti belum ditulis, sudah di-commit ` +
      `oleh panggilan sebelumnya, atau berada di repo/branch lain.\n\n` +
      `Next: Run 'perform_release' to handle the release and push tags.`
    );
  }

  const statusOutput = await git.getStatusOutput();

  if (!workflowState.state.testsSkipped && !containsTestFilesInStatus(statusOutput)) {
    return textResponse("⚠️ Please include test updates in your changes before running 'commit_and_push'. Ensure at least one test file is modified.");
  }

  /*
   * `git add .` men-staging SELURUH working tree, termasuk pekerjaan sesi lain
   * yang kebetulan ada di repo yang sama - lalu commit ini mengakuinya sebagai
   * miliknya. Itu bukan teori: pada 31 Okt 2026 dua baris `billing.yaml` milik
   * sesi lain ikut masuk commit sesi ini, dan sebuah `devices.yaml` yang
   * ditulis ulang di tengah task nyaris tertimpa.
   *
   * Baseline dicatat `start_task`. Yang bisa dipastikan bukan milik kita adalah
   * berkas yang SUDAH kotor sejak baseline. Berkas baru selama task tidak
   * dituduh - tidak ada cara membedakannya, dan tuduhan palsu akan membuat
   * pemeriksaan ini diabaikan.
   */
  const foreignDirty = typeof git.foreignDirtyEntries === "function"
    ? git.foreignDirtyEntries(workflowState.state.dirtyAtStart, statusOutput)
    : [];
  const explicitPaths = Array.isArray(args.paths)
    ? args.paths.map((entry) => String(entry).trim()).filter(Boolean)
    : [];

  if (foreignDirty.length > 0 && explicitPaths.length === 0 && args.includeForeign !== true) {
    const list = foreignDirty.map((entry) => `   ${entry.code.padEnd(3)} ${entry.path}`).join("\n");
    return textResponse(
      `❌ Refusing to stage the whole tree: ${foreignDirty.length} file(s) were already dirty ` +
        `before this task started, so they are almost certainly another session's work.\n\n` +
        `${list}\n\n` +
        `Choose one:\n` +
        `   • pass 'paths' with only the files this task changed (recommended),\n` +
        `   • or pass 'includeForeign: true' if you have verified that work belongs in this commit.\n\n` +
        `Nothing was staged and nothing was committed.`
    );
  }

  try {
    if (explicitPaths.length > 0) {
      await exec("git add", { executable: "git", arguments: ["add", "--", ...explicitPaths] });
    } else {
      await exec("git add .");
    }
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

  // Exit code 0 dari `git push` BUKAN bukti bahwa commit ini terkirim. Kalau
  // branch yang dipilih sudah sinkron, git tidak melakukan apa pun dan tetap
  // keluar 0. Satu-satunya bukti yang bisa dipercaya: SHA HEAD ada di remote.
  const pushed = await verifyPushed(git, branchForPush);
  if (!pushed.ok) {
    return textResponse(
      `❌ Commit dibuat, tetapi TIDAK ter-push.\n` +
      `Repo: ${repoName}\nBranch: ${branchForPush || "(tidak diketahui)"}\n` +
      `Sebab: ${pushed.detail}\n\n` +
      `Commit lokal: ${generatedSummary}\n\n` +
      `Jalankan 'commit_and_push' lagi dengan 'branch' yang benar, atau push manual.`
    );
  }

  workflowState.state.commitAndPushCompleted = true;
  workflowState.state.lastCommitMessage = generatedSummary;
  workflowState.state.lastPushBranch = branchForPush;
  workflowState.state.currentPhase = isReleaseSatisfied(workflowState.state) ? "ready_to_complete" : "release";
  await workflowState.save();

  // Berkas yang ditinggalkan sengaja tetap disebut: kalau tidak, orang
  // mengira seluruh pekerjaan sudah ter-commit padahal ada yang tertinggal.
  const foreignNote = foreignDirty.length > 0
    ? `\n\nℹ️ Left unstaged (already dirty before this task, not committed):\n` +
      foreignDirty.map((entry) => `   ${entry.code.padEnd(3)} ${entry.path}`).join("\n")
    : "";

  return textResponse(
    `✅ Commit and push completed!\nRepo: ${repoName}\n\nCommit message: ${generatedSummary}\nPushed to: ${branchForPush} (verified at ${pushed.head.slice(0, 8)})${foreignNote}\n\nNext: Run 'perform_release' to handle the release and push tags.`
  );
}

export async function handleCompleteTask(args, workflowState) {
  // Sampai 31 Oktober 2026 fungsi ini tidak memeriksa apa pun: task bisa
  // ditutup dengan DoD kosong atau masih penuh item terbuka. Sekarang tidak.
  const dodState = workflowState.state;
  const dodItems = Array.isArray(dodState.definitionOfDone) ? dodState.definitionOfDone : [];
  const dod = summarize(dodItems, dodState.dodRevision);

  if (dodItems.length === 0) {
    return textResponse(
      `⚠️ Task ini belum punya Definition of Done, jadi belum bisa ditutup.\n\n` +
        `Isi dulu dengan 'set_definition_of_done' { items: [...] }, buktikan tiap item, lalu ulangi 'complete_task'.\n` +
        `Kalau memang harus ditutup sekarang, pakai 'force_complete_task' dengan alasan - langkah itu tercatat.`
    );
  }

  if (dod.open > 0) {
    const outstanding = openItems(dodItems, dodState.dodRevision);
    return textResponse(
      `⚠️ ${dod.open} item Definition of Done masih terbuka:\n\n` +
        `${renderOutstanding(dodItems, dodState.dodRevision)}\n\n` +
        `Buktikan dengan 'mark_dod_item' { id, evidence } atau kecualikan dengan ` +
        `'waive_dod_item' { id, reason }.`
    );
  }

  const entry = {
    taskDescription: workflowState.state.taskDescription,
    taskType: workflowState.state.taskType,
    commitMessage: args.commitMessage,
    definitionOfDoneSummary: dod,
  };

  workflowState.addToHistory(entry);
  workflowState.reset();
  await workflowState.save();

  return textResponse(
    `✅ Task completed!\n\nCommit message: ${args.commitMessage}\n` +
      `DoD: ${dod.done}/${dod.total} terbukti, ${dod.waived} dikecualikan.\nHistory recorded.`
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
    definitionOfDoneSummary: summarize(
      Array.isArray(workflowState.state.definitionOfDone) ? workflowState.state.definitionOfDone : [],
      workflowState.state.dodRevision,
    ),
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
    definitionOfDoneSummary: summarize(
      Array.isArray(workflowState.state.definitionOfDone) ? workflowState.state.definitionOfDone : [],
      workflowState.state.dodRevision,
    ),
  });
  workflowState.reset();
  await workflowState.save();

  return textResponse("⚠️ Task dropped. Workflow state reset.");
}
