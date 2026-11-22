/**
 * Thin integration adapter connecting DevWorkflow MCP v3.1+ to Zettly Code
 * (`@programinglive/zettly-code`, private repository).
 *
 * Keeps DevWorkflow decoupled from Zettly Code internals:
 * - Resolves Zettly Code via explicit env override, installed package,
 *   sibling of the target `projectDir`, or sibling of the DevWorkflow checkout.
 * - Fails gracefully with an explicit structured status when running in public standalone
 *   environments where the private Zettly Code package is not installed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedModule = undefined;

/**
 * @zettly-code ZC-DW-ADAPTER-001
 * @purpose Resolve the optional private @programinglive/zettly-code engine from env, node_modules, or sibling workspace
 * @domain code-intelligence
 * @invariant ManagedMCP revision cache paths must still resolve sibling zettly-code relative to target projectDir without hardcoding workstation paths
 * @bug-fix BUG-DW-ADAPTER-313
 * @root-cause ManagedMCP executes from ~/.devworkflow/managed/revisions/<rev>, so checking only ../zettly-code relative to __dirname returned ZETTLY_CODE_UNAVAILABLE during live MCP calls
 * @fix Added candidate resolution relative to the caller's target projectDir before falling back to __dirname
 * @related runCodeIndex, runCodeContext, runBugFixKnowledgeGate
 * @tests zettly-code-and-release-governance-v310.test.js
 */
async function loadZettlyCodeModule(projectDir = null) {
  if (cachedModule) return cachedModule;

  // 1. Explicit environment override (for tests or custom deployments)
  if (process.env.ZETTLY_CODE_MODULE_PATH) {
    const abs = path.resolve(process.env.ZETTLY_CODE_MODULE_PATH);
    if (fs.existsSync(abs)) {
      cachedModule = await import(pathToFileURL(abs).href);
      return cachedModule;
    }
  }

  // 2. Installed private package `@programinglive/zettly-code`
  try {
    cachedModule = await import("@programinglive/zettly-code");
    return cachedModule;
  } catch {
    // Fall through to sibling workspace resolution
  }

  // 3. Sibling workspace checkout relative to target projectDir (supports ManagedMCP revision cache)
  if (projectDir) {
    const projectSibling = path.resolve(projectDir, "..", "zettly-code", "src", "index.js");
    if (fs.existsSync(projectSibling)) {
      cachedModule = await import(pathToFileURL(projectSibling).href);
      return cachedModule;
    }
  }

  // 4. Sibling workspace checkout relative to DevWorkflow repository root
  const siblingEntry = path.resolve(__dirname, "..", "..", "zettly-code", "src", "index.js");
  if (fs.existsSync(siblingEntry)) {
    cachedModule = await import(pathToFileURL(siblingEntry).href);
    return cachedModule;
  }

  return null;
}

export function resetZettlyCodeAdapterCache() {
  cachedModule = undefined;
}

export async function isZettlyCodeAvailable(projectDir = null) {
  const mod = await loadZettlyCodeModule(projectDir);
  return Boolean(mod && typeof mod.handleCodeIndex === "function");
}

export async function runCodeIndex(args = {}) {
  const mod = await loadZettlyCodeModule(args.projectDir || null);
  if (!mod) {
    return {
      ok: false,
      code: "ZETTLY_CODE_UNAVAILABLE",
      message:
        "Zettly Code engine (@programinglive/zettly-code) is not installed in this environment. Configure ZETTLY_CODE_MODULE_PATH or install the private package.",
    };
  }
  return mod.handleCodeIndex(args);
}

export async function runCodeContext(args = {}) {
  const mod = await loadZettlyCodeModule(args.projectDir || null);
  if (!mod) {
    return {
      ok: false,
      code: "ZETTLY_CODE_UNAVAILABLE",
      message:
        "Zettly Code engine (@programinglive/zettly-code) is not installed in this environment. Configure ZETTLY_CODE_MODULE_PATH or install the private package.",
    };
  }
  return mod.handleCodeContext(args);
}

export async function runBugFixKnowledgeGate(args = {}) {
  const mod = await loadZettlyCodeModule(args.projectDir || null);
  if (!mod) {
    return {
      ok: false,
      gate: "bugfix_knowledge_gate",
      status: "ENGINE_UNAVAILABLE",
      code: "ZETTLY_CODE_UNAVAILABLE",
      message:
        "Zettly Code engine (@programinglive/zettly-code) is not installed; unable to verify @zettly-code bug-fix knowledge annotations.",
      findings: [
        {
          code: "ZETTLY_CODE_UNAVAILABLE",
          severity: "error",
          message: "Install @programinglive/zettly-code or set ZETTLY_CODE_MODULE_PATH to run bugfix_knowledge_gate.",
        },
      ],
    };
  }
  return mod.evaluateBugFixKnowledgeGate(args);
}
