import { classify } from '../../security/policy.js';
import { textResponse, isReleaseSatisfied, isErrorResponse, ensurePrdExists } from "./shared.js";
import { validateItemTexts } from "./dod.js";
import { activeForeignLock, projectLockDir, currentIsAlive, DEFAULT_LOCK_STALE_MS } from "../../process-lock.js";
import { resolveProjectDir, setActiveProjectDir } from "../../exec.js";

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
