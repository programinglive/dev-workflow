import { classify } from '../../security/policy.js';
import { textResponse, isReleaseSatisfied, isErrorResponse, ensurePrdExists, loadDocGateInputs } from "./shared.js";
import { validateItemTexts } from "./dod.js";
import {
  validatePlanSteps,
  createPlan,
  normalizePlan,
  planProgress,
  renderPlanFull,
} from "./plan.js";
import {
  evaluateDocGate,
  isDocumentationPath,
  isGateSatisfied,
  normalizePath,
  pathKey,
  MIN_WAIVER_REASON,
  MAX_WAIVER_REASON,
} from "./docs.js";
import { activeForeignLock, projectLockDir, currentIsAlive, DEFAULT_LOCK_STALE_MS } from "../../process-lock.js";
import { resolveProjectDir, setActiveProjectDir } from "../../exec.js";
import { pinSessionProject, resolveHistoryFile } from "../../workflow-state.js";

/**
 * Catat repo proyek untuk sesi ini.
 *
 * Tanpa ini, satu-satunya penentu adalah WORKFLOW_PROJECT_DIR yang global.
 * Di mesin ini nilainya `D:\code\clinic`, jadi task yang sebenarnya bekerja di
 * repo lain tetap menjalankan git di clinic dan `commit_and_push` menjawab
 * "No changes detected" seolah sudah selesai (30 Oktober 2026).
 *
 * Best-effort: kalau repo belum bisa ditentukan, task tetap boleh mulai, tapi
 * pengguna diberi tahu supaya tidak terkejut saat commit.
 */
function pinProjectDir(args, workflowState) {
  const requested = typeof args.projectDir === "string" ? args.projectDir.trim() : "";

  let resolved = null;
  let error = null;
  try {
    resolved = resolveProjectDir({
      explicit: requested,
      env: process.env,
      candidates: [process.cwd(), process.env.INIT_CWD],
    });
  } catch (resolveError) {
    error = resolveError;
  }

  if (!resolved) {
    workflowState.state.projectDir = "";
    setActiveProjectDir("");
    return {
      message:
        `⚠️ Repo proyek belum ditentukan: ${error.message}\n` +
        `   Sebutkan 'projectDir' pada 'start_task' supaya commit tidak salah arah.`,
    };
  }

  workflowState.state.projectDir = resolved.dir;
  setActiveProjectDir(resolved.dir);

  const sourceNote = {
    explicit: "dari argumen projectDir",
    cwd: "dari direktori kerja sesi",
    env: "dari WORKFLOW_PROJECT_DIR (nilai global)",
    pinned: "dari projectDir sesi",
  }[resolved.source] || resolved.source;

  let message = `📁 Repo proyek: ${resolved.dir} (${sourceNote})`;

  // Sumber env berarti tidak ada sinyal per-sesi sama sekali. Kalau direktori
  // sesi ternyata menunjuk repo LAIN, hampir pasti env ini milik proyek lain -
  // dan itulah yang dulu membuat `git add .` berjalan di repo yang salah.
  if (resolved.conflict) {
    message +=
      `\n   ⚠️ KONFLIK: direktori sesi menunjuk repo lain, ${resolved.conflict.cwdDir}.` +
      `\n   Repo dipilih dari WORKFLOW_PROJECT_DIR. Kalau task ini untuk repo sesi,` +
      `\n   ulangi 'start_task' dengan projectDir: "${resolved.conflict.cwdDir}".`;
  } else if (resolved.source === "env") {
    message +=
      `\n   ⚠️ Repo ini berasal dari WORKFLOW_PROJECT_DIR, bukan dari sesi.` +
      `\n   Kalau task ini bekerja di repo lain, ulangi 'start_task' dengan projectDir yang benar.`;
  }

  return { message };
}

/**
 * Daftar berkas yang sudah kotor sebelum task dimulai.
 *
 * Kegagalan git di sini tidak boleh menggagalkan `start_task`: baseline hanya
 * dipakai untuk memperingatkan saat commit, dan task tanpa baseline tetap sah
 * (perilaku lama).
 */
async function captureDirtyAtStart(git) {
  if (!git || typeof git.getStatusOutput !== "function" ||
      typeof git.parseStatusEntries !== "function") {
    return [];
  }
  try {
    return git.parseStatusEntries(await git.getStatusOutput());
  } catch {
    return [];
  }
}

export async function handleStartTask(args, workflowState, git) {
  // Satu penulis per repo.
  //
  // 31 Oktober 2026 dua sesi OpenCode menulis satu working tree yang sama. Satu
  // sesi kehilangan seluruh suntingannya di `tools/handler-modules/index.js`
  // tanpa pesan apa pun: berkasnya kembali ke versi HEAD di tengah pekerjaan.
  // Penanda proses sudah ada sejak sebelumnya, tetapi hanya DICATAT sebagai
  // peringatan, jadi tidak ada yang menghentikan tabrakan.
  //
  // Sekarang `start_task` menolak memulai bila ada proses MCP lain yang hidup
  // DAN baru saja bekerja (ada detak dalam 10 menit) pada proyek yang sama.
  // Penanda yang basi diabaikan supaya proses MCP yang tertinggal tidak
  // memblokir selamanya. `force: true` tetap tersedia untuk pemilik mesin yang
  // tahu apa yang ia lakukan, dan alasannya dicatat di jawaban.
  const foreignLock = activeForeignLock({
    dir: projectLockDir(workflowState.stateFile),
    isAlive: currentIsAlive(),
  });

  if (foreignLock && args.force !== true) {
    const minutes = Math.max(1, Math.round(foreignLock.ageMs / 60000));
    const host = foreignLock.host ? ` di ${foreignLock.host}` : "";
    const started = Number.isFinite(Number(foreignLock.startedAt))
      ? new Date(Number(foreignLock.startedAt)).toISOString()
      : "waktu tidak diketahui";

    return textResponse(
      `⚠️ Dibatalkan: sesi lain sedang mengerjakan proyek ini.\n\n` +
        `Proses MCP PID ${foreignLock.pid}${host} berdetak ${minutes} menit lalu ` +
        `(hidup sejak ${started}).\n` +
        `Dua sesi pada satu working tree saling menimpa berkas: pada 31 Oktober 2026 ` +
        `satu sesi kehilangan seluruh suntingannya tanpa pesan.\n\n` +
        `Pilih salah satu:\n` +
        `  1. Tutup jendela OpenCode yang lain, lalu ulangi 'start_task'.\n` +
        `  2. Beri sesi ini worktree sendiri: opencode.worktree_create, lalu jalankan sesi dari sana.\n` +
        `  3. Kalau Anda yakin sesi itu sudah tidak dipakai, ulangi dengan { "force": true }.\n\n` +
        `Penanda dianggap basi setelah ${Math.round(DEFAULT_LOCK_STALE_MS / 60000)} menit tanpa detak.\n` +
        `Task BELUM dimulai; tidak ada state yang diubah.`
    );
  }

  // Task HIDUP milik proses lain tidak boleh dihapus, bahkan dengan `force`.
  //
  // 1 November 2026: satu sesi kehilangan seluruh Definition of Done-nya dua
  // kali dalam satu jam. Penyebabnya bukan hanya tabrakan berkas - `force: true`
  // bisa melewati `activeForeignLock`, lalu `reset()` mengosongkan
  // `definitionOfDone` milik task yang sedang dikerjakan sesi lain. Bukti DoD
  // yang sudah dikumpulkan tidak bisa dipulihkan dari arsip `history`.
  //
  // Penjaga ini membaca ISI STATE, bukan berkas lock: state adalah kebenaran,
  // lock hanya petunjuk. Kalau lock hilang atau rusak, penjaga tetap bekerja.
  // `force` tetap berguna untuk satu kasus sah - pemiliknya sudah mati.
  {
    const disk = await workflowState.readDiskState();
    if (disk) {
      const phase = typeof disk.currentPhase === "string" ? disk.currentPhase : "idle";
      const description = typeof disk.taskDescription === "string" ? disk.taskDescription.trim() : "";
      const ownerPid = Number(disk.owner?.pid);
      const foreignOwner = Number.isFinite(ownerPid) && ownerPid !== process.pid;

      // Batas basi, sama seperti `activeForeignLock`. Tanpa ini, proses MCP yang
      // ditinggal hidup setelah jendela OpenCode-nya ditutup - keadaan normal di
      // mesin ini, lihat `cleanup-stale-mcp` - memblokir `start_task` SELAMANYA,
      // dan `force` pun tidak menolong. Penjaga yang mustahil dilewati akan
      // dilewati orang dengan membunuh proses; itu lebih buruk daripada kedaluwarsa.
      const ownerSeenAt = Number(disk.owner?.updatedAt);
      const ownerFresh =
        Number.isFinite(ownerSeenAt) && Date.now() - ownerSeenAt < DEFAULT_LOCK_STALE_MS;

      if (phase !== "idle" && description !== "" && foreignOwner && ownerFresh && currentIsAlive()(ownerPid)) {
        const seen = Number.isFinite(ownerSeenAt)
          ? new Date(ownerSeenAt).toISOString()
          : "waktu tidak diketahui";

        return textResponse(
          `⚠️ Dibatalkan: task lain sedang berjalan di proses MCP PID ${ownerPid}.\n\n` +
            `Task      : "${description}"\n` +
            `Fase      : ${phase}\n` +
            `Pemilik   : PID ${ownerPid}, terakhir menulis state ${seen}\n\n` +
            `Memulai task baru di sini akan mengosongkan Definition of Done task itu, dan buktinya ` +
            `tidak bisa dipulihkan dari history. Karena itu 'force' TIDAK bisa melewati penjaga ini ` +
            `selama pemiliknya masih menulis.\n\n` +
            `Pilih salah satu:\n` +
            `  1. Selesaikan atau batalkan task itu dari sesi pemiliknya (complete_task / drop_task).\n` +
            `  2. Beri sesi ini worktree sendiri: opencode.worktree_create, lalu jalankan sesi dari sana.\n` +
            `  3. Kalau proses itu sudah tidak dipakai, tutup jendelanya. Penjaga berhenti menghalangi ` +
            `setelah ${Math.round(DEFAULT_LOCK_STALE_MS / 60000)} menit tanpa tulisan state.\n\n` +
            `Task BELUM dimulai; tidak ada state yang diubah.`
        );
      }
    }
  }

  // Validasi rencana. Skema mewajibkan `plan`; bila agen tidak mengirimnya,
  // rencana SEMENTARA diturunkan dari DoD supaya progres tetap bisa dibaca,
  // dan jawabannya menyebut terus terang bahwa urutannya belum benar.
  const planCheck = validatePlanSteps(args.plan);
  let planDerived = false;

  if (!planCheck.ok) {
    if (args.plan !== undefined) {
      return textResponse(
        `⚠️ ${planCheck.error}\n\n` +
          `Contoh pemakaian:\n` +
          `  plan: ["telusuri handler yang ada", "tulis tes yang gagal", "implementasi minimum"]\n\n` +
          `Task BELUM dimulai; workflow sebelumnya tidak diubah.`
      );
    }
    planDerived = true;
  }

  // Validasi DoD SEBELUM menyentuh state apa pun. Task yang ditolak tidak boleh
  // mengganti task yang sedang berjalan, dan tidak boleh meninggalkan state
  // setengah jadi yang membuat `get_workflow_status` membingungkan.
  const dodCheck = validateItemTexts(args.definitionOfDone);
  if (!dodCheck.ok) {
    return textResponse(
      `⚠️ ${dodCheck.error}\n\n` +
        `Contoh pemakaian:\n` +
        `  definitionOfDone: ["build lulus", "halaman login terverifikasi"]\n\n` +
        `Task BELUM dimulai; workflow sebelumnya tidak diubah.`
    );
  }

  // Selamatkan dulu pekerjaan yang mungkin tertimpa. Ini menangani dua kasus:
  //   1. Proses MCP LAIN menulis berkas state setelah kita memuatnya.
  //   2. Task kita sendiri yang belum selesai lalu diganti task baru.
  const preservedBeforeSave = await workflowState.reconcileWithDisk();
  const { archivedTask } = workflowState.reset({ archive: true });

  workflowState.state.currentPhase = "coding";
  workflowState.state.classification = classify(args);
  workflowState.state.taskDescription = args.description;
  workflowState.state.taskType = args.type;
  workflowState.state.plan = planDerived
    ? createPlan(dodCheck.items.map((text) => `Selesaikan: ${text}`))
    : createPlan(planCheck.items);
  workflowState.state.definitionOfDone = dodCheck.items.map((text, index) => ({
    id: `dod-${index + 1}`,
    text,
    status: "open",
    evidence: "",
    waivedReason: "",
    revision: 0,
    updatedAt: new Date().toISOString(),
  }));
  workflowState.state.dodSource = "manual";
  workflowState.state.dodFactoryTaskId = "";
  workflowState.state.dodRevision = 0;
  workflowState.state.testsSkipped = false;
  workflowState.state.testsSkippedReason = "";
  workflowState.state.commitAndPushCompleted = false;
  workflowState.state.lastCommitMessage = "";
  workflowState.state.lastPushBranch = "";
  // Setelah reset(), karena reset mengosongkan projectDir.
  const project = pinProjectDir(args, workflowState);

  // Catat proyek yang BENAR untuk sesi ini, lalu pindahkan state ke sana.
  //
  // Tanpa langkah ini identitas proyek hanya ditebak dari `process.cwd()`, yang
  // milik PROSES MCP dan sering bukan tempat sesi bekerja. Diukur 1 November
  // 2026: satu direktori `projects/Default-Project-<hash>/` menampung state dari
  // sesi yang mengerjakan `D:\code\belajar`, repo uji, dan repo ini sekaligus -
  // history tercampur dan `start_task` saling menolak antar proyek.
  if (workflowState.state.projectDir) {
    const pinned = pinSessionProject({
      stateFile: workflowState.stateFile,
      projectDir: workflowState.state.projectDir,
    });

    if (pinned && pinned.stateFile !== workflowState.stateFile) {
      // Bawa task yang baru saja disiapkan ke berkas proyek yang benar.
      const carried = { ...workflowState.state };
      workflowState.stateFile = pinned.stateFile;
      workflowState.historyFile = resolveHistoryFile(pinned.stateFile);
      workflowState.state = carried;
      await workflowState.load();
      workflowState.state = carried;
    }
  }

  // Catat berkas yang SUDAH kotor sebelum task ini dimulai.
  //
  // Saat commit nanti, berkas itu tidak boleh ikut ter-stage lewat `git add .`:
  // itu pekerjaan sesi lain yang kebetulan berada di working tree yang sama.
  // Kejadian nyata 31 Okt 2026: dua baris `billing.yaml` milik sesi lain masuk
  // commit sesi ini, dan tidak ada yang bisa membedakannya dari luar.
  workflowState.state.dirtyAtStart = await captureDirtyAtStart(git);

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

  const dodLines = workflowState.state.definitionOfDone
    .map((item) => `   ${item.id}: ${item.text}`)
    .join("\n");

  return textResponse(
    `✅ Task Started: ${args.description}\n\n${project.message}${warningBlock}\n\n` +
      `📋 Definition of Done (${workflowState.state.definitionOfDone.length} item, semua masih terbuka):\n${dodLines}\n` +
      `   Buktikan tiap item dengan 'mark_dod_item' { id, evidence } setelah benar-benar terbukti,\n` +
      `   atau kecualikan dengan 'waive_dod_item' { id, reason } bila memang tidak relevan.\n\n` +
      (planDerived
        ? `⚠️ 'plan' tidak dikirim, jadi rencana SEMENTARA diturunkan dari DoD.\n` +
          `   Urutannya belum tentu urutan kerja yang benar. Kirim 'plan' pada 'start_task',\n` +
          `   atau susun ulang sekarang dengan 'set_plan' { steps: [...] }.\n\n`
        : `${renderPlanFull(workflowState.state.plan)}\n\n`) +
      `🎯 Be conscious about what you're coding!\n\nWorkflow Steps:\n1. ✓ Start task (current)\n2. ⏳ Describe feature flow with Mermaid\n3. ⏳ Fix/implement the feature\n4. ⏳ Prove each definition-of-done item\n5. ⏳ Create tests\n6. ⏳ Run tests (must pass!)\n7. ⏳ Create documentation\n8. ⏳ Run 'check_ready_to_commit'\n9. ⏳ Run 'commit_and_push' (commits and pushes)\n10. ⏳ Run 'perform_release' or 'skip_release' (when no release is needed)\n11. ⏳ Complete task\n12. ✓ Workflow closed\n\nReminder: Focus on writing clean, maintainable code!`
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

/**
 * Ganti rencana task yang sedang berjalan.
 *
 * Dipakai saat rencana awal ternyata salah setelah ditelusuri. Langkah yang
 * sudah ditandai selesai dipertahankan bila teksnya sama, supaya mengganti
 * rencana tidak menghapus progres yang sudah nyata.
 */
export async function handleSetPlan(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Belum ada task aktif. Mulai dengan 'start_task' sebelum menyusun rencana.");
  }

  const check = validatePlanSteps(args.steps);
  if (!check.ok) {
    return textResponse(`⚠️ ${check.error}\n\nRencana lama tidak diubah.`);
  }

  const previous = normalizePlan(workflowState.state.plan);
  const doneTexts = new Set(
    previous.filter((item) => item.status === "done").map((item) => item.text.toLowerCase()),
  );

  const next = createPlan(check.items).map((item) =>
    doneTexts.has(item.text.toLowerCase()) ? { ...item, status: "done" } : item,
  );

  workflowState.state.plan = next;
  await workflowState.save();

  return textResponse(`✅ Rencana diperbarui.\n\n${renderPlanFull(next)}`);
}

/**
 * Tandai satu langkah rencana sebagai selesai (atau buka kembali).
 *
 * Idempoten: menandai ulang langkah yang sudah selesai tidak mengubah apa pun.
 * Membuka kembali berguna saat langkah yang dikira selesai ternyata belum.
 */
export async function handleMarkPlanStep(args, workflowState) {
  if (workflowState.state.currentPhase === "idle") {
    return textResponse("⚠️ Belum ada task aktif.");
  }

  const plan = normalizePlan(workflowState.state.plan);
  if (plan.length === 0) {
    return textResponse(
      "⚠️ Task ini belum punya rencana. Isi dengan 'set_plan' { steps: [...] } lebih dulu."
    );
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  const item = plan.find((entry) => entry.id === id);
  if (!item) {
    return textResponse(
      `⚠️ Tidak ada langkah ber-id "${id}".\n\n${renderPlanFull(plan)}`
    );
  }

  const status = args.status === "open" ? "open" : "done";
  workflowState.state.plan = plan.map((entry) =>
    entry.id === id ? { ...entry, status, updatedAt: new Date().toISOString() } : entry,
  );
  await workflowState.save();

  const progress = planProgress(workflowState.state.plan);
  return textResponse(
    `${status === "done" ? "✅" : "↩️"} Langkah ${id} ${status === "done" ? "selesai" : "dibuka kembali"}: ${item.text}\n\n` +
      `${renderPlanFull(workflowState.state.plan)}\n\n` +
      `Progres: ${progress.done}/${progress.total}` +
      (progress.next ? ` — berikutnya: ${progress.next.text}` : " — semua langkah selesai")
  );
}

export async function handleCreateDocumentation(args, workflowState, context = {}) {
  if (!workflowState.state.testsPassed) {
    return textResponse("⚠️ Please ensure tests are passing first! Run 'run_tests' with passed=true.");
  }

  if (!ensurePrdExists()) {
    return textResponse(
      `⚠️ PRD file not found!\n\nExpected location: docs/PRD.md\n\nPlease create or update the PRD before marking documentation as complete.`
    );
  }

  // `files` diverifikasi terhadap working tree. Tanpa ini, langkah dokumentasi
  // kembali menjadi klaim: `documentationType: "inline-comments"` dulu cukup
  // untuk menutupnya, dan README tidak pernah tersentuh.
  const requested = Array.isArray(args.files)
    ? args.files.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];

  const inputs = await loadDocGateInputs({ workflowState, git: context.git });
  const changed = new Set(inputs.changedPaths.map(pathKey));

  if (requested.length > 0) {
    const notDocumentation = requested.filter((p) => !isDocumentationPath(p));
    if (notDocumentation.length > 0) {
      return textResponse(
        `⚠️ Dibatalkan: ini bukan berkas dokumentasi: ${notDocumentation.join(", ")}\n\n` +
          `Berkas dokumentasi adalah README*, CHANGELOG*, CONTRIBUTING*, apa pun di bawah ` +
          `docs/ atau doc/, serta berkas .md/.mdx/.rst/.adoc di luar direktori tes.`
      );
    }

    const missing = requested.filter((p) => !changed.has(pathKey(p)));
    if (missing.length > 0) {
      const actual = inputs.changedPaths.length > 0
        ? inputs.changedPaths.map((p) => `   • ${p}`).join("\n")
        : "   (tidak ada perubahan sama sekali)";
      return textResponse(
        `⚠️ Dibatalkan: berkas ini disebut sebagai dokumentasi tetapi tidak muncul ` +
          `sebagai perubahan di working tree: ${missing.join(", ")}\n\n` +
          `Yang benar-benar berubah sekarang:\n${actual}\n\n` +
          `Sebutkan path relatif terhadap akar repo (contoh: "README.md"), bukan path absolut. ` +
          `Perbarui berkasnya lebih dulu, lalu sebut ulang. ` +
          `Kalau dokumentasi memang tidak perlu diubah, pakai 'waive_documentation' { reason }.\n\n` +
          `Tidak ada state yang diubah.`
      );
    }
  }

  const gate = evaluateDocGate({
    changedPaths: inputs.changedPaths,
    dirtyAtStart: inputs.dirtyAtStart,
    declaredFiles: requested.length > 0 ? requested : inputs.declaredFiles,
    hasDocumentation: inputs.hasDocumentation,
    waived: Boolean(workflowState.state.documentationWaived),
  });

  workflowState.state.documentationCreated = true;
  workflowState.state.documentationType = args.documentationType;
  workflowState.state.documentationSummary = args.summary;
  // Hanya ditimpa bila `files` benar-benar dikirim. Panggilan kedua tanpa
  // `files` (atau lewat run_full_workflow dengan daftar kosong) tidak boleh
  // menghapus bukti yang sudah terverifikasi sebelumnya.
  if (requested.length > 0) {
    workflowState.state.documentationFiles = requested;
  }
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

  // Pesan sukses WAJIB diawali ✅. `isErrorResponse` memperlakukan awalan ⚠️
  // sebagai kegagalan, dan `run_full_workflow` akan berhenti di langkah ini.
  const gateNote = isGateSatisfied(gate.status)
    ? requested.length > 0
      ? `✅ Gerbang dokumentasi terpenuhi oleh: ${requested.join(", ")}`
      : `✅ Gerbang dokumentasi terpenuhi (${gate.status}).`
    : `⚠️ Gerbang dokumentasi belum terpenuhi: ${gate.sourceChanged.length} berkas source ` +
      `berubah tanpa berkas dokumentasi.\n` +
      `   'check_ready_to_commit' akan menolak sampai Anda memakai 'files: [...]' ` +
      `atau 'waive_documentation'.`;

  return textResponse(
    `✅ Documentation created/updated!\n\n` +
      `Type: ${args.documentationType}\nSummary: ${args.summary}\n` +
      (requested.length > 0 ? `Files: ${requested.join(", ")}\n` : "") +
      `✅ PRD check: docs/PRD.md ada di paket MCP (bukan di repo proyek).\n` +
      `${gateNote}\n\n` +
      `🎉 You're ready to verify your work!\n\n` +
      `Next Steps:\n` +
      `1. ✓ Fix/implement feature\n` +
      `2. ✓ Create tests\n` +
      `3. ✓ Run tests (GREEN!)\n` +
      `4. ✓ Create/update documentation\n` +
      `5. ⏳ Run 'check_ready_to_commit' to verify\n` +
      `6. ⏳ Run 'commit_and_push'\n` +
      `7. ⏳ Run 'perform_release' (or 'skip_release' when applicable)\n` +
      `8. ⏳ Mark as complete with 'complete_task'`
  );
}

/**
 * Kecualikan gerbang dokumentasi dengan alasan tertulis.
 *
 * Waiver adalah KEPUTUSAN, bukan jalan pintas: alasannya ikut ke entri history,
 * ke laporan commit, dan ke rekomendasi sesi berikutnya. Pola me-waive setiap
 * task jadi terlihat, bukan tersembunyi.
 */
export async function handleWaiveDocumentation(args, workflowState) {
  if (!workflowState.state.testsPassed && !workflowState.state.testsSkipped) {
    return textResponse(
      "⚠️ Selesaikan langkah tes lebih dulu (run_tests dengan passed=true, atau skip_tests), " +
        "sebelum mengecualikan gerbang dokumentasi."
    );
  }

  const reason = typeof args.reason === "string" ? args.reason.trim() : "";

  if (reason.length < MIN_WAIVER_REASON) {
    return textResponse(
      `⚠️ Dibatalkan: alasan waiver minimal ${MIN_WAIVER_REASON} karakter.\n\n` +
        `Tulis KENAPA dokumentasi tidak perlu diubah, bukan sekadar "tidak perlu". ` +
        `Alasan ini masuk history dan akan terbaca lagi di sesi berikutnya.`
    );
  }

  if (reason.length > MAX_WAIVER_REASON) {
    return textResponse(
      `⚠️ Dibatalkan: alasan waiver maksimal ${MAX_WAIVER_REASON} karakter; dikirim ${reason.length}.`
    );
  }

  workflowState.state.documentationWaived = true;
  workflowState.state.documentationWaiverReason = reason;
  workflowState.state.readyCheckCompleted = false;
  await workflowState.save();

  return textResponse(
    `✅ Gerbang dokumentasi dikecualikan untuk task ini.\n\n` +
      `Alasan: ${reason}\n\n` +
      `Alasan ini dicatat di history, disebut di laporan commit, dan muncul di rekomendasi ` +
      `sesi berikutnya. Lanjutkan dengan 'check_ready_to_commit'.`
  );
}
