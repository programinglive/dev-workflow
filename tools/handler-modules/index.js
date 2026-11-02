import { textResponse, isReleaseSatisfied, isErrorResponse, loadDocGateInputs } from "./shared.js";
import { evaluateDocGate, isGateSatisfied, formatRelativeAge, renderDocGateFailure, MIN_WAIVER_REASON } from "./docs.js";
import { assertSafeKnowledge } from '../../security/policy.js';
import { safeLog, securityOutputFilter } from '../../security/sanitizer.js';
import { securityAudit } from '../../security/audit.js';
import path from 'node:path';
import { assertSafeToolCommand } from '../../security/commands.js';
import { sessionKeyFromRequest } from "../../workflow-state.js";
import { handleStartTask, handleMarkBugFixed, handleCreateTests, handleSkipTests, handleRunTests, handleCreateDocumentation, handleCreateFeatureFlow, handleWaiveDocumentation } from "./workflow-handlers.js";
import { handleSkipRelease, handlePerformRelease } from "./release-handlers.js";
import { handleCommitAndPush, handleCompleteTask, handleForceCompleteTask, handleDropTask } from "./commit-handlers.js";
import { handleProjectSummary, handleProjectSummaryData, handleProjectSummaryDb, handleViewHistory } from "./summary-handlers.js";
import { handleGetWorkflowStatus, handleReadyCheck, handleContinueWorkflow, handleRerunWorkflow } from "./status-handlers.js";
import { handleSetDefinitionOfDone, handleMarkDodItem, handleWaiveDodItem } from "./dod-handlers.js";
import { handleNextSteps } from "./next-steps-handlers.js";
import { handleResumeSession } from "./resume-handlers.js";
import { handleSetPlan, handleMarkPlanStep } from "./workflow-handlers.js";
import { renderPlanShort } from "./plan.js";
import { openItems, MIN_EVIDENCE } from "./dod.js";
import { handleListFactoryTasks, handleClaimFactoryTask, handleSyncTaskStatus, handleListFactoryProjects, handleCreateFactoryTask, handleUpdateFactoryTask } from "./factory-handlers.js";

function summarizeResponse(label, response) {
  const text = response?.content?.[0]?.text || "";
  const firstLine = text.split("\n")[0] || "";
  return `${label}: ${firstLine}`;
}

async function handleRunFullWorkflow(args, { workflowState, exec, git, utils }) {
  const description = workflowState.state.taskDescription;
  if (!description) {
    return textResponse("⚠️ Please start a task first using 'start_task' before running the full workflow.");
  }

  await workflowState.ensurePrimaryFile();

  const requestedBranch = typeof args.branch === "string" ? args.branch.trim() : "";
  if (requestedBranch) {
    workflowState.state.lastPushBranch = requestedBranch;
    await workflowState.save();
  }

  const requiredStrings = [
    { key: "summary", message: "Provide a non-empty 'summary' for mark_bug_fixed." },
    { key: "testCommand", message: "Provide a non-empty 'testCommand' for run_tests." },
    { key: "documentationType", message: "Provide 'documentationType' for create_documentation." },
    { key: "documentationSummary", message: "Provide a non-empty 'documentationSummary'." },
    { key: "commitMessage", message: "Provide a non-empty 'commitMessage'." },
    { key: "releaseCommand", message: "Provide a non-empty 'releaseCommand'." },
  ];

  for (const { key, message } of requiredStrings) {
    const value = args[key];
    if (typeof value !== "string" || value.trim() === "") {
      return textResponse(`⚠️ ${message}`);
    }
  }

  // Definition of done diperiksa di DEPAN, bukan setelah tujuh langkah.
  //
  // `start_task` mewajibkan DoD, jadi setiap task baru punya item terbuka. Sejak
  // gerbang DoD ada (1.14.0), `run_full_workflow` tidak punya langkah untuk
  // membuktikan item - jadi ia selalu berhenti di ready check, SETELAH
  // mark_bug_fixed, create_tests, run_tests, dan create_documentation semuanya
  // tercatat padahal commit belum pernah terjadi. Task seperti itu tertinggal
  // setengah jadi dan membingungkan `get_workflow_status`.
  //
  // Lebih baik menolak di awal dengan daftar item yang perlu dibuktikan.
  const dodEvidenceArg = args.dodEvidence;
  const dodEvidence = dodEvidenceArg && typeof dodEvidenceArg === "object" && !Array.isArray(dodEvidenceArg)
    ? dodEvidenceArg
    : {};

  const dodItemsBefore = Array.isArray(workflowState.state.definitionOfDone)
    ? workflowState.state.definitionOfDone
    : [];
  const dodRevisionBefore = Number(workflowState.state.dodRevision) || 0;
  const outstandingBefore = openItems(dodItemsBefore, dodRevisionBefore);

  const missingEvidence = outstandingBefore.filter((item) => {
    const value = dodEvidence[item.id];
    return typeof value !== "string" || value.trim().length < MIN_EVIDENCE;
  });

  if (missingEvidence.length > 0) {
    const list = missingEvidence.map((item) => `   ${item.id}: ${item.text}`).join("\n");
    const example = missingEvidence
      .map((item) => `"${item.id}": "npm test -> 533 pass"`)
      .join(", ");

    return textResponse(
      `⚠️ Dibatalkan sebelum satu langkah pun berjalan: ${missingEvidence.length} item Definition of Done belum terbukti.\n\n` +
        `${list}\n\n` +
        `'run_full_workflow' tidak bisa menebak buktinya. Kirim 'dodEvidence' berisi bukti untuk tiap item, ` +
        `atau buktikan dulu lewat 'mark_dod_item' lalu panggil 'run_full_workflow' lagi.\n\n` +
        `Contoh:\n  "dodEvidence": { ${example} }\n\n` +
        `Bukti minimal ${MIN_EVIDENCE} karakter dan harus menyebut apa yang benar-benar dijalankan atau diperiksa. ` +
        `Item yang memang tidak berlaku kecualikan dengan 'waive_dod_item' { id, reason }.\n\n` +
        `Tidak ada langkah yang dicatat; workflow tidak berubah.`
    );
  }

  const steps = [];
  let dodApplied = false;
  const testsPassed = typeof args.testsPassed === "boolean" ? args.testsPassed : true;

  // Gerbang dokumentasi diperiksa DI DEPAN, bukan setelah tujuh langkah.
  //
  // `start_task` tidak lagi bisa ditutup oleh label `documentationType`. Kalau
  // gerbang baru diperiksa di ready check, `run_full_workflow` akan mencatat
  // mark_bug_fixed, create_tests, run_tests, dan create_documentation lebih dulu,
  // lalu berhenti - task tertinggal setengah jadi. Lebih baik menolak sebelum
  // satu langkah pun berjalan, sama seperti perlakuan `dodEvidence` di atas.
  const waiverReasonArg =
    typeof args.documentationWaiverReason === "string" ? args.documentationWaiverReason.trim() : "";
  const declaredDocsArg = Array.isArray(args.documentationFiles)
    ? args.documentationFiles.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];

  const gateInputs = await loadDocGateInputs({ workflowState, git });
  const gate = evaluateDocGate({
    changedPaths: gateInputs.changedPaths,
    dirtyAtStart: gateInputs.dirtyAtStart,
    declaredFiles: declaredDocsArg.length > 0 ? declaredDocsArg : gateInputs.declaredFiles,
    hasDocumentation: gateInputs.hasDocumentation,
    waived: Boolean(workflowState.state.documentationWaived) || waiverReasonArg !== "",
  });

  if (!isGateSatisfied(gate.status)) {
    let readmeAge = "";
    if (gateInputs.readmePath && typeof git?.getLastCommitForPath === "function") {
      try {
        readmeAge = formatRelativeAge(await git.getLastCommitForPath(gateInputs.readmePath));
      } catch {
        readmeAge = "";
      }
    }

    return textResponse(
      `⚠️ Dibatalkan sebelum satu langkah pun berjalan: dokumentasi belum diperbarui.\n\n` +
        renderDocGateFailure({
          sourceChanged: gate.sourceChanged,
          readmePath: gateInputs.readmePath,
          readmeAge,
          legacy: false,
        }) +
        `\n\nUntuk 'run_full_workflow', kirim salah satu argumen ini:\n` +
        `  "documentationFiles": ["README.md"]        (berkas yang benar-benar berubah)\n` +
        `  "documentationWaiverReason": "..."        (alasan tidak perlu diubah)\n\n` +
        `Tidak ada langkah yang dicatat; workflow tidak berubah.`
    );
  }

  if (waiverReasonArg !== "" && waiverReasonArg.length < MIN_WAIVER_REASON) {
    return textResponse(
      `⚠️ Dibatalkan sebelum satu langkah pun berjalan: 'documentationWaiverReason' minimal ` +
        `${MIN_WAIVER_REASON} karakter; dikirim ${waiverReasonArg.length}.\n\n` +
        `Tulis KENAPA dokumentasi tidak perlu diubah. Alasan ini masuk history.\n\n` +
        `Tidak ada langkah yang dicatat; workflow tidak berubah.`
    );
  }

  const testDetails = typeof args.testDetails === "string" ? args.testDetails : "";
  const releaseArgs = {
    command: args.releaseCommand,
  };
  if (typeof args.releaseNotes === "string" && args.releaseNotes.trim() !== "") {
    releaseArgs.notes = args.releaseNotes;
  }
  if (typeof args.releaseType === "string" && args.releaseType.trim() !== "") {
    releaseArgs.releaseType = args.releaseType;
  }
  if (typeof args.preset === "string" && args.preset.trim() !== "") {
    releaseArgs.preset = args.preset;
  }

  async function executeStep(name, handlerFn, handlerArgs = []) {
    if (isErrorResponse(handlerFn)) {
      return handlerFn;
    }
    const response = await handlerFn(...handlerArgs);
    if (isErrorResponse(response)) {
      return response;
    }
    steps.push(summarizeResponse(name, response));
    await workflowState.load();
    return response;
  }

  while (true) {
    const state = workflowState.state;

    if (!state.bugFixed) {
      const resp = await executeStep("mark_bug_fixed", handleMarkBugFixed, [{ summary: args.summary }, workflowState]);
      if (isErrorResponse(resp)) return resp;
      continue;
    }

    if (!state.featureFlowCreated) {
      if (!args.mermaidCode || !args.featureFlowDescription) {
        return textResponse("⚠️ 'run_full_workflow' now requires 'mermaidCode' and 'featureFlowDescription' to support the Mermaid step.");
      }
      const resp = await executeStep("create_feature_flow", handleCreateFeatureFlow, [{ mermaidCode: args.mermaidCode, description: args.featureFlowDescription }, workflowState]);
      if (isErrorResponse(resp)) return resp;
      continue;
    }

    if (!state.testsCreated) {
      const resp = await executeStep("create_tests", handleCreateTests, [workflowState]);
      if (isErrorResponse(resp)) return resp;
      continue;
    }

    if (!state.testsPassed && !state.testsSkipped) {
      const resp = await executeStep("run_tests", handleRunTests, [
        { passed: testsPassed, testCommand: args.testCommand, details: testDetails },
        workflowState,
      ]);
      if (isErrorResponse(resp)) return resp;
      continue;
    }

    if (!state.documentationCreated) {
      const resp = await executeStep("create_documentation", handleCreateDocumentation, [
        {
          documentationType: args.documentationType,
          summary: args.documentationSummary,
          files: declaredDocsArg,
        },
        workflowState,
        { git },
      ]);
      if (isErrorResponse(resp)) return resp;
      continue;
    }

    if (!state.readyCheckCompleted) {
      // Waiver dokumentasi dicatat di sini, bukan di awal: `waive_documentation`
      // mensyaratkan tes sudah lulus, dan waiver baru bermakna setelah kode yang
      // sebenarnya akan di-commit selesai ditulis. Pola yang sama dengan
      // `dodEvidence` di bawah.
      if (waiverReasonArg !== "" && !state.documentationWaived) {
        const waiveResponse = await handleWaiveDocumentation(
          { reason: waiverReasonArg },
          workflowState,
        );
        if (isErrorResponse(waiveResponse)) return waiveResponse;
        steps.push("waive_documentation: gerbang dokumentasi dikecualikan");
        await workflowState.load();
        continue;
      }

      // Buktikan item DoD dari `dodEvidence` sebelum ready check, sekali saja.
      //
      // Diletakkan di sini, bukan di awal, karena bukti baru benar setelah
      // implementasi dan tes selesai. Kalau dicatat di awal, bukti yang dikirim
      // bersama panggilan ini akan menempel pada kode yang belum ditulis.
      if (!dodApplied) {
        const applied = [];
        for (const item of openItems(state.definitionOfDone || [], Number(state.dodRevision) || 0)) {
          const evidence = dodEvidence[item.id];
          if (typeof evidence !== "string" || evidence.trim() === "") continue;
          const resp = await handleMarkDodItem({ id: item.id, evidence }, workflowState);
          if (isErrorResponse(resp)) return resp;
          applied.push(item.id);
        }
        dodApplied = true;
        if (applied.length > 0) {
          steps.push(`mark_dod_item: ${applied.join(", ")}`);
          await workflowState.load();
          continue;
        }
      }

      const resp = await executeStep("check_ready_to_commit", handleReadyCheck, [workflowState, { git }]);
      if (isErrorResponse(resp)) return resp;
      continue;
    }

    if (!state.commitAndPushCompleted) {
      const resp = await executeStep("commit_and_push", handleCommitAndPush, [
        {
          commitMessage: args.commitMessage,
          branch: requestedBranch,
        },
        { workflowState, exec, git, utils },
      ]);
      if (isErrorResponse(resp)) return resp;
      continue;
    }

    if (!isReleaseSatisfied(state)) {
      const resp = await executeStep("perform_release", handlePerformRelease, [
        releaseArgs,
        { workflowState, exec, git, utils },
      ]);
      if (isErrorResponse(resp)) return resp;
      continue;
    }

    const completeResponse = await handleCompleteTask(
      { commitMessage: args.commitMessage, nextSteps: args.nextSteps },
      workflowState,
      { git },
    );
    if (isErrorResponse(completeResponse)) {
      return completeResponse;
    }
    steps.push(summarizeResponse("complete_task", completeResponse));
    break;
  }

  const summary = steps.map((line, index) => `${index + 1}. ${line}`).join("\n");
  const celebration = workflowState.state.history?.length
    ? "🎉 Cheers! We solved another issue and captured it in the knowledge base."
    : "";
  const message = [`✅ Full workflow completed successfully!`, celebration, summary].filter(Boolean).join("\n\n");
  return textResponse(message);
}

async function dispatchToolCall({
  request,
  normalizeRequestArgs,
  workflowState,
  exec,
  git,
  utils,
  factory,
}) {
  try {
    const { name } = request.params;

    // Identitas sesi datang dari request metadata, bukan dari environment.
    // Tanpa ini, satu proses MCP yang dipakai bergantian oleh beberapa sesi
    // akan berbagi satu state dan saling menimpa task.
    const sessionId = sessionKeyFromRequest(request);
    if (sessionId && workflowState?.useSession) {
      await workflowState.useSession(sessionId);
    }
    const { args, error: argumentsError } = normalizeRequestArgs(request.params.arguments);

    if (argumentsError) {
      return textResponse(argumentsError);
    }

    switch (name) {
      case 'security_audit': {
        const file=workflowState?.stateFile;
        const marker=file?.replaceAll('\\','/').lastIndexOf('/.state/');
        const root=marker>=0 ? file.slice(0,marker) : file ? path.dirname(file) : process.cwd();
        const userId=process.env.DEV_WORKFLOW_USER_ID || (marker>=0?path.basename(path.dirname(file)):'default');
        const report=await securityAudit({root,state:workflowState?.state,stateFile:file,userId});
        return textResponse(JSON.stringify(report));
      }
      case "start_task":
        return handleStartTask(args, workflowState, git);
      case "set_definition_of_done":
        return handleSetDefinitionOfDone(args, workflowState);
      case "set_plan":
        return handleSetPlan(args, workflowState);
      case "mark_plan_step":
        return handleMarkPlanStep(args, workflowState);
      case "mark_dod_item":
        return handleMarkDodItem(args, workflowState);
      case "waive_dod_item":
        return handleWaiveDodItem(args, workflowState);
      case "mark_bug_fixed":
        return handleMarkBugFixed(args, workflowState);
      case "create_feature_flow":
        return handleCreateFeatureFlow(args, workflowState);
      case "create_tests":
        return handleCreateTests(workflowState);
      case "skip_tests":
        return handleSkipTests(args, workflowState);
      case "run_tests":
        return handleRunTests(args, workflowState);
      case "create_documentation":
        return handleCreateDocumentation(args, workflowState, { git });
      case "waive_documentation":
        return handleWaiveDocumentation(args, workflowState);
      case "check_ready_to_commit":
        return handleReadyCheck(workflowState, { git });
      case "commit_and_push":
        return handleCommitAndPush(args, { workflowState, exec, git, utils });
      case "perform_release":
        return handlePerformRelease(args, { workflowState, exec, git, utils });
      case "skip_release":
        return handleSkipRelease(args, workflowState);
      case "complete_task":
        return handleCompleteTask(args, workflowState, { git, factory });
      case "next_steps":
        return handleNextSteps(args, workflowState);
      case "resume_session":
        return handleResumeSession(args, workflowState);
      case "force_complete_task":
        return handleForceCompleteTask(args, workflowState, { factory });
      case "drop_task":
        return handleDropTask(args, workflowState, { factory });
      case "get_workflow_status":
        return handleGetWorkflowStatus(workflowState);
      case "view_history":
        return handleViewHistory(args, workflowState);
      case "project_summary":
        return handleProjectSummary(workflowState);
      case "project_summary_data":
        return handleProjectSummaryData(workflowState);
      case "project_summary_db":
        return handleProjectSummaryDb(workflowState);
      case "continue_workflow":
        return handleContinueWorkflow(workflowState, { workflowState, exec, git, utils });
      case "rerun_workflow":
        return handleRerunWorkflow(workflowState);
      case "run_full_workflow":
        return handleRunFullWorkflow(args, { workflowState, exec, git, utils });
      case "list_factory_tasks":
        return handleListFactoryTasks(args);
      case "list_factory_projects":
        return handleListFactoryProjects(args);
      case "create_factory_task":
        return handleCreateFactoryTask(args);
      case "update_factory_task":
        return handleUpdateFactoryTask(args);
      case "claim_factory_task":
        return handleClaimFactoryTask(args, { workflowState });
      case "sync_task_status":
        return handleSyncTaskStatus(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    safeLog('error', "Tool handler error:", error);
    return textResponse(
      "⚠️ Internal server error while processing the tool request. Please try again."
    );
  }
}

// Await every handler here so asynchronous rejections cannot bypass egress checks.
export async function handleToolCall(context) {
  try {
    const {args,error}=context.normalizeRequestArgs(context.request.params.arguments);
    if(error) return securityOutputFilter(textResponse(error));
    assertSafeKnowledge({tool:context.request.params.name,args});
    assertSafeToolCommand(context.request.params.name,args);
    if (context.workflowState) context.workflowState.lastConflict = null;
    const response=await dispatchToolCall({...context,request:{...context.request,params:{...context.request.params,arguments:args}}});
    return securityOutputFilter(withPlanProgress(withConflictNotice(response, context.workflowState), context.workflowState));
  } catch(error) {
    if(['SECRET_CONTENT_DENIED','UNSAFE_COMMAND_DENIED'].includes(error.code)) {
      return {isError:true,content:[{type:'text',text:JSON.stringify({error:error.code,message:error.message,findings:error.findings})}]};
    }
    safeLog('error','Tool request failed',error);
    return {isError:true,content:[{type:'text',text:'⚠️ Internal server error while processing the tool request.'}]};
  }
}

/**
 * Tempelkan peringatan bila penyimpanan terakhir kalah dari proses lain.
 *
 * Tanpa ini, tool menjawab "berhasil" untuk state yang sebenarnya tidak
 * tersimpan. Kejadian 29 Okt 2026: `start_task` menjawab "✅ Task Started",
 * tetapi `get_workflow_status` berikutnya menampilkan task lain.
 */
function withPlanProgress(response, workflowState) {
  const plan = workflowState?.state?.plan;
  if (!Array.isArray(plan) || plan.length === 0) {
    return response;
  }

  const text = response?.content?.[0]?.text;
  if (typeof text !== "string") {
    return response;
  }

  const footer = renderPlanShort(plan);
  if (!footer) {
    return response;
  }

  // Ditempel di AKHIR, bukan di awal: `isErrorResponse` menilai dari awalan,
  // dan jawaban sukses tetap harus terbaca sebagai sukses.
  return {
    ...response,
    content: [{ ...response.content[0], text: `${text}\n\n${footer}` }, ...response.content.slice(1)],
  };
}

function withConflictNotice(response, workflowState) {
  const conflict = workflowState?.lastConflict;
  if (!conflict) {
    return response;
  }
  const text = response?.content?.[0]?.text;
  if (typeof text !== "string") {
    return response;
  }
  // Peringatan ditaruh DI DEPAN, dan menyebut terus terang bahwa aksi tadi
  // tidak berlaku. Menempelkan "✅ berhasil" di atas peringatan membuat agen
  // membaca baris pertama lalu melanjutkan seolah semuanya tersimpan.
  const notice =
    `⚠️ AKSI TIDAK BERLAKU - proses MCP lain memulai task yang lebih baru.\n` +
    `   Task di disk : "${conflict.diskTask}"\n` +
    `   Task Anda    : "${conflict.staleTask || '(kosong)'}"\n` +
    `   State Anda sudah dimuat ulang dari disk, jadi langkah berikutnya mengikuti task di disk.\n` +
    `   Jalankan ulang aksi ini bila memang untuk task tersebut, atau 'start_task' untuk menggantinya.\n\n` +
    `--- pesan asli tool (TIDAK tersimpan) ---\n`;
  return {
    ...response,
    content: [{ ...response.content[0], text: notice + text }, ...response.content.slice(1)],
  };
}
