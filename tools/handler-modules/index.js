/**
 * @zettly-code DWF-TOOL-PROFILES-015
 * @purpose Refuse a tools/call for a tool the active profile hides, using the profile data instead of a second hand-written tool list.
 */
/**
 * @zettly-code DWF-TOOL-DISPATCH-001
 * @purpose Central MCP tool dispatcher and post-call Zettly Todo / Draw / Sentry synchronization wrapper.
 * @invariant Route all 66 canonical MCP tools deterministically, pass integrationOptions to complete_task for automatic Sentry issue resolution, and sanitize all outputs.
 */
import { textResponse, isReleaseSatisfied, isErrorResponse, loadDocGateInputs } from "./shared.js";
import { evaluateDocGate, isGateSatisfied, formatRelativeAge, renderDocGateFailure, MIN_WAIVER_REASON } from "./docs.js";
import { assertSafeKnowledge } from '../../security/policy.js';
import { safeLog, securityOutputFilter } from '../../security/sanitizer.js';
import { withEnglishGuidance } from '../../workflow-guidance.js';
import { getAllToolDefinitions } from '../definitions.js';
import { isToolAllowedInProfile, unavailabilityMessage, getToolProfile } from '../../src/tool-profiles.js';
import { formatTokenRange, getSessionUsage, profileTokenReport, recordToolResponse } from '../../src/token-meter.js';
import { syncZettlyTask, flushZettlyOutbox } from '../../zettly-workflow.js';
import { securityAudit } from '../../security/audit.js';
import { auditSite } from '../../audit/site-audit.js';
import path from 'node:path';
import { assertSafeToolCommand } from '../../security/commands.js';
import { sessionKeyFromRequest } from "../../workflow-state.js";
import { handleStartTask, handleMarkBugFixed, handleCreateTests, handleSkipTests, handleRunTests, handleCreateDocumentation, handleCreateFeatureFlow, handleWaiveDocumentation, handleRecommendMcpTools, handleReportBuildStatus } from "./workflow-handlers.js";
import { handleSkipRelease, handlePerformRelease, handleRecordDeployment, handleAcquireReleaseLock, handleReleaseReleaseLock } from "./release-handlers.js";
import { handleCommitAndPush, handleCompleteTask, handleForceCompleteTask, handleDropTask } from "./commit-handlers.js";
import { handleProjectSummary, handleViewHistory } from "./summary-handlers.js";
import { handleGetWorkflowStatus, handleReadyCheck, handleContinueWorkflow, handleRerunWorkflow, handleListActiveSessions, handleBuildReport, handleBuildEstimate } from "./status-handlers.js";
import { handleSetDefinitionOfDone, handleMarkDodItem, handleWaiveDodItem } from "./dod-handlers.js";
import { handleNextSteps } from "./next-steps-handlers.js";
import { handleResumeSession } from "./resume-handlers.js";
import { handleAcknowledgeInstructions } from "./preflight-handlers.js";
import { handleSetPlan, handleMarkPlanStep } from "./workflow-handlers.js";
import { handleRestartHandshake } from "./restart-handshake-handlers.js";
import { handleCheckpointTask, handleHandoffTask, handleAcknowledgeHandover } from "./checkpoint-handlers.js";
import { handleTakeOverTask } from "./takeover-handlers.js";
import { handleFetchTask } from "./remote-checkpoint.js";
import { renderPlanShort } from "./plan.js";
import { openItems, MIN_EVIDENCE } from "./dod.js";
import { handleSearchProject } from "./search-handlers.js";
import {handleIntegrationTool,prepareTaskSource,checkSentryPreemption} from './integration-handlers.js';
import {handleRefineWithAi} from './refine-with-ai.js';
import {handleFocusTool,prepareTaskFocus} from '../../focus-workflow.js';
import {syncZettlyDrawing} from '../../zettly-drawing.js';
import {DEVWORKFLOW_V2_TOOL_NAMES,handleDevWorkflowV2Tool} from '../../src/engineering-audit.js';

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

    if (!state.featureFlowCreated) {
      if (!args.mermaidCode || !args.featureFlowDescription) {
        return textResponse("⚠️ 'run_full_workflow' now requires 'mermaidCode' and 'featureFlowDescription' to support the Mermaid step.");
      }
      const resp = await executeStep("create_feature_flow", handleCreateFeatureFlow, [{ mermaidCode: args.mermaidCode, description: args.featureFlowDescription }, workflowState]);
      if (isErrorResponse(resp)) return resp;
      continue;
    }

    if (!state.bugFixed) {
      const resp = await executeStep("mark_bug_fixed", handleMarkBugFixed, [{ summary: args.summary }, workflowState]);
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
  zettlyOptions,
  integrationOptions,
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
      case 'get_current_focus':
      case 'set_focus':
      case 'link_task_to_focus':
      case 'complete_focus':
        return handleFocusTool(name,args,workflowState,{...integrationOptions,client:zettlyOptions?.client||integrationOptions?.zettly,env:zettlyOptions?.env||integrationOptions?.env||process.env});
      case 'get_integration_status':
      case 'list_sentry_issues':
      case 'inventory_sentry_issues':
      case 'get_zettly_task_context':
      case 'get_sentry_issue':
      case 'set_sentry_issue_status':
      case 'link_sentry_issue':
        return handleIntegrationTool(name,args,workflowState,integrationOptions);
      case 'sync_zettly_task': {
        const pending = await flushZettlyOutbox(workflowState,{...zettlyOptions,force:true});
        const active = await syncZettlyTask(workflowState,{...zettlyOptions,force:true,todoId:args.todoId});
        const note=[pending.note,active.note].filter(Boolean).join('\n')||'No active Zettly task or pending outcome.';
        return textResponse(`${pending.ok&&active.ok?'✅':'⚠️'} ${note}`);
      }
      case 'search_project':
        return handleSearchProject(args, workflowState);
      case 'security_audit': {
        const file=workflowState?.stateFile;
        const marker=file?.replaceAll('\\','/').lastIndexOf('/.state/');
        const root=marker>=0 ? file.slice(0,marker) : file ? path.dirname(file) : process.cwd();
        const userId=process.env.DEV_WORKFLOW_USER_ID || (marker>=0?path.basename(path.dirname(file)):'default');
        const report=await securityAudit({root,state:workflowState?.state,stateFile:file,userId});
        return textResponse(JSON.stringify(report));
      }
      case 'site_audit': {
        const report=await auditSite({
          url:args.url,
          checks:args.checks,
          maxPages:args.maxPages,
          timeoutMs:args.timeoutMs,
          includeExternal:args.includeExternal,
          parityPrefix:args.parityPrefix,
        });
        return textResponse(JSON.stringify(report));
      }
      case "start_task": {
        const legacyPreemptionOverride=args.allowErpPreemptionOverride===true;
        const preemption=await checkSentryPreemption({projectDir:args.projectDir||workflowState?.state?.projectDir||'',allowPreemptionOverride:Boolean(args.allowPreemptionOverride),legacyOverride:legacyPreemptionOverride,mode:'start_task',options:integrationOptions});
        if(preemption.response){
          if(preemption.deprecationWarning&&preemption.response?.content?.[0]?.text){
            preemption.response.content[0].text += `\n\n⚠️ ${preemption.deprecationWarning}`;
          }
          return preemption.response;
        }
        const prepared=await prepareTaskSource(args,integrationOptions);
        if(prepared.response)return prepared.response;
        const focused=await prepareTaskFocus(prepared.args,{...integrationOptions,client:zettlyOptions?.client||integrationOptions?.zettly,env:zettlyOptions?.env||integrationOptions?.env||process.env});
        if(focused.response)return focused.response;
        const started=await handleStartTask(focused.args, workflowState, git, zettlyOptions);
        if(preemption.deprecationWarning&&started?.content?.[0]?.text){
          started.content[0].text += `\n\n⚠️ ${preemption.deprecationWarning}`;
        }
        return started;
      }
      case "refine_with_ai":
        return handleRefineWithAi(args, workflowState);
      case 'link_zettly_drawing':
        return handleIntegrationTool('link_zettly_drawing',args,workflowState,integrationOptions);
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
      case "acknowledge_instructions":
        return handleAcknowledgeInstructions(args, workflowState);
      case "create_feature_flow":
        return handleCreateFeatureFlow(args, workflowState, zettlyOptions);
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
      case "record_deployment":
        return handleRecordDeployment(args, { workflowState, exec, git, utils });
      case "acquire_release_lock":
        return handleAcquireReleaseLock(args, { workflowState });
      case "release_release_lock":
        return handleReleaseReleaseLock(args, { workflowState });
      case "skip_release":
        return handleSkipRelease(args, workflowState);
      case "complete_task":
        return handleCompleteTask(args, workflowState, { git, zettlyOptions, integrationOptions });
      case "next_steps":
        return handleNextSteps(args, workflowState);
      case "resume_session":
        return handleResumeSession(args, workflowState);
      case "restart_handshake":
        return textResponse(JSON.stringify(await handleRestartHandshake(args, workflowState)));
      case "checkpoint_task":
        return textResponse(
          JSON.stringify(
            await handleCheckpointTask(args, {
              workflowState,
              client: zettlyOptions?.client || integrationOptions?.zettly,
              env: zettlyOptions?.env || integrationOptions?.env || process.env,
            })
          )
        );
      case "handoff_task":
        return textResponse(
          JSON.stringify(
            await handleHandoffTask(args, {
              workflowState,
              client: zettlyOptions?.client || integrationOptions?.zettly,
              env: zettlyOptions?.env || integrationOptions?.env || process.env,
            })
          )
        );
      case "acknowledge_handover":
        return textResponse(
          JSON.stringify(
            await handleAcknowledgeHandover(args, {
              workflowState,
              client: zettlyOptions?.client || integrationOptions?.zettly,
              env: zettlyOptions?.env || integrationOptions?.env || process.env,
            })
          )
        );
      case "take_over_task":
        return handleTakeOverTask(args, workflowState);
      case "fetch_task":
        return textResponse(
          JSON.stringify(
            await handleFetchTask(args, {
              workflowState,
              client: zettlyOptions?.client || integrationOptions?.zettly,
              env: zettlyOptions?.env || integrationOptions?.env || process.env,
              machineAliases: integrationOptions?.machineAliases || {},
              nodePath: integrationOptions?.remoteNodePath,
              scriptPath: integrationOptions?.remoteScriptPath,
            })
          )
        );
      case "force_complete_task":
        return await handleForceCompleteTask(args, workflowState, { zettlyOptions });
      case "drop_task":
        return await handleDropTask(args, workflowState, { zettlyOptions });
      case "get_workflow_status":
        return handleGetWorkflowStatus(workflowState);
      case "view_history":
        return handleViewHistory(args, workflowState);
      case "project_summary":
        return handleProjectSummary(workflowState, args);
      case "list_active_sessions":
        return await handleListActiveSessions(args, { workflowState });
      case "build_report":
        return await handleBuildReport(args, { workflowState });
      case "build_estimate":
        return await handleBuildEstimate(args, { workflowState });
      case "continue_workflow":
        return handleContinueWorkflow(workflowState, { workflowState, exec, git, utils });
      case "rerun_workflow":
        return handleRerunWorkflow(workflowState);
      case "run_full_workflow":
        return handleRunFullWorkflow(args, { workflowState, exec, git, utils });
      case "recommend_mcp_tools":
        return handleRecommendMcpTools(args, workflowState);
      case "report_build_status":
        return handleReportBuildStatus(args, workflowState);
      default:
        if (DEVWORKFLOW_V2_TOOL_NAMES.has(name)) {
          const result = await handleDevWorkflowV2Tool(name, args, workflowState);
          return textResponse(JSON.stringify(result, null, 2));
        }
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    safeLog('error', "Tool handler error:", error);
    return textResponse(
      "⚠️ Internal server error while processing the tool request. Please try again."
    );
  }
}

// The canonical catalog is static, so the name set is computed once instead of
// rebuilding 66 schemas on every tool call.
let registeredToolNames = null;
function isRegisteredToolName(name) {
  if (!registeredToolNames) {
    registeredToolNames = new Set(getAllToolDefinitions().map((tool) => tool.name));
  }
  return registeredToolNames.has(name);
}

// Await every handler here so asynchronous rejections cannot bypass egress checks.
export async function handleToolCall(context) {
  try {
    const {args,error}=context.normalizeRequestArgs(context.request.params.arguments);
    if(error) return securityOutputFilter(textResponse(error));
    const requestedTool=context.request.params.name;
    // A tool hidden by the active profile must be unreachable, not merely
    // unlisted: an MCP client that cached an older tools/list would otherwise
    // keep calling a tool this session never advertised. Unknown names still fall
    // through to the dispatcher so its existing error message is unchanged.
    if(!isToolAllowedInProfile(requestedTool)&&isRegisteredToolName(requestedTool)){
      return securityOutputFilter(textResponse(unavailabilityMessage(requestedTool)));
    }
    assertSafeKnowledge({tool:context.request.params.name,args});
    assertSafeToolCommand(context.request.params.name,args);
    if (context.workflowState) context.workflowState.lastConflict = null;
    let response=await dispatchToolCall({...context,request:{...context.request,params:{...context.request.params,arguments:args}}});
    const name=context.request.params.name;


    // While the Zettly drawing is missing, every reply carries the reminder.
    // An agent that never sees this works through the whole task with a plan the
    // monitor cannot show, which is exactly how the flow went missing before.
    // Refusals count too: a "⚠️ create the flow first" reply is precisely the
    // moment the agent must be told how to fix it, so do not filter on the glyph.
    if (context.workflowState && !response?.isError) {
      const st = context.workflowState.state || {};
      const drawingId = st.zettly?.externalLinks?.drawing?.id;
      const skip = new Set(['create_feature_flow','get_workflow_status','get_current_focus','get_integration_status','start_task']);
      if (st.currentPhase && st.currentPhase !== 'idle' && !drawingId && !skip.has(name)) {
        const text = response?.content?.[0]?.text;
        // Machine-readable payloads must stay parseable; the reminder would
        // corrupt JSON that callers parse directly.
        if (typeof text === 'string' && !/^\s*[[{]/.test(text)) {
          response.content[0].text = text +
            "\n\n⚠️ FLOW BELUM ADA DI MONITOR: drawing Zettly belum dibuat. " +
            "Jalankan 'create_feature_flow' { mermaidCode, description } sekarang supaya konteksnya lengkap.";
        }
      }
    }
    const syncTools=new Set(['start_task','refine_with_ai','set_plan','mark_plan_step','set_definition_of_done','mark_dod_item','waive_dod_item','mark_bug_fixed','create_tests','skip_tests','run_tests','create_documentation','waive_documentation','check_ready_to_commit','commit_and_push','perform_release','record_deployment','acquire_release_lock','release_release_lock','skip_release','get_workflow_status','continue_workflow','resume_session','link_sentry_issue','report_build_status','build_report','build_estimate']);

    syncTools.add('link_zettly_drawing');
    // checkpoint_task already forces its own write; the post-dispatch sync is a
    // cheap retry when that write landed in a pending state (Zettly was down).
    syncTools.add('checkpoint_task');
    syncTools.add('handoff_task');
    syncTools.add('acknowledge_handover');
    syncTools.add('fetch_task');
    if(context.workflowState&&!response?.isError&&!isErrorResponse(response)&&!context.workflowState.lastConflict&&syncTools.has(name)){
      const notes=[];
      if(name==='get_workflow_status'&&context.workflowState.state.zettlyOutbox?.length){const result=await flushZettlyOutbox(context.workflowState,context.zettlyOptions);if(result.note)notes.push(result.note);}
      const result=await syncZettlyTask(context.workflowState,context.zettlyOptions);if(result.note)notes.push(result.note);
      if(result.ok&&name==='start_task'&&context.workflowState.state.focus?.id){
        const options={...context.integrationOptions,client:context.zettlyOptions?.client||context.integrationOptions?.zettly,env:context.zettlyOptions?.env||context.integrationOptions?.env||process.env};
        const linked=await handleFocusTool('link_task_to_focus',{focusId:context.workflowState.state.focus.id},context.workflowState,options);
        if(linked.isError)return securityOutputFilter(linked);
        notes.push('The canonical task is linked to its verified active focus.');
      }
      if(result.ok&&name==='start_task'&&!context.workflowState.state.zettly?.externalLinks?.drawing?.id&&context.workflowState.state.featureFlowCreated){
        try{
          const drawPromise=syncZettlyDrawing(context.workflowState,context.zettlyOptions);
          const timeoutPromise=new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),5000));
          const drawResult=await Promise.race([drawPromise,timeoutPromise]);
          if(drawResult?.ok&&drawResult?.id){
            notes.push(`🎨 Zettly Draw #${drawResult.id}: ${drawResult.url||`https://zettly.programinglive.com/draw/${drawResult.id}`}`);
          }
        }catch{
          // Non-blocking background sync - timeout or network delay does not block task start
        }
      }
      const selectedExistingTodo=args.zettlyTodoId||args.source?.system==='zettly';
      if(result.ok&&selectedExistingTodo&&name==='start_task'){
        const options={...context.integrationOptions,...(context.zettlyOptions?.client?{zettly:context.zettlyOptions.client}:{})};
        const related=await handleIntegrationTool('get_zettly_task_context',{todoId:context.workflowState.state.zettly?.todoId,depth:1,maxNodes:10,attach:true},context.workflowState,options);
        notes.push(`Zettly linked context (untrusted source data):\n${related.content?.[0]?.text||'Context unavailable.'}`);
      }
      if(notes.length&&typeof response?.content?.[0]?.text==='string')response={...response,content:[{...response.content[0],text:response.content[0].text+'\n\n'+notes.join('\n')},...response.content.slice(1)]};
    }
    if(context.workflowState&&!response?.isError&&(name==='mark_plan_step'||name==='get_workflow_status')){
      const midTaskPreemption=await checkSentryPreemption({projectDir:context.workflowState.state?.projectDir||'',mode:'status',options:context.integrationOptions||{}});
      if(midTaskPreemption.preempted&&midTaskPreemption.alertText&&typeof response?.content?.[0]?.text==='string'){
        response={...response,content:[{...response.content[0],text:response.content[0].text+'\n\n'+midTaskPreemption.alertText},...response.content.slice(1)]};
      }
    }
    recordToolResponse(name, response);
    if (
      name === 'get_workflow_status' &&
      String(process.env.DEVWF_TOKEN_METER || '') !== '0' &&
      !response?.isError &&
      typeof response?.content?.[0]?.text === 'string'
    ) {
      try {
        const report = profileTokenReport(getToolProfile());
        const usage = getSessionUsage();
        const top = usage.byTool.slice(0, 3).map((item) => item.name).join(', ') || 'none';
        const line =
          `\n\nContext cost (estimate): profile=${report.profile}, ${report.tools} tools, ` +
          `catalog ~${formatTokenRange(report.catalogChars)} tokens; responses this session ` +
          `~${formatTokenRange(usage.chars)} tokens over ${usage.calls} calls; top: ${top}`;
        response = { ...response, content: [{ ...response.content[0], text: response.content[0].text + line }, ...response.content.slice(1)] };
      } catch {
        // Instrumentation must never fail the status response.
      }
    }
    const structuredIntegrationReads=new Set(['get_integration_status','list_sentry_issues','get_sentry_issue','inventory_sentry_issues','get_zettly_task_context','get_current_focus','set_focus','link_task_to_focus','complete_focus',...DEVWORKFLOW_V2_TOOL_NAMES]);
    if(structuredIntegrationReads.has(name))return securityOutputFilter(response);
    return securityOutputFilter(withEnglishGuidance(withPlanProgress(withConflictNotice(response, context.workflowState), context.workflowState),name));
  } catch(error) {
    if(['SECRET_CONTENT_DENIED','UNSAFE_COMMAND_DENIED'].includes(error.code)) {
      return {isError:true,content:[{type:'text',text:JSON.stringify({error:error.code,message:error.message,findings:error.findings})}]};
    }
    // Dua kegagalan penyimpanan state, dibedakan supaya agen tahu apa yang
    // harus dilakukan. "Internal server error" membuat konflik yang jelas
    // terlihat seperti bug sementara, dan agen mencoba lagi berkali-kali.
    if(error?.code==='STATE_CONFLICT') {
      return {isError:true,content:[{type:'text',text:
        `⚠️ State sesi "${error.sessionKey}" sudah ditulis proses lain ` +
        `(tersimpan versi ${error.actualVersion ?? '?'}, kita memegang ${error.expectedVersion ?? '?'}).\n\n` +
        `Tidak ada yang ditimpa. Jalankan 'get_workflow_status' untuk memuat ulang state, ` +
        `lalu ulangi langkah terakhir.`}]};
    }
    if(error?.code==='STATE_UNAVAILABLE') {
      return {isError:true,content:[{type:'text',text:
        `⚠️ Penyimpanan state tidak bisa dipakai: ${error.message}\n\n` +
        `Workflow TIDAK dilanjutkan, karena menulis ke tempat lain akan membuat pekerjaan ` +
        `ini tidak bisa ditemukan lagi. Perbaiki penyebabnya (ruang disk, izin, atau berkas ` +
        `rusak) sebelum mengulang.`}]};
    }
    if(error?.code==='PROJECT_OWNERSHIP_LOST'||error?.name==='ProjectOwnershipLostError') {
      return {isError:true,content:[{type:'text',text:
        `⚠️ Project/worktree ownership lost: ${error.message}\n\n` +
        `If the temporary worktree was already removed, ` +
        (isToolAllowedInProfile("force_complete_task")
          ? `use 'force_complete_task' or 'drop_task' to reset the session.`
          : `use 'drop_task' to reset the session.`)}]};
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
