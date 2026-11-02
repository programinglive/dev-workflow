import { textResponse, formatChecklist, isReleaseSatisfied, getContinueGuidance, resetToCommitIfWorkingChanges, loadDocGateInputs } from "./shared.js";
import { handleCommitAndPush } from "./commit-handlers.js";
import { openItems, renderChecklist, renderOutstanding, summarize } from "./dod.js";
import { evaluateDocGate, isGateSatisfied, formatRelativeAge, renderDocGateFailure } from "./docs.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { STRANDED_TASK_FILENAME } from "../../workflow-state.js";
import { renderPlanFull } from "./plan.js";

/**
 * Bahan gerbang dokumentasi untuk pesan penolakan.
 *
 * `unknown` dipakai saat git tidak tersedia: gerbang yang diam-diam memblokir
 * lebih buruk daripada gerbang yang mengaku tidak tahu, dan handler dipanggil
 * tanpa context di beberapa tes lama.
 */
async function evaluateDocumentationGate(workflowState, context) {
  const git = context?.git;

  if (!git || typeof git.getStatusOutput !== "function") {
    return { status: "unknown", sourceChanged: [], docsTouched: [], readmePath: "", readmeAge: "" };
  }

  const inputs = await loadDocGateInputs({ workflowState, git });
  const gate = evaluateDocGate({
    changedPaths: inputs.changedPaths,
    dirtyAtStart: inputs.dirtyAtStart,
    declaredFiles: inputs.declaredFiles,
    hasDocumentation: inputs.hasDocumentation,
    waived: Boolean(workflowState.state.documentationWaived),
  });

  let readmeAge = "";
  if (inputs.readmePath && typeof git.getLastCommitForPath === "function") {
    try {
      readmeAge = formatRelativeAge(await git.getLastCommitForPath(inputs.readmePath));
    } catch {
      readmeAge = "";
    }
  }

  return { ...gate, readmePath: inputs.readmePath, readmeAge };
}

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
      // Sejak 1.17.0 state dipisah per sesi, jadi ini BUKAN lagi "state dipakai
      // bersama antar sesi". Yang tersisa: berkas sesi ini pernah ditulis proses
      // lain - satu proses melayani beberapa sesi, atau berkas baru saja
      // dimigrasikan. Pernyataan lama menyesatkan dan menyuruh orang memeriksa
      // hal yang sudah tidak berlaku.
      sharedWarning =
        `\n\n⚠️ PERINGATAN: berkas state sesi ini terakhir ditulis proses MCP LAIN ` +
        `(${owner.processMarker || "tanpa-token"}, pid ${owner.pid ?? "?"}).\n` +
        `   Biasanya ini berarti satu proses melayani beberapa sesi OpenCode, atau ` +
        `berkas baru saja dimigrasikan.\n` +
        `   Periksa apakah "Task:" di atas benar-benar milik Anda SEBELUM commit_and_push.`;
      if (disk.currentPhase && disk.currentPhase !== "idle" && disk.taskDescription) {
        sharedWarning += `\n   Proses itu sedang mengerjakan: "${disk.taskDescription}"`;
      }
    }
  } catch {
    // Status tetap ditampilkan walau pemeriksaan berkas gagal.
  }

  const dodItems = Array.isArray(status.definitionOfDone) ? status.definitionOfDone : [];
  const dod = summarize(dodItems, status.dodRevision);
  const dodSource = status.dodSource === "factory" ? " (dari papan Factory)" : "";

  // Task yang sedang berjalan saat tata letak state berubah tidak disalin ke
  // berkas sesi (menyalinnya berarti mewarisi pekerjaan orang lain), tetapi ia
  // juga tidak boleh hilang tanpa jejak. Jejaknya ditulis `migrateStateToSession`.
  let strandedNote = "";
  try {
    const stateDir = path.dirname(workflowState.stateFile);
    const projectDir = path.basename(path.dirname(stateDir)) === "users"
      ? path.dirname(path.dirname(stateDir))
      : stateDir;
    const strandedPath = path.join(projectDir, STRANDED_TASK_FILENAME);
    if (existsSync(strandedPath)) {
      const stranded = JSON.parse(readFileSync(strandedPath, "utf-8"));
      if (stranded?.taskDescription) {
        strandedNote =
          `\n\n⚠️ Ada task yang TIDAK dipindahkan saat tata letak state berubah:\n` +
          `   "${stranded.taskDescription}" (fase ${stranded.phase || "tidak diketahui"})\n` +
          `   State-nya masih utuh di ${stranded.sourcePath || "berkas state lama"}.\n` +
          `   Selesaikan dari sesi asalnya, atau catat ulang dengan 'start_task' bila memang ditinggalkan.`;
      }
    }
  } catch {
    // Jejak rusak tidak boleh menghalangi status.
  }
  const dodBlock =
    dodItems.length === 0
      ? "DoD: belum ada item - isi dengan 'set_definition_of_done'"
      : `DoD: ${dod.done}/${dod.total} selesai, ${dod.waived} dilewati, ${dod.open} terbuka${dodSource}\n` +
        renderChecklist(dodItems, status.dodRevision);

  const planBlock = renderPlanFull(status.plan);

  // Replika dan pertikaian penulis: dua keadaan yang dulu tidak punya suara
  // sama sekali. Yang pertama membuat dashboard tampak kosong padahal datanya
  // ada; yang kedua membuat dua proses saling menimpa tanpa ada yang tahu
  // sebabnya. Keduanya ditampilkan di sini, bukan di dashboard: antrean tinggal
  // di mesin ini, dan dashboard justru tidak bisa dijangkau saat itulah.
  let opsNote = "";
  try {
    const { queueDepth } = await import("../../db/replicate.js");
    const adapter = workflowState.dbAdapter ?? (await workflowState._db());
    const depth = await queueDepth(adapter);

    if (depth.pending > 0) {
      opsNote = `\nReplika: tertunda ${depth.pending}`;
      if (depth.oldestAgeMs > 60000) {
        opsNote += ` (tertua ${Math.round(depth.oldestAgeMs / 1000)} detik)`;
      }
    }

    const sessionKey = workflowState._sessionKey().key;
    const contenders = adapter.db
      .prepare(
        `SELECT count(DISTINCT process_token) AS c FROM state_writer_history
          WHERE session_key = ? AND written_at > datetime('now', '-60 seconds')`,
      )
      .get(sessionKey).c;

    if (contenders > 1) {
      opsNote +=
        `\n⚠️ Dua proses menulis sesi yang sama dalam 60 detik terakhir. ` +
        `Pastikan "Task:" di atas benar-benar milik Anda sebelum menutup task.`;
    }
  } catch {
    // Laporan tambahan tidak boleh menghalangi status.
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

${dodBlock}

${planBlock}

Next step: ${nextStep}${opsNote}${sharedWarning}${strandedNote}`
  );
}

export async function handleReadyCheck(workflowState, context = {}) {
  const status = workflowState.state;
  const testsCreatedDone = status.testsSkipped || status.testsCreated;
  const testsPassedDone = status.testsSkipped || status.testsPassed;

  // Definition of Done adalah prasyarat, bukan langkah baru: ia tidak pernah
  // memindahkan `currentPhase` sendiri. Ia hanya memutuskan lolos atau tidak.
  const dodItems = Array.isArray(status.definitionOfDone) ? status.definitionOfDone : [];
  const dod = summarize(dodItems, status.dodRevision);
  const dodRecorded = dodItems.length > 0;
  const dodSatisfied = dodRecorded && dod.open === 0;

  // Gerbang dokumentasi membaca working tree, bukan label. Inilah satu-satunya
  // alasan `documentationType: "inline-comments"` tidak lagi cukup untuk
  // menutup langkah dokumentasi.
  const docGate = await evaluateDocumentationGate(workflowState, context);
  const docGateSatisfied = isGateSatisfied(docGate.status);

  const checks = [
    { name: "Task started", done: status.currentPhase !== "idle" },
    { name: "Feature flow described", done: status.featureFlowCreated },
    { name: "Definition of done recorded", done: dodRecorded },
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
    { name: "Documentation updated for code changes", done: docGateSatisfied },
    { name: "Definition of done satisfied", done: dodSatisfied },
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

  // Sebut item yang menghalangi, bukan hanya centang merah: agen yang ditolak
  // harus tahu persis apa yang harus dibuktikan atau dikecualikan.
  const hints = [];

  if (!docGateSatisfied) {
    hints.push(
      renderDocGateFailure({
        sourceChanged: docGate.sourceChanged,
        readmePath: docGate.readmePath,
        readmeAge: docGate.readmeAge,
      }),
    );
  }

  if (!dodRecorded) {
    hints.push(
      "Belum ada item DoD untuk task ini. Isi dengan 'set_definition_of_done' { items: [...] } " +
        "sebelum task bisa di-commit."
    );
  } else if (!dodSatisfied) {
    hints.push(
      `Item DoD yang belum terpenuhi:\n${renderOutstanding(dodItems, status.dodRevision)}\n` +
        `Buktikan dengan 'mark_dod_item' { id, evidence } atau kecualikan dengan 'waive_dod_item' { id, reason }.`
    );
  }

  const hintBlock = hints.length > 0 ? `\n\n${hints.join("\n\n")}` : "";

  return textResponse(`⚠️ NOT READY TO COMMIT!\n\n${checkList}${hintBlock}\n\nPlease complete all steps before committing.`);
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
    return handleReadyCheck(workflowState, context);
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
  // DoD ikut melewati reset. Tanpa ini, `rerun_workflow` menghapus checklist
  // dan meninggalkan task yang tidak akan pernah bisa ditutup, karena gerbang
  // menolak task tanpa item DoD.
  const dod = {
    definitionOfDone: Array.isArray(workflowState.state.definitionOfDone)
      ? workflowState.state.definitionOfDone.map((item) => ({ ...item }))
      : [],
    dodSource: workflowState.state.dodSource || "",
    dodFactoryTaskId: workflowState.state.dodFactoryTaskId || "",
    dodRevision: Number(workflowState.state.dodRevision) || 0,
  };

  if (!currentDescription) {
    return textResponse("⚠️ No active task to rerun. Use 'start_task' to begin a new workflow.");
  }

  workflowState.reset();

  workflowState.state.currentPhase = "coding";
  workflowState.state.taskDescription = currentDescription;
  workflowState.state.taskType = currentType;
  Object.assign(workflowState.state, dod);
  await workflowState.save();

  const dodNote =
    dod.definitionOfDone.length > 0
      ? `\n\nDoD dipertahankan: ${dod.definitionOfDone.length} item` +
        ` (${dod.definitionOfDone.filter((item) => item.status === "done").length} sudah terbukti).` +
        `\nItem yang sudah terbukti TIDAK perlu dibuktikan ulang - kecualikan dengan 'waive_dod_item',` +
        ` atau tambah item baru dengan 'set_definition_of_done' { items: [...], append: true }.`
      : "";

  return textResponse(
    `🔄 Rerunning workflow from the start!\n\nTask: ${currentDescription}\nType: ${currentType}${dodNote}\n\nWorkflow Steps:\n1. ✓ Start task (current)\n2. ⏳ Describe feature flow with Mermaid\n3. ⏳ Fix/implement the feature\n4. ⏳ Prove each definition-of-done item\n5. ⏳ Create tests\n6. ⏳ Run tests (must pass!)\n7. ⏳ Create documentation\n8. ⏳ Run 'check_ready_to_commit'\n9. ⏳ Run 'commit_and_push' (commits and pushes)\n10. ⏳ Run 'perform_release' (handles versioning and tags)\n11. ⏳ Complete task\n\n🎯 Be conscious about what you're coding!`
  );
}
