#!/usr/bin/env node

/**
 * @zettly-code DWF-TOOL-PROFILES-003
 * @purpose Serve profile-filtered tool instructions so a core session never receives guidance for tools its own tools/list hides.
 */

import "dotenv/config";
import { safeLog, sanitize, securityOutputFilter } from './security/sanitizer.js';
import { securityMode } from './security/policy.js';

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import path from "path";
import { existsSync } from "node:fs";
import {
  acquireWorktreeMutex,
  writeKernelLockMetadata,
  releaseWorktreeMutex,
  releaseAllWorktreeMutexesSync,
  findActiveLegacyWriter,
  verifyLegacyFleetQuiescence,
  projectLockDir,
  readTakeoverRequest,
  clearTakeoverRequest,
  HEARTBEAT_MS,
} from "./process-lock.js";
import { exec, setActiveProjectDir, resolveProjectDir } from "./exec.js";
import { normalizeRequestArgs, shellEscape } from "./utils.js";
import { createGitFacade } from "./git-facade.js";
import {
  createCommitMessageParts,
  determineReleaseTypeFromCommit,
} from "./commit-helpers.js";
import { WorkflowState, sessionKeyFromRequest, reportToMonitorSafe, resolveStateFile, resolveHistoryFile } from "./workflow-state.js";
import { resolveRequestSession } from "./session-scope.js";
import { getToolList } from "./tools/definitions.js";
import { buildWorkflowInstructions, ENGLISH_IMPLEMENTATION_RULE } from './workflow-guidance.js';
import { getToolProfile } from './src/tool-profiles.js';
import { handleToolCall } from "./tools/handlers.js";
import { handleDropTask } from "./tools/handler-modules/commit-handlers.js";
import { setToolchain } from "./monitor.js";
import { toolchainOnce, createToolchainProbe } from "./toolchain.js";

export { createCommitMessageParts, determineReleaseTypeFromCommit } from "./commit-helpers.js";
export { containsTestFilesInStatus, workingTreeSummary } from "./git-helpers.js";
export { createGitFacade } from "./git-facade.js";
export { WorkflowState } from "./workflow-state.js";

export let workflowState = null;
let lastToolInvocationTimestamp = Date.now();

const __filename = fileURLToPath(import.meta.url);

// Create MCP server
export const server = new Server(
  {
    name: "@programinglive/dev-workflow",
    version: "3.1.5",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
    instructions: buildWorkflowInstructions(getToolProfile()),
  }
);

// Define tools
const trustedToolCatalog = { tools: getToolList() };
const trustedToolCatalogJson = JSON.stringify(trustedToolCatalog);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getToolList(),
}));

// Serialize request handling. The workflow state is a process-global object,
// so two interleaved requests could switch sessions between `useSession()` and
// `handleToolCall()`. A promise chain keeps one request's session selection and
// its handler atomic without changing the public tool contract.
let requestQueue = Promise.resolve();
function withRequestLock(fn) {
  const run = requestQueue.then(fn, fn);
  requestQueue = run.then(() => undefined, () => undefined);
  return run;
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    lastToolInvocationTimestamp = Date.now();
    // Fail closed: a session-scoped tool without a verified session identity
    // must not reuse the previous request's session.
    const gate = resolveRequestSession(request);
    if (!gate.ok) {
      return { isError: true, content: [{ type: "text", text: gate.error }] };
    }

    const runToolRequest = async () => {
      // Reload state from disk before each request to ensure consistency.
      // Only a request with a verified session may switch the state file.
      // A non-session tool keeps the current file only to read project context;
      // it never switches sessions and never mutates task state.
      if (workflowState) {
        if (gate.sessionId) {
          await workflowState.useSession(gate.sessionId);
        }
        await workflowState.load({ skipWrites: true });
        // Project repo follows the active session rather than a single global value.
        // Without this, a session working in another repo would still run git in WORKFLOW_PROJECT_DIR.
        setActiveProjectDir(workflowState.state.projectDir || "");
      }
      return securityOutputFilter(await handleToolCall({
        request,
        normalizeRequestArgs,
        workflowState,
        exec,
        git: createGitFacade(),
        utils: { shellEscape, determineReleaseTypeFromCommit, createCommitMessageParts },
      }));
    };
    return await withRequestLock(async () => {
      if (workflowState && typeof workflowState.runSerialized === "function") {
        return await workflowState.runSerialized(runToolRequest);
      }
      return await runToolRequest();
    });
  } catch(error) {
    safeLog('error','MCP request failed',error);
    return {isError:true,content:[{type:'text',text:'Request failed; inspect sanitized server diagnostics.'}]};
  }
});

// Helper function
export function getNextStep(status) {
  if (!status.featureFlowCreated) return "Describe feature flow with Mermaid";
  if (!status.bugFixed) return "Mark feature/bug as fixed";
  if (!status.testsCreated) return "Create tests";
  if (!status.testsPassed) return "Run tests";
  if (!status.documentationCreated) return "Create documentation";
  if (!status.readyCheckCompleted) return "Run 'check_ready_to_commit'";
  if (!status.commitAndPushCompleted) return "Run 'commit_and_push'";
  if (!status.released) return "Run 'perform_release'";
  return "Complete the task";
}

// Define prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "workflow_reminder",
        description: "Get a reminder of the complete development workflow",
      },
      {
        name: "pre_commit_checklist",
        description: "Pre-commit checklist to ensure nothing is missed",
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === "workflow_reminder") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${ENGLISH_IMPLEMENTATION_RULE}\n\nDevelopment Workflow Discipline:

1. 🎯 START CONSCIOUS
   - Use 'start_task' to declare what you're coding
   - Be clear about your intention

2. 🌀 DESIGN FLOW
   - Describe your feature flow using Mermaid
   - Use 'create_feature_flow' to record it

3. 🔨 CODE WITH PURPOSE
   - After fixing/implementing, create tests
   - Use 'mark_bug_fixed' when done

4. ✅ TESTS MUST PASS
   - Run your tests with 'run_tests'
   - If tests fail: FIX THEM, never skip!
   - Only proceed when all tests are GREEN

5. 📝 DOCUMENT YOUR WORK
   - Update README, comments, or docs
   - Use 'create_documentation' when done

6. 🚀 COMMIT & PUSH
   - Use 'check_ready_to_commit' to verify
   - Use 'commit_and_push' (stages, commits, and pushes)
   - Then use 'perform_release' to handle versioning and tags
   - Use 'complete_task' to finish

Remember: No shortcuts! Each step is important for code quality.`,
          },
        },
      ],
    };
  }

  if (name === "pre_commit_checklist") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Pre-Commit Checklist:

Before you commit and push, verify:

□ Feature/bug is fully implemented
□ Tests are created for the changes
□ All tests pass (GREEN) - run 'run_tests'
□ Documentation is updated
□ Code is clean (no console.logs, unused imports)
□ No TypeScript 'any' types
□ Followed project coding standards

Use 'check_ready_to_commit' to verify workflow completion.

🚫 NEVER commit if tests are failing!
✅ Only commit when everything is green!`,
          },
        },
      ],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
});

// Start server
/**
 * The shared state root that contains `projects/` and `sessions/`.
 *
 * `projectLockDir()` returns `<state>/projects/<projectKey>`, so only that
 * exact shape identifies the root. A looser "any ancestor named projects" rule
 * would resolve a checkout that happens to live under `D:\projects\...` to
 * the drive root and scan the wrong tree.
 */
function sharedStateRoot(lockDir) {
  const parent = path.dirname(path.resolve(lockDir));
  return path.basename(parent) === "projects" ? path.dirname(parent) : null;
}

/**
 * Refresh advisory lock metadata for a capability this process holds.
 *
 * A worktree can disappear while the MCP process keeps serving: an operator
 * deletes it, a cleanup job removes it, or a disk is unmounted.
 * `writeKernelLockMetadata` fails closed in that case with
 * PROJECT_OWNERSHIP_LOST, and an exception escaping the heartbeat interval
 * would terminate the whole MCP server and drop every tool. Ownership loss is
 * recoverable for a background refresh: log it, unbind the stale capability,
 * release its OS mutex, and keep serving. Every other error still propagates
 * so genuine defects stay visible instead of being misread as recovery.
 */
export async function refreshWorktreeLockMetadata(
  state,
  capability,
  { operation = "heartbeat", writeMetadata = writeKernelLockMetadata, dir = null, expectedOwnerKey = null } = {},
) {
  if (!state || !capability) return { ok: false, skipped: true };
  try {
    const result = writeMetadata({
      dir: dir || projectLockDir(state.stateFile),
      capability,
      projectDir: capability.worktreeRoot,
      ...(expectedOwnerKey ? { expectedOwnerKey } : {}),
    });
    return { ok: true, wrote: result?.wrote === true, result };
  } catch (error) {
    if (error?.code !== "PROJECT_OWNERSHIP_LOST") throw error;
    const reason = error?.details?.reason || "project_ownership_lost";
    const worktree = capability.worktreeRoot || error?.details?.capabilityWorktree || "";
    safeLog(
      "error",
      `Warning: worktree ownership lost during ${operation} (${reason}) for ${worktree}. ` +
        `Releasing the stale capability and continuing without it.`,
    );
    state.bindKernelCapability(null);
    try {
      await releaseWorktreeMutex(capability);
    } catch (releaseError) {
      safeLog(
        "error",
        `Warning: failed to release the stale worktree mutex: ${releaseError?.message || releaseError}`,
      );
    }
    return { ok: false, recovered: true, reason, worktree };
  }
}

/**
 * One heartbeat tick. Exported so the interval wiring stays a two-line
 * adapter and the recovery path is directly testable without waiting 200s.
 */
export async function runWorktreeHeartbeatTick(state, options = {}) {
  const capability = state?.boundKernelCapability;
  if (!capability || !capability.active) return { ok: false, skipped: true };
  const result = refreshWorktreeLockMetadata(state, capability, { operation: "heartbeat", ...options });

  // Cooperative takeover: a live process cannot have its kernel mutex stolen
  // from outside. The holder ends its own task through the normal terminal
  // path, which closes its Zettly Todo and releases the mutex.
  try {
    const dir = projectLockDir(state.stateFile);
    const request = readTakeoverRequest({ dir });
    if (
      request &&
      request.ownerPid === process.pid &&
      state.state?.taskDescription &&
      state.state.currentPhase !== "idle" &&
      !takeoverInProgress
    ) {
      takeoverInProgress = true;
      void handleDropTask(
        {
          reason:
            `cooperative takeover requested by PID ${request.requesterPid}: ${request.reason}`,
        },
        state,
        {},
      )
        .catch((error) =>
          safeLog("error", `cooperative takeover failed: ${error?.message || error}`),
        )
        .finally(() => {
          clearTakeoverRequest({ dir });
          takeoverInProgress = false;
        });
    }
  } catch {
    // A failed takeover check must never take the heartbeat down.
  }
  return result;
}
let takeoverInProgress = false;

export async function initStartupWorktreeMutex(state, { heartbeat = false } = {}) {
  state.requireKernelMutex = true;
  const lockDir = projectLockDir(state.stateFile);
  let startupProjectDir = state.state?.projectDir || "";
  if (!startupProjectDir) {
    try {
      startupProjectDir = resolveProjectDir({
        env: process.env,
        candidates: [process.cwd(), process.env.INIT_CWD],
      }).dir;
    } catch {
      startupProjectDir = "";
    }
  }
  if (startupProjectDir) {
    // Fail closed before any capability is bound. A live legacy writer, an
    // abandoned gate, a pending transition journal, or an unreadable metadata
    // directory means the fleet is not quiescent, and binding a kernel
    // capability on top of that would create two owners of one worktree.
    // `projectLockDir()` returns `<state>/projects/<projectKey>`, so the
    // shared state root is two levels up. Passing a bucket's parent would make
    // the scan miss sibling project locks and the shared `sessions/` directory.
    const stateBase = sharedStateRoot(lockDir);
    const quiescence = verifyLegacyFleetQuiescence({
      baseDir: stateBase && existsSync(stateBase) ? stateBase : null,
      dirs: [lockDir],
    });
    if (!quiescence.quiescent) {
      const legacyPids = (quiescence.legacyWriters || []).map((writer) => writer.pid).filter(Boolean);
      safeLog(
        'error',
        `Refusing to bind the worktree mutex: legacy fleet is not quiescent ` +
          `(legacyWriters=${legacyPids.length}, abandonedGates=${(quiescence.abandonedGates || []).length}, ` +
          `pendingJournals=${(quiescence.pendingJournals || []).length}, ` +
          `inspectionErrors=${(quiescence.inspectionErrors || []).length}).`,
      );
      process.once('exit', () => releaseAllWorktreeMutexesSync());
      return;
    }

    const legacy = findActiveLegacyWriter({ dir: lockDir });
    if (legacy) {
      safeLog('error', `Warning: active legacy (pre-Option-B) MCP process PID ${legacy.pid} detected in ${lockDir}.`);
    } else {
      const startupOwnerKey =
        (typeof state._sessionKey === "function" ? state._sessionKey()?.key : "") ||
        state.sessionId ||
        state.stateFile ||
        String(process.pid);
      const acquired = await acquireWorktreeMutex({
        projectDir: startupProjectDir,
        ownerKey: startupOwnerKey,
      });
      if (acquired.ok) {
        acquired.capability._isStartupPlaceholder = true;
        state.bindKernelCapability(acquired.capability);
        if (!state._hasExplicitStateFile) {
          const resolvedStateFile = resolveStateFile({ sessionId: state.sessionId, skipMigrationWrites: false });
          if (resolvedStateFile && resolvedStateFile !== state.stateFile) {
            state.stateFile = resolvedStateFile;
            state.historyFile = resolveHistoryFile(resolvedStateFile);
          }
        }
        await refreshWorktreeLockMetadata(state, acquired.capability, {
          operation: "startup",
          dir: lockDir,
          expectedOwnerKey: startupOwnerKey,
        });
      } else if (acquired.reason === "unsupported_platform") {
        safeLog('error', acquired.message || `Unsupported kernel mutex platform: ${process.platform}`);
      } else {
        safeLog('error', `Warning: worktree mutex held by another process (${acquired.endpoint || startupProjectDir}).`);
      }
    }
  }
  process.once('exit', () => releaseAllWorktreeMutexesSync());

  if (heartbeat) {
    const hb = setInterval(() => {
      void runWorktreeHeartbeatTick(state).catch((error) => {
        // Any non-ownership failure is reported, not swallowed, but a
        // background heartbeat must never take the server down with it.
        safeLog(
          "error",
          `Warning: worktree heartbeat failed (${error?.code || error?.message || error}). ` +
            `The capability stays bound; the next tick retries.`,
        );
      });
    }, HEARTBEAT_MS);
    hb.unref?.();
  }
}

async function main() {
  securityMode();
  const startTime = Date.now();
  safeLog('info', `[${new Date().toISOString()}] MCP Server starting...`);

  // Detect the tool versions once, without holding up startup: the promise is
  // not awaited, so a slow or missing binary costs nothing here, and every
  // later snapshot reads the cached result.
  toolchainOnce({ run: createToolchainProbe({ exec }) })
    .then((toolchain) => setToolchain(toolchain))
    .catch(() => setToolchain(null));

  try {
    // Initialize workflow state
    workflowState = new WorkflowState();
    // Select request metadata before the first disk write. Creating an idle
    // PID fallback here leaves a phantom session alongside the real sessions.
    safeLog('info', `[${new Date().toISOString()}] Workflow state initialization complete.`);
  } catch (error) {
    safeLog('error', `[${new Date().toISOString()}] Warning: Failed to initialize workflow state:`, error.message);
    // Continue anyway - workflow state is optional for MCP to function
    workflowState = new WorkflowState();
  }

  // Penanda proses - DI LUAR try di atas, dengan sengaja.
  //
  // 31 Oktober 2026: blok ini semula berada di dalam try yang sama dengan
  // inisialisasi state. Saat dua proses MCP start serempak, satu di antaranya
  // gagal menginisialisasi state (berebut berkas yang sama), masuk ke catch, dan
  // penanda prosesnya tidak pernah ditulis. Hasilnya dua proses hidup dengan
  // satu lock file: proses ganda tidak pernah terdeteksi.
  //
  // Lokasinya juga harus di `.state` PROYEK, bukan di direktori user: direktori
  // user bisa berbeda antar proses, sehingga keduanya tidak saling melihat.
  try {
    await initStartupWorktreeMutex(workflowState, { heartbeat: true });
  } catch (lockError) {
    safeLog('error', 'Warning: could not record process lock:', lockError.message);
  }

  const transport = new StdioServerTransport();
  // Cover SDK-generated protocol errors as well as tool-handler responses.
  const send = transport.send.bind(transport);
  transport.send = message => {
    // These are static protocol schemas, not classified records. In particular,
    // properties.classification is itself a JSON schema object. Treating it as
    // a record label replaces the schema with a redacted record and breaks
    // tools/list validation. Only the exact built-in catalog bypasses filtering;
    // all dynamic tool results and protocol errors retain the output scanner.
    const isTrustedCatalog = message.result && JSON.stringify(message.result) === trustedToolCatalogJson;
    return send(isTrustedCatalog ? message : securityOutputFilter(message));
  };
  safeLog('info', `[${new Date().toISOString()}] Connecting transport...`);
  await server.connect(transport);
  const duration = Date.now() - startTime;
  safeLog('info', `[${new Date().toISOString()}] Dev Workflow MCP Server running on stdio (startup took ${duration}ms)`);

  // A connected agent session must remain visible even while it is working
  // with its own tools and has not called a dev-workflow tool yet. State saves
  // still report immediately; this lightweight heartbeat keeps the MCP
  // connection alive in the monitor between those saves.
  const configuredHeartbeatMs = Number(process.env.DEVWF_MONITOR_HEARTBEAT_MS);
  const heartbeatMs = Number.isFinite(configuredHeartbeatMs) && configuredHeartbeatMs >= 100 && configuredHeartbeatMs <= 60_000
    ? configuredHeartbeatMs
    : 30_000;
  const MAX_HEARTBEAT_INACTIVITY_MS = 20 * 60 * 1000;
  const reportHeartbeat = () => {
    if (!workflowState) return;
    // Keep completed-task cards on their normal history TTL; only live sessions
    // without a task and sessions with active work need repeated liveness data.
    if (workflowState.state?.currentPhase === "idle" && workflowState.state?.taskDescription) return;
    if (Date.now() - lastToolInvocationTimestamp > MAX_HEARTBEAT_INACTIVITY_MS) {
      // Inactive for > 20 mins: stop sending heartbeat pings so the monitor sees the session has paused
      return;
    }
    void reportToMonitorSafe({
      state: workflowState.state,
      stateFile: workflowState.stateFile,
      createdAt: workflowState.sessionStartedAt,
    }).catch(() => false);
  };
  reportHeartbeat();
  const monitorHeartbeat = setInterval(reportHeartbeat, heartbeatMs);
  monitorHeartbeat.unref?.();
}

// --- Lightweight CLI: dev-workflow-mcp call <toolName> [--args '<json>'] ---
async function cliMain(argv) {
  const [, , subcommand, toolName, ...rest] = argv;
  if (subcommand !== "call") return false;

  if (!toolName || typeof toolName !== "string" || toolName.trim() === "") {
    safeLog('error', "Usage: dev-workflow-mcp call <toolName> [--args '<json>']");
    process.exit(2);
  }

  // Parse --args '<json>' if provided
  let rawArgs = undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--args") {
      rawArgs = rest[i + 1];
      break;
    }
  }

  try {
    // Initialize workflow state with kernel mutex enforcement enabled (Option B).
    workflowState = new WorkflowState(undefined, { requireKernelMutex: true });
    await workflowState.load({ skipWrites: true });
    setActiveProjectDir(workflowState.state.projectDir || "");
    if (toolName !== "start_task") {
      try {
        await initStartupWorktreeMutex(workflowState, { heartbeat: false });
      } catch (lockError) {
        safeLog('error', 'Warning: could not record CLI process lock:', lockError.message);
      }
    } else {
      process.once('exit', () => releaseAllWorktreeMutexesSync());
    }

    const request = {
      params: {
        name: toolName,
        arguments: rawArgs ?? {},
      },
    };

    const response = await handleToolCall({
      request,
      normalizeRequestArgs,
      workflowState,
      exec,
      git: createGitFacade(),
      utils: { shellEscape, determineReleaseTypeFromCommit, createCommitMessageParts },
    });

    const text = response?.content?.[0]?.text || "";
    console.log(sanitize(text));
    const isError = response?.isError === true || /^\s*[⚠️❌]/u.test(text);
    process.exit(isError ? 1 : 0);
  } catch (error) {
    safeLog('error', "CLI error:", error.message || String(error));
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] === __filename;
if (isDirectRun) {
  // If invoked with a CLI subcommand, run it; otherwise start MCP server
  if (process.argv[2] === "call") {
    cliMain(process.argv);
  } else {
    main().catch((error) => {
      safeLog('error', "Server error:", error);
      process.exit(1);
    });
  }
}
