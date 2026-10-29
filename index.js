#!/usr/bin/env node

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
import { exec } from "./exec.js";
import { normalizeRequestArgs, shellEscape } from "./utils.js";
import { createGitFacade } from "./git-facade.js";
import {
  createCommitMessageParts,
  determineReleaseTypeFromCommit,
} from "./commit-helpers.js";
import { WorkflowState } from "./workflow-state.js";
import { getToolList } from "./tools/definitions.js";
import { handleToolCall } from "./tools/handlers.js";

export { createCommitMessageParts, determineReleaseTypeFromCommit } from "./commit-helpers.js";
export { containsTestFilesInStatus, workingTreeSummary } from "./git-helpers.js";
export { createGitFacade } from "./git-facade.js";
export { WorkflowState } from "./workflow-state.js";

export let workflowState = null;

const __filename = fileURLToPath(import.meta.url);

// Create MCP server
export const server = new Server(
  {
    name: "@programinglive/dev-workflow-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getToolList(),
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
  // Reload state from disk before each request to ensure consistency
  if (workflowState) {
    await workflowState.load();
  }
  return securityOutputFilter(await handleToolCall({
    request,
    normalizeRequestArgs,
    workflowState,
    exec,
    git: createGitFacade(),
    utils: { shellEscape, determineReleaseTypeFromCommit, createCommitMessageParts },
  }));
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
            text: `Development Workflow Discipline:

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
export async function main() {
  securityMode();
  const startTime = Date.now();
  safeLog('error', `[${new Date().toISOString()}] MCP Server starting...`);

  try {
    // Initialize workflow state
    workflowState = new WorkflowState();
    safeLog('error', `[${new Date().toISOString()}] Loading workflow state...`);
    await workflowState.load();
    safeLog('error', `[${new Date().toISOString()}] Workflow state loaded.`);

    safeLog('error', `[${new Date().toISOString()}] Ensuring primary file...`);
    await workflowState.ensurePrimaryFile();
    safeLog('error', `[${new Date().toISOString()}] Workflow state initialization complete.`);
  } catch (error) {
    safeLog('error', `[${new Date().toISOString()}] Warning: Failed to initialize workflow state:`, error.message);
    // Continue anyway - workflow state is optional for MCP to function
    workflowState = new WorkflowState();
  }

  const transport = new StdioServerTransport();
  // Cover SDK-generated protocol errors as well as tool-handler responses.
  const send = transport.send.bind(transport);
  transport.send = message => send(securityOutputFilter(message));
  safeLog('error', `[${new Date().toISOString()}] Connecting transport...`);
  await server.connect(transport);
  const duration = Date.now() - startTime;
  safeLog('error', `[${new Date().toISOString()}] Dev Workflow MCP Server running on stdio (startup took ${duration}ms)`);
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
    // Initialize workflow state similar to the server path
    workflowState = new WorkflowState();
    await workflowState.load();
    await workflowState.ensurePrimaryFile();

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
