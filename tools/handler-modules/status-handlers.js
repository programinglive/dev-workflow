import { textResponse, formatChecklist, isReleaseSatisfied, getContinueGuidance, resetToCommitIfWorkingChanges, loadDocGateInputs } from "./shared.js";
import { handleCommitAndPush } from "./commit-handlers.js";
import { openItems, renderChecklist, renderOutstanding, summarize } from "./dod.js";
import { evaluateDocGate, isGateSatisfied, formatRelativeAge, renderDocGateFailure } from "./docs.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { STRANDED_TASK_FILENAME } from "../../workflow-state.js";
import { renderPlanFull } from "./plan.js";
import { fetchActiveSessions, fetchBuildReport, monitorUrl, localMonitorUrl } from "../../monitor.js";
import { estimateBuild } from "../../monitor-server/build-report.cjs";
import { formatMcpRecommendations } from "../../mcp-index.js";
import { formatBuildStatusBlock } from "../../build-monitor.js";

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
  const buildBlock = formatBuildStatusBlock(status.activeBuild, status.buildHistory);
  const mcpBlock = formatMcpRecommendations({
    description: status.taskDescription,
    projectDir: status.projectDir,
    definitionOfDone: status.definitionOfDone,
    plan: status.plan,
  });

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

    const { userId, projectPath, sessionKey } = workflowState._storageIds();
    const contenders = adapter.contenders(userId, projectPath, sessionKey);

    if (contenders > 1) {
      opsNote +=
        `\n⚠️ Dua proses menulis sesi yang sama dalam 60 detik terakhir. ` +
        `Pastikan "Task:" di atas benar-benar milik Anda sebelum menutup task.`;
    }

    // State sisa yang tersimpan tetapi tidak bisa dijangkau sesi mana pun:
    // cadangan `legacy-project` dan baris `pid-*` dari era sebelum kunci sesi
    // berubah. Itu data pengguna, jadi ditampilkan - bukan dibiarkan tak terlihat.
    const orphans = adapter.findOrphanStates(userId, projectPath);
    if (orphans.length > 0) {
      opsNote += `\nState tersimpan yang tidak terpakai sesi mana pun (${orphans.length}):`;
      for (const o of orphans.slice(0, 5)) {
        opsNote += `\n   ${o.sessionKey}: "${o.taskDescription || "(tanpa task)"}" (${o.phase})`;
      }
      opsNote += `\n   Pulihkan dengan resume_session bila masih diperlukan.`;
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

${planBlock}${buildBlock ? `\n\n${buildBlock}` : ""}${mcpBlock ? `\n\n${mcpBlock}` : ""}

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
    {
      name: status.documentationWaived ? "Documentation waived" : "Documentation created",
      done: Boolean(status.documentationCreated || status.documentationWaived),
    },
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

  const buildBlock = formatBuildStatusBlock(status.activeBuild, status.buildHistory);
  if (buildBlock) {
    sections.push(buildBlock);
  }

  const mcpRecs = formatMcpRecommendations({
    description: status.taskDescription,
    projectDir: status.projectDir,
    definitionOfDone: status.definitionOfDone,
    plan: status.plan,
  });
  if (mcpRecs) {
    sections.push(mcpRecs);
  }

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

export async function handleListActiveSessions(args = {}, context = {}) {
  const env = context.env || process.env;
  const fetchImpl = context.fetchImpl || fetch;
  const limit = args.limit || 20;
  const showAll = Boolean(args.all);
  const filterMachine = typeof args.machine === "string" ? args.machine.trim().toLowerCase() : "";

  const result = await fetchActiveSessions({ env, limit, fetchImpl });
  if (!result.ok) {
    return textResponse(`⚠️ Gagal mengambil daftar sesi dari monitor:\n${result.error}`);
  }

  let sessions = result.sessions || [];
  if (filterMachine) {
    sessions = sessions.filter((s) => String(s.machine || "").toLowerCase().includes(filterMachine));
  }
  if (!showAll) {
    // Default: hanya sesi yang aktif (live, possibly_stuck, atau sedang coding/ready/testing)
    sessions = sessions.filter((s) => {
      const state = String(s.state || "").toLowerCase();
      const phase = String(s.phase || "").toLowerCase();
      return state === "live" || state === "possibly_stuck" || (phase !== "idle" && state !== "ended");
    });
  }

  const base = monitorUrl(env);
  const local = localMonitorUrl(env);

  if (sessions.length === 0) {
    const urlLine = base ? `\n🔗 Dashboard: ${base}` : "";
    const localLine = local && local !== base ? `\n🖥️  Buka di browser: ${local}` : "";
    const hint = showAll ? "" : " (Gunakan 'all: true' untuk melihat seluruh sesi termasuk yang idle/berakhir)";
    return textResponse(`📋 Tidak ada sesi aktif yang ditemukan di dashboard monitor.${urlLine}${localLine}${hint}`);
  }

  const lines = [
    `📊 Sesi Monitor Dev Workflow (${sessions.length} sesi${showAll ? "" : " aktif"}):`,
  ];
  if (base) {
    lines.push(`🔗 Dashboard: ${base}`);
  }
  if (local && local !== base) {
    lines.push(`🖥️  Buka di browser: ${local}`);
  }
  lines.push("");

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const machine = s.machine || "unknown";
    const proj = s.project_name || "(tanpa proyek)";
    const task = s.task ? `"${s.task}"` : "(tanpa task)";
    const phase = s.phase || "idle";
    const stateLabel = s.state_label || s.state || "unknown";
    const planText = s.plan_total ? ` · Rencana: ${s.plan_done}/${s.plan_total}` : "";
    const dodText = s.dod_total ? ` · DoD: ${s.dod_done}/${s.dod_total}` : "";
    const agent = s.agent_tool && s.agent_tool !== "unknown" ? ` [${s.agent_tool}]` : "";
    const ab = s.active_build || s.activeBuild || null;
    const buildLine =
      ab && ab.target
        ? `\n   🏗️ Build: [${String(ab.status || "building").toUpperCase()}] ${ab.target}${ab.stage ? ` — ${ab.stage}` : ""}${Number.isFinite(ab.progress) ? ` (${ab.progress}%)` : ""}`
        : "";

    lines.push(
      `${i + 1}. [${machine}] ${proj}${agent}\n` +
      `   Task: ${task}\n` +
      `   Fase: ${phase} (${stateLabel})${planText}${dodText}${buildLine}`
    );
  }

  return textResponse(lines.join("\n"));
}

function minutesLabel(ms) {
  if (!Number.isFinite(ms)) return "-";
  return `${Math.max(0, Math.round(ms / 60000))}m`;
}

function buildRange(estimate) {
  if (!Number.isFinite(estimate.remainingLowMs) || !Number.isFinite(estimate.remainingHighMs)) {
    return "";
  }
  if (estimate.remainingLowMs === estimate.remainingHighMs) {
    return `${minutesLabel(estimate.remainingLowMs)} lagi`;
  }
  return `${minutesLabel(estimate.remainingLowMs)}–${minutesLabel(estimate.remainingHighMs)} lagi`;
}

export function renderBuildEstimateLine(estimate) {
  const n = estimate.sampleCount;
  switch (estimate.state) {
    case "failed":
      return `Build gagal setelah ${estimate.reason.replace("failed after ", "")} (tidak ada ETA).`;
    case "succeeded":
      return `Build selesai (${estimate.reason.replace("finished in ", "")}).`;
    case "no-baseline":
      return `${estimate.reason} — perkiraan belum bisa dibuat.`;
    case "overdue":
      return `Lewat p90: ${estimate.reason}. Angka sisa tidak lagi ditampilkan.`;
    case "stalled":
      return `Estimasi berubah: ${estimate.reason} — ${buildRange(estimate)} (p50–p90, n=${n}), tidak dapat diandalkan.`;
    default: {
      const basis = estimate.basis === "progress" ? `dari ${estimate.reason}` : estimate.basis === "stage" ? `dari ${estimate.reason}` : `p50–p90, n=${n}`;
      return `≈${buildRange(estimate)} (${basis})`;
    }
  }
}

export async function handleBuildReport(args = {}, context = {}) {
  const env = context.env || process.env;
  const fetchImpl = context.fetchImpl || fetch;
  const days = args.days || 30;
  const result = await fetchBuildReport({ env, days, project: args.project, host: args.host, fetchImpl });
  if (!result.ok) {
    return textResponse(`?? Gagal mengambil laporan build dari monitor:\n${result.error}`);
  }

  const report = result.report || {};
  const projects = Array.isArray(report.projects) ? report.projects : [];
  const windowDays = report.window_days || days;
  if (projects.length === 0) {
    return textResponse(`Belum ada build selesai dalam ${windowDays} hari terakhir.`);
  }

  const rows = projects.slice(0, 10).map((project) => {
    const stages = (project.stages || []).slice(0, 3)
      .map((stage) => `${stage.stage} ${minutesLabel(stage.p50Ms)}`)
      .join(", ");
    return `- **${project.project}** — ${project.count} build · p50 ${minutesLabel(project.p50Ms)} · p90 ${minutesLabel(project.p90Ms)} · max ${minutesLabel(project.maxMs)}${stages ? `\n  stage: ${stages}` : ""}`;
  });

  const slowest = (report.slowest || []).slice(0, 3)
    .map((run) => `  - ${run.project}/${run.target} ${minutesLabel(run.durationMs)} (${run.status})`);

  const totals = report.totals || {};
  const lines = [
    `Laporan durasi build (${windowDays} hari, ${totals.runs || 0} build selesai, ${totals.failed || 0} gagal, ${totals.unclosed || 0} tanpa penutup)`,
    "",
    ...rows,
  ];
  if (slowest.length) lines.push("", "Terslowest:", ...slowest);
  return textResponse(lines.join("\n"));
}

export async function handleBuildEstimate(args = {}, context = {}) {
  const env = context.env || process.env;
  const fetchImpl = context.fetchImpl || fetch;
  const workflowState = context.workflowState;
  const project = String(args.project || "").trim();
  const target = String(args.target || "").trim();
  if (!project) {
    return textResponse("?? Sebutkan 'project' agar baseline-nya jelas.");
  }

  const result = await fetchBuildReport({ env, days: args.days || 30, project, fetchImpl });
  if (!result.ok) {
    return textResponse(`?? Gagal mengambil baseline build dari monitor:\n${result.error}`);
  }

  const report = result.report || {};
  const projectSummary = (report.projects || []).find((entry) => entry.project === project) || null;
  const targetSummary = target && projectSummary
    ? (projectSummary.targets || []).find((entry) => entry.target === target)
    : null;
  const summary = {
    count: targetSummary ? targetSummary.count : projectSummary ? projectSummary.count : 0,
    p50Ms: targetSummary ? targetSummary.p50Ms : projectSummary ? projectSummary.p50Ms : null,
    p90Ms: targetSummary ? targetSummary.p90Ms : projectSummary ? projectSummary.p90Ms : null,
    stages: projectSummary ? projectSummary.stages : [],
    stageOrder: projectSummary ? projectSummary.stageOrder : [],
  };

  const activeBuild = workflowState && workflowState.state ? workflowState.state.activeBuild : null;
  const matchesRunning = activeBuild && (!target || String(activeBuild.target || "") === target);
  const now = Date.now();
  const run = matchesRunning
    ? {
        status: activeBuild.status || "running",
        startedAt: activeBuild.startedAt,
        progress: activeBuild.progress,
        progressUpdatedAt: activeBuild.progressUpdatedAt || activeBuild.updatedAt,
        stage: activeBuild.stage,
        stageStartedAt: activeBuild.stageStartedAt || activeBuild.startedAt,
      }
    : { status: "running", startedAt: new Date(now).toISOString() };

  const estimate = estimateBuild({ summary, run, now });
  const label = target ? `${project}/${target}` : project;
  return textResponse(`${label} (n=${estimate.sampleCount})\n${renderBuildEstimateLine(estimate)}`);
}
