import { textResponse, isReleaseSatisfied, formatChecklist } from "./shared.js";
import { handleReadyCheck } from "./status-handlers.js";
import { openItems, renderChecklist, renderOutstanding, summarize } from "./dod.js";
import { containsTestFilesInStatus } from "../../git-helpers.js";
import { reportEventSafe } from "../../monitor.js";
import { validateAiSuggestions, collectSignals, buildRecommendations, renderRecommendations } from "./next-steps.js";
import { resolveProjectDir, setActiveProjectDir, getActiveProjectDir } from "../../exec.js";
import { captureRepositoryIdentity, assertTaskRepository } from "../../repository-identity.js";
import path from "path";
import fs from "fs";
import { cleanupWorkBranches } from "../../branch-cleanup.js";
import { assertPreflightScope } from "../../preflight.js";
import { evaluateGovernanceGate, loadPolicies } from "../../governance/engine.js";
import { collectGitContext } from "../../governance/ci-validator.js";
import { validateForceOverrideAuthorization } from "../../governance/exceptions.js";
import { releaseWorktreeMutex, getHeldWorktreeCapability } from "../../process-lock.js";

/**
 * Check whether test updates exist in the working tree or in recent commits on HEAD
 * so `commit_and_push` does not falsely block when tests were already committed.
 */
export async function hasTestEvidenceForCommit({
  testsSkipped = false,
  statusOutput = "",
  execFn = null,
} = {}) {
  if (testsSkipped) return true;
  if (containsTestFilesInStatus(statusOutput)) return true;
  if (typeof execFn !== "function") return false;

  try {
    const { stdout } = await execFn("git log -n 3 --name-only --pretty=format:");
    const syntheticStatus = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((file) => `M  ${file}`)
      .join("\n");
    return containsTestFilesInStatus(syntheticStatus);
  } catch {
    return false;
  }
}

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
 * Repository identity preflight for a task-bound mutation.
 *
 * `commit_and_push` accepts a `projectDir` override and runs git in it. Without
 * this check a task started in repository A could commit into repository B by
 * passing B's directory - the same class of defect as the 13 November 2026
 * incident, one step later in the workflow.
 *
 * A task started before identity contracts existed is NOT allowed through. Its
 * identity is backfilled only from evidence the task itself recorded and only
 * when that evidence matches the live checkout; otherwise the mutation is
 * refused. A missing identity is not permission to write.
 */
export async function assertMutationRepository({ workflowState, dir, operation, taskProjectDir }) {
  const state = workflowState?.state || {};
  const hasContract = state.identityContract !== undefined && state.identityContract !== null;

  // The binding must come from the TASK, not from the caller's `projectDir`
  // argument. `applyProjectDirOverride` writes the argument into
  // `state.projectDir` before this runs, so using that value would let a caller
  // manufacture a binding by naming any valid checkout. `taskProjectDir` is the
  // value captured before the override.
  const declaredProjectDir =
    typeof taskProjectDir === "string"
      ? taskProjectDir.trim()
      : typeof state.projectDir === "string"
        ? state.projectDir.trim()
        : "";

  // No contract and no task-declared workspace means there is no trustworthy
  // task-to-workspace binding. A valid checkout resolved by the handler is not
  // evidence of which repository the task owns, so the mutation fails closed.
  if (!hasContract && !declaredProjectDir) {
    return {
      ok: false,
      code: "IDENTITY_UNVERIFIABLE_NO_TASK_BINDING",
      message:
        `⚠️ Refused: ${operation} has no trustworthy task-to-workspace binding.\n\n` +
        `This task has no identity contract and never declared a 'projectDir'. ` +
        `A repository resolved from the caller or the working directory is not proof ` +
        `that this task owns it.\n\n` +
        `Start the task again with a 'projectDir' that points at the intended repository ` +
        `so an identity contract is recorded.\n\n` +
        `Nothing was changed.`,
    };
  }

  if (!dir) {
    return {
      ok: false,
      code: "NO_WORKSPACE",
      message:
        `⚠️ Refused: ${operation} has no repository to run in.\n\n` +
        `Start the task with a 'projectDir' that points at a Git repository.\n` +
        `Nothing was changed.`,
    };
  }

  const actual = await captureRepositoryIdentity({ dir });
  const result = assertTaskRepository({
    contract: state.identityContract,
    state: { ...state, projectDir: declaredProjectDir },
    actual,
    operation,
  });

  if (result.ok && result.backfilledContract) {
    workflowState.state.identityContract = result.backfilledContract;
    try {
      await workflowState.save();
    } catch {
      // The backfill is already proven in memory; a failed save must not turn a
      // verified mutation into a refusal. The next save retries it.
    }
  }

  return result;
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

  let remote = "";
  let remoteLookupError = false;
  try {
    remote = await git.getRemoteBranchSha(branch);
  } catch {
    remoteLookupError = true;
  }

  if (!remoteLookupError && remote === head) {
    return { ok: true, head };
  }

  // If local tracking ref differs or is stale, check whether HEAD is already
  // an ancestor of origin/<branch> or present on remote via ls-remote.
  if (typeof git.isCommitOnRemoteBranch === "function") {
    try {
      const onRemote = await git.isCommitOnRemoteBranch(head, branch);
      if (onRemote) {
        return { ok: true, head };
      }
    } catch {
      // Ignore ancestry/ls-remote check error and fall back to standard failure detail
    }
  }

  if (remoteLookupError) {
    return {
      ok: false,
      detail: `branch origin/${branch} tidak ditemukan di remote setelah push`,
    };
  }

  return {
    ok: false,
    detail:
      `origin/${branch} berada di ${remote.slice(0, 8)}, ` +
      `sedangkan HEAD di ${head.slice(0, 8)}`,
  };
}

export async function handleCommitAndPush(args, context) {
  const { workflowState, exec, git, utils } = context;

  // Capture the task's own binding BEFORE the caller's `projectDir` override can
  // overwrite it. The override may point at a valid checkout, but that is not
  // proof the task owns it.
  const taskProjectDir = typeof workflowState.state.projectDir === "string" ? workflowState.state.projectDir.trim() : "";

  const projectDirError = applyProjectDirOverride(args);
  if (projectDirError) {
    return textResponse(projectDirError);
  }

  // The task's own projectDir wins over the process-global active directory.
  // The global is only a fallback for a state that never declared one, and the
  // identity guard refuses that case anyway.
  if (!workflowState.state.projectDir) {
    workflowState.state.projectDir = getActiveProjectDir() || "";
  }

  // Repository identity preflight: a task is bound to the checkout it started
  // in. A `projectDir` override that points at another checkout must not commit
  // there, even when the remote matches.
  {
    const hasExplicitProjectDir = typeof args.projectDir === "string" && args.projectDir.trim() !== "";
    const repoGuard = await assertMutationRepository({
      workflowState,
      dir: hasExplicitProjectDir
        ? getActiveProjectDir() || args.projectDir.trim()
        : workflowState.state.projectDir || getActiveProjectDir() || "",
      operation: "commit_and_push",
      taskProjectDir,
    });
    if (!repoGuard.ok) {
      return textResponse(repoGuard.message);
    }
  }

  // README-first scope guard: the task's preflight record names the project
  // root it was started in. A governed commit must not target a different root.
  // An idle state has no task to scope, so it falls through to the existing
  // "no active task" message instead of a misleading preflight error.
  if (workflowState.state.currentPhase !== "idle" && workflowState.state.taskDescription) {
    const scope = assertPreflightScope(workflowState.state.preflight, {
      projectDir: workflowState.state.projectDir,
      operation: "commit_and_push",
    });
    if (!scope.ok) {
      return textResponse(
        `⚠️ Dibatalkan: ${scope.code}. ${scope.reason}\n\n` +
          `The task's preflight record does not authorize this operation. ` +
          `Re-run 'start_task' in the correct project, or resume the task that owns this checkout.`
      );
    }
  }

  // Instruction acknowledgment: when a preflight exists, the agent must have
  // acknowledged the README fingerprint and task scope. This is an observable
  // operation constraint, not proof of comprehension.
  if (workflowState.state.preflight?.ok === true) {
    const ack = workflowState.state.instructionAcknowledgment;
    const expectedFingerprint =
      workflowState.state.preflight.preflightFingerprint ||
      workflowState.state.preflight.readme?.fingerprint ||
      "";
    const expectedScope = workflowState.state.preflight.projectRoot || "";
    if (!ack || ack.fingerprint !== expectedFingerprint || ack.scope !== expectedScope) {
      return textResponse(
        `⚠️ Dibatalkan: INSTRUCTION_ACK_REQUIRED. Call 'acknowledge_instructions' with the README fingerprint and the task scope before committing.`
      );
    }
  }

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
    const readyResponse = await handleReadyCheck(workflowState, { git });
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

  const runFenced = (op, fn) =>
    typeof workflowState._withOwnershipFence === "function"
      ? workflowState._withOwnershipFence(op, fn)
      : fn();

  const branchForPush = pickPushBranch({ requestedBranch, currentBranch, primaryBranch });

  if (!hasWorkingChanges) {
    return await runFenced("commit_and_push_no_changes", async () => {
    const lastCommitMessage = await git.getLastCommitMessage();
    const effectiveCommitMessage = lastCommitMessage || providedCommitMessage;

    // "Tidak ada perubahan" bukan berarti "sudah ter-push", dan juga bukan
    // berarti "panggilan ini sudah commit". HEAD bisa saja berupa commit yang
    // belum pernah dikirim, dan bisa juga sudah terkirim oleh panggilan
    // SEBELUMNYA. Memeriksanya mencegah tool menandai selesai padahal remote
    // masih tertinggal - dan kalimat "Assuming commit and push already
    // completed" (dipakai sampai 31 Oktober 2026) membuat agen percaya
    // pekerjaannya sudah masuk padahal tidak ada yang dikerjakan sama sekali.
    let pushed = await verifyPushed(git, branchForPush);
    if (!pushed.ok && branchForPush && typeof exec === "function") {
      try {
        const pushTarget =
          typeof utils?.shellEscape === "function"
            ? utils.shellEscape(branchForPush)
            : branchForPush;
        await exec(`git push origin ${pushTarget}`);
        pushed = await verifyPushed(git, branchForPush);
      } catch {
        // Ignore push failure here; !pushed.ok will report the exact reason below
      }
    }
    if (!pushed.ok) {
      return textResponse(
        `⚠️ Tidak ada perubahan untuk di-commit, tetapi HEAD BELUM ada di remote.\n` +
        `Repo: ${repoName}\nBranch: ${branchForPush || "(tidak diketahui)"}\n` +
        `Sebab: ${pushed.detail}\n\n` +
        `Jalankan 'commit_and_push' lagi dengan 'branch' yang benar, atau push manual.`
      );
    }

    workflowState.state.commitAndPushCompleted = true;
    // Pesan commit lama tidak boleh terhapus oleh bacaan kosong: tanpa ini,
    // kegagalan `git log` membuat riwayat kehilangan pesan commit sesungguhnya.
    workflowState.state.lastCommitMessage = effectiveCommitMessage || workflowState.state.lastCommitMessage || "";
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
    });
  }

  const statusOutput = await git.getStatusOutput();

  const hasTests = await hasTestEvidenceForCommit({
    testsSkipped: Boolean(workflowState.state.testsSkipped),
    statusOutput,
    execFn: exec,
  });
  if (!hasTests) {
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

  return await runFenced("commit_and_push", async () => {
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
  // SHA yang BENAR-BENAR ter-push. Tanpa ini rekomendasi tindak lanjut selalu
  // membaca HEAD - yang setelah perform_release adalah commit versi, bukan
  // commit task, sehingga sinyal TODO dan ukuran diff menunjuk hal yang salah.
  workflowState.state.lastCommitSha = pushed.head;
  workflowState.state.currentPhase = isReleaseSatisfied(workflowState.state) ? "ready_to_complete" : "release";
  await workflowState.save();

  await reportEventSafe(workflowState.state, "committed", generatedSummary);

  // Berkas yang ditinggalkan sengaja tetap disebut: kalau tidak, orang
  // mengira seluruh pekerjaan sudah ter-commit padahal ada yang tertinggal.
  //
  // Tetapi berkas yang MEMANG ikut di-commit lewat `paths` tidak boleh muncul
  // di sini. Baseline mencatat keadaan sebelum task, jadi berkas yang sudah
  // kita edit sendiri sebelum `start_task` juga ada di sana - dan versi pertama
  // catatan ini menyebutnya "not committed" padahal baru saja di-commit.
  const stagedNow = new Set(
    explicitPaths.map((p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "")),
  );
  const leftBehind = args.includeForeign === true
    ? []
    : foreignDirty.filter((entry) =>
        !stagedNow.has(String(entry.path).replace(/\\/g, "/").replace(/^\.\//, "")));

  const foreignNote = leftBehind.length > 0
    ? `\n\nℹ️ Left unstaged (already dirty before this task, not committed):\n` +
      leftBehind.map((entry) => `   ${entry.code.padEnd(3)} ${entry.path}`).join("\n")
    : "";

  // Waiver dokumentasi HARUS terlihat di sini. Janji "pola me-waive jadi
  // terlihat, bukan tersembunyi" bergantung pada laporan commit yang menyebutnya;
  // riwayat dan rekomendasi dibaca belakangan, saat keputusannya sudah jauh.
  const waiverNote = workflowState.state.documentationWaived
    ? `\n\nℹ️ Dokumentasi dikecualikan: ${workflowState.state.documentationWaiverReason || "(tanpa alasan)"}`
    : "";

  return textResponse(
    `✅ Commit and push completed!\nRepo: ${repoName}\n\nCommit message: ${generatedSummary}\nPushed to: ${branchForPush} (verified at ${pushed.head.slice(0, 8)})${foreignNote}${waiverNote}\n\nNext: Run 'perform_release' to handle the release and push tags.`
  );
  });
}

/**
 * Does this project ship through the Clinic CI/CD release runner?
 *
 * The marker is `scripts/ops/clinic-gitlab-release.cjs`, the job that deploys
 * staging, quality and production from a protected tag. A generic `release`
 * script is not enough: the MCP's own repository has one, and gating on that
 * would block unrelated projects.
 */
function isDeployableProject(projectDir) {
  if (!projectDir) return false;

  try {
    return fs.existsSync(path.join(projectDir, "scripts", "ops", "clinic-gitlab-release.cjs"));
  } catch {
    return false;
  }
}

export async function handleCompleteTask(args, workflowState, context = {}) {
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

  // Deployment gate: a project that ships through a release script must record
  // the tag that actually reached production. Direct uploads bypass CI/CD and
  // leave the MCP with no idea what is live, which is exactly how untagged files
  // ended up on production. `skip_release` with a written reason is the only
  // escape hatch, and it is recorded.
  const deploymentGateProjectDir = workflowState.state.projectDir || getActiveProjectDir() || "";
  if (isDeployableProject(deploymentGateProjectDir) && !workflowState.state.releaseSkipped) {
    const deployment = workflowState.state.deployment;
    if (!deployment || !deployment.tag) {
      return textResponse(
        `⚠️ Proyek ini dirilis lewat CI/CD, tapi belum ada deployment yang dicatat.\n\n` +
          `Upload berkas langsung ke server TIDAK dihitung sebagai rilis, dan MCP tidak punya ` +
          `catatan apa pun tentangnya.\n\n` +
          `Langkah yang benar:\n` +
          `  1. rilis lewat tag: 'perform_release' (release script + push tag)\n` +
          `  2. tunggu pipeline CI/CD sampai selesai\n` +
          `  3. catat tag yang benar-benar live: 'record_deployment' { tag, pipelineId, sites, evidence }\n\n` +
          `Task BELUM ditutup.\n` +
          `Kalau task ini memang tidak perlu rilis, pakai 'skip_release' dengan alasan tertulis.`
      );
    }
  }

  // Central governance gate: enforce CLI-First and Documentation-as-Code policies.
  if (dodState.governance && !context?.skipGovernanceGate) {
    const govInput = context?.governanceInput || (deploymentGateProjectDir ? collectGitContext(deploymentGateProjectDir) : {});
    const govCheck = evaluateGovernanceGate({
      state: dodState,
      changedPaths: govInput.changedPaths || [],
      docContents: govInput.docContents || {},
      currentRepo: govInput.repository || dodState.governance.repository || "",
      currentRevision: govInput.revision !== undefined ? govInput.revision : Number(dodState.dodRevision) || 0,
      ciStatus: context?.ciStatus || govInput.ciStatus || null,
    });
    if (!govCheck.ok) {
      const lines = govCheck.violations.map((v) => `  • [${v.code}] (${v.policyId}): ${v.reason}`).join("\n");
      return textResponse(
        `⚠️ Governance policy gate refused task completion:\n\n${lines}\n\n` +
          `Task NOT closed; provide verified CLI-First and Documentation-as-Code evidence or an approved policy exception.`
      );
    }
  }

  // Validasi SEBELUM menyentuh state: saran yang ditolak tidak boleh menutup
  // task setengah jalan, dan saran yang hilang tanpa pesan membuat agen
  // mengira sarannya tersimpan.
  const suggestionsCheck = validateAiSuggestions(args.nextSteps);
  if (!suggestionsCheck.ok) {
    return textResponse(
      `⚠️ ${suggestionsCheck.error}\n\n` +
        `Task BELUM ditutup; workflow tidak berubah.\n` +
        `Contoh: nextSteps: ["perbaiki refreshToken", "tambah tes retry"]`
    );
  }

  const aiSuggestions = suggestionsCheck.items;

  // Sinyal diff butuh git. Tanpa itu, rekomendasi tetap dibuat dari state, dan
  // output menyebut terus terang bahwa sinyal diff tidak terbaca.
  let commitInspection = null;
  let diffNote = "";
  const git = context?.git;
  if (git && typeof git.inspectCommitDiff === "function") {
    try {
      commitInspection = await git.inspectCommitDiff(dodState.lastCommitSha || "");
    } catch (error) {
      diffNote = `\n\nℹ️ Diff commit tidak bisa dibaca (${error.message}); sinyal TODO dan ukuran diff dilewati.`;
    }
  } else {
    diffNote = `\n\nℹ️ Git tidak tersedia di sini; sinyal TODO dan ukuran diff dilewati.`;
  }

  let statusOutput = "";
  if (git && typeof git.getStatusOutput === "function") {
    try {
      statusOutput = await git.getStatusOutput();
    } catch {
      statusOutput = "";
    }
  }

  const signals = collectSignals({
    state: dodState,
    commitInspection,
    statusOutput,
    dirtyAtStart: Array.isArray(dodState.dirtyAtStart) ? dodState.dirtyAtStart : [],
  });

  const recommendations = buildRecommendations({ signals, aiSuggestions });

  const entry = {
    taskDescription: workflowState.state.taskDescription,
    taskType: workflowState.state.taskType,
    commitMessage: args.commitMessage,
    definitionOfDoneSummary: dod,
    documentation: {
      type: workflowState.state.documentationType || "",
      files: Array.isArray(workflowState.state.documentationFiles)
        ? workflowState.state.documentationFiles.slice()
        : [],
      waived: Boolean(workflowState.state.documentationWaived),
      waiverReason: workflowState.state.documentationWaiverReason || "",
    },
    recommendations,
    aiSuggestions,
  };

  workflowState.addToHistory(entry);
  await reportEventSafe(
    { taskDescription: "", projectDir: workflowState.state.projectDir || "" },
    "task_done",
    entry.commitMessage || "",
  );
  // Captured before reset, because reset clears it and the cleanup needs it.
  const projectDir = workflowState.state.projectDir || "";
  const zettlyResult = await closeZettlyTask(workflowState,'completed',args,context.zettlyOptions);
  const zettlyNote = zettlyResult.note ? `\n\n${zettlyResult.ok?'✅':'⚠️'} ${zettlyResult.note}` : '';

  // Durably save the completed task and history before unbinding capability
  await workflowState.save();

  // Release the worktree kernel mutex so other sessions and tests can work on the tree
  const activeCap =
    workflowState.boundKernelCapability ||
    (projectDir ? getHeldWorktreeCapability(projectDir) : null);
  if (activeCap) {
    try {
      await releaseWorktreeMutex(activeCap);
    } catch {}
    if (typeof workflowState.bindKernelCapability === "function") {
      workflowState.bindKernelCapability(null);
    }
  }

  workflowState.reset();
  await workflowState.save({ allowOrphanedReset: true });

  const askForSuggestions = aiSuggestions.length === 0
    ? `\n\n💡 Kirim 'nextSteps' saat 'complete_task' kalau ada yang Anda lihat selama ` +
      `mengerjakan — itu yang dibaca sesi berikutnya lewat 'next_steps'.`
    : "";

  // Finished work should not leave litter behind. Only branches whose commits
  // are all reachable from the default branch are removed, plus worktrees that
  // are clean, merged, unlocked and idle; everything else is kept. This never
  // fails the completion that already happened - a locked directory is not a
  // reason to lose a finished task.
  let cleanupNote = "";
  if (projectDir) {
    try {
      const cleanup = cleanupWorkBranches({ repoDir: projectDir, apply: true });
      const removedBranches = cleanup.deleted || [];
      const removedWorktrees = cleanup.removed || [];
      if (removedBranches.length || removedWorktrees.length) {
        const parts = [];
        if (removedBranches.length) {
          parts.push(`${removedBranches.length} branch: ${removedBranches.join(", ")}`);
        }
        if (removedWorktrees.length) {
          const names = removedWorktrees.map((item) => item.split("/").filter(Boolean).pop());
          parts.push(`${removedWorktrees.length} worktree: ${names.join(", ")}`);
        }
        cleanupNote = `\n\n🧹 Cleaned up (${parts.join(" · ")}).`;
      }
      const failures = cleanup.failures || [];
      if (failures.length) {
        cleanupNote += `\n⚠️ Could not clean: ${failures.map((item) => item.target).join(", ")}.`;
      }
    } catch (error) {
      cleanupNote = `\n\n⚠️ Branch cleanup skipped: ${String(error.message || error).slice(0, 120)}`;
    }
  }

  return textResponse(
    `✅ Task completed!\n\nCommit message: ${args.commitMessage}\n` +
      `DoD: ${dod.done}/${dod.total} terbukti, ${dod.waived} dikecualikan.\nHistory recorded.` +
      `${zettlyNote}\n\n` +
      `${renderRecommendations(recommendations)}${diffNote}${askForSuggestions}${cleanupNote}`
  );
}

export async function handleForceCompleteTask(args, workflowState, context = {}) {
  const commitMessageArg =
    typeof args.commitMessage === "string" ? args.commitMessage.trim() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";

  const commitMessage =
    commitMessageArg || workflowState.state.lastCommitMessage || "(no commit recorded)";

  let governanceBypassed = false;
  let governanceViolations = [];
  let governanceWarnings = [];
  let approvedBy = "";
  let approvalTicket = "";
  if (workflowState.state.governance && !context?.skipGovernanceGate) {
    const projectDir = workflowState.state.projectDir || getActiveProjectDir() || "";
    const govInput = context?.governanceInput || (projectDir ? collectGitContext(projectDir) : {});
    const govCheck = evaluateGovernanceGate({
      state: workflowState.state,
      changedPaths: govInput.changedPaths || [],
      docContents: govInput.docContents || {},
      currentRepo: govInput.repository || workflowState.state.governance.repository || "",
      currentRevision: govInput.revision !== undefined ? govInput.revision : Number(workflowState.state.dodRevision) || 0,
      ciStatus: context?.ciStatus || govInput.ciStatus || null,
    });
    if (Array.isArray(govCheck.violations) && govCheck.violations.length > 0) {
      governanceViolations = govCheck.violations.map((v) => ({ policyId: v.policyId, code: v.code, reason: v.reason }));
    }
    if (Array.isArray(govCheck.warnings) && govCheck.warnings.length > 0) {
      governanceWarnings = govCheck.warnings;
    }
    if (!govCheck.ok) {
      const policies = loadPolicies();
      const nonOverridable = new Set(
        policies.rollout?.nonOverridableViolations || ["DOCUMENTATION_SECURITY_VIOLATION", "REQUIRED_CI_FAILED"]
      );
      const blockedViolations = govCheck.violations.filter((v) => nonOverridable.has(v.code));
      if (blockedViolations.length > 0) {
        const codes = blockedViolations.map((v) => v.code).join(", ");
        return textResponse(
          `⚠️ POLICY_SECURITY_BLOCKED: force_complete_task cannot bypass non-overridable violations (${codes}).`
        );
      }
      if (reason.length < 15) {
        const codes = govCheck.violations.map((v) => v.code).join(", ");
        return textResponse(
          `⚠️ POLICY_FORCE_REASON_REQUIRED: Governance violations (${codes}) require an explicit force reason (>= 15 characters). Task NOT closed.`
        );
      }
      const auth = validateForceOverrideAuthorization({
        approvedBy: args.approvedBy,
        approvalTicket: args.approvalTicket,
        overrideToken: args.overrideToken,
        actor: context?.actor || process.env.DEVWF_AGENT || "agent",
      });
      if (!auth.ok) {
        return textResponse(`⚠️ ${auth.code}: ${auth.reason} Task NOT closed.`);
      }
      governanceBypassed = true;
      approvedBy = auth.approvedBy;
      approvalTicket = auth.approvalTicket;
    }
  }

  workflowState.addToHistory({
    taskDescription: workflowState.state.taskDescription,
    taskType: workflowState.state.taskType,
    commitMessage,
    forced: true,
    forceReason: reason,
    governanceBypassed,
    approvedBy,
    approvalTicket,
    governanceViolations,
    governanceWarnings,
    definitionOfDoneSummary: summarize(
      Array.isArray(workflowState.state.definitionOfDone) ? workflowState.state.definitionOfDone : [],
      workflowState.state.dodRevision,
    ),
  });

  let zettlyResult = { ok: true, note: "" };
  try {
    zettlyResult = await closeZettlyTask(workflowState, "closed_with_exceptions", args, context.zettlyOptions);
  } catch (error) {
    zettlyResult = { ok: false, note: `Zettly sync skipped during orphaned force-complete: ${error?.message || error}` };
  }
  const zettlyNote = zettlyResult.note ? `\n${zettlyResult.ok?'✅':'⚠️'} ${zettlyResult.note}` : '';

  const projectDir = workflowState.state.projectDir || "";
  const activeCap =
    workflowState.boundKernelCapability ||
    (projectDir ? getHeldWorktreeCapability(projectDir) : null);

  try {
    await workflowState.save({ allowOrphanedReset: true });
  } catch {}

  if (activeCap) {
    try {
      await releaseWorktreeMutex(activeCap);
    } catch {}
    if (typeof workflowState.bindKernelCapability === "function") {
      workflowState.bindKernelCapability(null);
    }
  }

  workflowState.reset();
  await workflowState.save({ allowOrphanedReset: true });

  const reasonText = reason ? reason : "(none provided)";

  return textResponse(
    `⚠️ Task force-completed.\n\nRecorded commit message: ${commitMessage}\nReason: ${reasonText}\nWorkflow state reset. Start a new task when ready.${zettlyNote}`
  );
}

export async function handleDropTask(args, workflowState, context = {}) {
  const dropReason = typeof args.reason === "string" ? args.reason : "";

  workflowState.addToHistory({
    taskDescription: workflowState.state.taskDescription,
    taskType: workflowState.state.taskType,
    commitMessage: workflowState.state.lastCommitMessage,
    dropped: true,
    dropReason,
    definitionOfDoneSummary: summarize(
      Array.isArray(workflowState.state.definitionOfDone) ? workflowState.state.definitionOfDone : [],
      workflowState.state.dodRevision,
    ),
  });

  let zettlyResult = { ok: true, note: "" };
  try {
    zettlyResult = await closeZettlyTask(workflowState, "cancelled", args, context.zettlyOptions);
  } catch (error) {
    zettlyResult = { ok: false, note: `Zettly sync skipped during orphaned drop: ${error?.message || error}` };
  }
  const zettlyNote = zettlyResult.note ? `\n${zettlyResult.ok?'✅':'⚠️'} ${zettlyResult.note}` : '';

  const projectDir = workflowState.state.projectDir || "";
  const activeCap =
    workflowState.boundKernelCapability ||
    (projectDir ? getHeldWorktreeCapability(projectDir) : null);

  try {
    await workflowState.save({ allowOrphanedReset: true });
  } catch {}

  if (activeCap) {
    try {
      await releaseWorktreeMutex(activeCap);
    } catch {}
    if (typeof workflowState.bindKernelCapability === "function") {
      workflowState.bindKernelCapability(null);
    }
  }

  workflowState.reset();
  await workflowState.save({ allowOrphanedReset: true });

  return textResponse(`⚠️ Task dropped. Workflow state reset.${zettlyNote}`);
}


import { closeZettlyTask } from '../../zettly-workflow.js';
