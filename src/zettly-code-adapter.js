/**
 * Thin integration adapter connecting DevWorkflow MCP v3.1+ to Zettly Code
 * (`@programinglive/zettly-code`, open-source MIT repository: https://github.com/programinglive/zettly-code).
 *
 * Keeps DevWorkflow cleanly modularized while bundling Zettly Code out of the box:
 * - Resolves Zettly Code via explicit env override, bundled `src/vendor/zettly-code/`,
 *   installed package, sibling of the target `projectDir`, or sibling of the DevWorkflow checkout.
 * - Fails gracefully with an explicit structured status only when explicitly pointed to an invalid override.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveZettlyConfig, zettlySyncEnabled } from "../zettly-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedModule = undefined;

/**
 * @zettly-code ZC-DW-ADAPTER-001
 * @purpose Resolve the open-source @programinglive/zettly-code engine from env override, bundled vendor directory, node_modules, or sibling workspace
 * @domain code-intelligence
 * @invariant ManagedMCP revision cache and standalone installations must always resolve the bundled open-source Zettly Code engine without external setup
 * @bug-fix BUG-DW-ADAPTER-313
 * @root-cause ManagedMCP executes from ~/.devworkflow/managed/revisions/<rev>, so checking only ../zettly-code relative to __dirname returned ZETTLY_CODE_UNAVAILABLE during live MCP calls
 * @fix Bundled open-source Zettly Code inside src/vendor/zettly-code and added candidate resolution relative to the caller's target projectDir
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
    if (process.env.ZETTLY_CODE_STRICT_OVERRIDE === "1") {
      return null;
    }
  }

  // 2. Bundled open-source Zettly Code engine (`src/vendor/zettly-code/src/index.js`)
  const bundledEntry = path.resolve(__dirname, "vendor", "zettly-code", "src", "index.js");
  if (fs.existsSync(bundledEntry)) {
    cachedModule = await import(pathToFileURL(bundledEntry).href);
    return cachedModule;
  }

  // 3. Installed open-source package `@programinglive/zettly-code`
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

const KNOWN_REPO_SLUGS = {
  clinic: { slug: "clinic", repo_full_name: "beautyworld_repository/clinic" },
  "hris.beautyworld.co.id": { slug: "hris", repo_full_name: "beautyworld_repository/hris.beautyworld.co.id" },
  hris: { slug: "hris", repo_full_name: "beautyworld_repository/hris.beautyworld.co.id" },
  "erp.beautyworld.co.id": { slug: "erp", repo_full_name: "beautyworld_repository/erp.beautyworld.co.id" },
  erp: { slug: "erp", repo_full_name: "beautyworld_repository/erp.beautyworld.co.id" },
  frontend_erp: { slug: "frontend-erp", repo_full_name: "beautyworld_repository/frontend_erp" },
  "frontend-erp": { slug: "frontend-erp", repo_full_name: "beautyworld_repository/frontend_erp" },
  zettly: { slug: "zettly-app", repo_full_name: "programinglive/zettly" },
  "zettly-app": { slug: "zettly-app", repo_full_name: "programinglive/zettly" },
  "zettly-code": { slug: "zettly-code", repo_full_name: "programinglive/zettly-code" },
  "dev-workflow": { slug: "dev-workflow", repo_full_name: "programinglive/dev-workflow" },
  "central-mcp-gateway": { slug: "central-mcp-gateway", repo_full_name: "programinglive/central-mcp-gateway" },
};

function resolveRepoIdentity(projectDir) {
  const baseName = path.basename(path.resolve(projectDir || process.cwd()));
  if (KNOWN_REPO_SLUGS[baseName]) {
    return KNOWN_REPO_SLUGS[baseName];
  }
  try {
    const remoteUrl = execFileSync("git", ["-C", projectDir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = remoteUrl.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
    if (m?.[1]) {
      const repoFullName = m[1];
      const repoName = repoFullName.split("/")[1] || baseName;
      if (KNOWN_REPO_SLUGS[repoName]) {
        return KNOWN_REPO_SLUGS[repoName];
      }
      return {
        slug: repoName.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
        repo_full_name: repoFullName,
      };
    }
  } catch {
    // fallback to directory basename
  }
  return {
    slug: baseName.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
    repo_full_name: baseName,
  };
}

function resolveGitBranch(projectDir) {
  try {
    return (
      execFileSync("git", ["-C", projectDir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "main"
    );
  } catch {
    return "main";
  }
}

function resolveCentralGatewayMcpUrl(env = process.env, home = os.homedir()) {
  const raw = env.CENTRAL_GATEWAY_URL || env.CENTRAL_MCP_GATEWAY_URL || "";
  if (raw.trim()) {
    return raw.trim().replace(/\/sse\/?$/, "/mcp");
  }
  const candidates = [
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".gemini", "antigravity-cli", "mcp_config.json"),
  ];
  for (const cfgPath of candidates) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const srv =
        cfg?.mcp?.servers?.["central-gateway"] ||
        cfg?.mcp?.["central-gateway"] ||
        cfg?.mcpServers?.["central-gateway"];
      const url = srv?.url || srv?.serverUrl;
      if (typeof url === "string" && url.startsWith("http")) {
        return url.replace(/\/sse\/?$/, "/mcp");
      }
    } catch {
      // ignore malformed client config
    }
  }
  return "";
}

export async function extractCodeGraphSnapshot(projectDir, indexResult = {}) {
  const resolvedDir = path.resolve(projectDir || process.cwd());
  const mod = await loadZettlyCodeModule(resolvedDir);
  const identity = resolveRepoIdentity(resolvedDir);
  const branch = resolveGitBranch(resolvedDir);
  const rawStats = indexResult?.stats || {};

  let annotations = [];
  let bugFixes = [];
  if (mod && typeof mod.CodeKnowledgeGraphStore === "function") {
    let store = null;
    try {
      store = new mod.CodeKnowledgeGraphStore(resolvedDir);
      store.open();
      annotations = store.db
        .prepare(
          "SELECT knowledge_id, file_path, attached_symbol, purpose, domain, bug_fixes_json, root_cause, hypothesis, fix_summary, tests_json, updated_at FROM knowledge_annotations ORDER BY knowledge_id ASC LIMIT 100"
        )
        .all()
        .map((row) => ({
          id: row.knowledge_id,
          file_path: row.file_path,
          symbol_name: row.attached_symbol || "",
          purpose: row.purpose,
          domain: row.domain || "",
          bug_fix: JSON.parse(row.bug_fixes_json || "[]")[0] || "",
          root_cause: row.root_cause || row.hypothesis || "",
          fix_summary: row.fix_summary || "",
          tests: JSON.parse(row.tests_json || "[]"),
          updated_at: row.updated_at,
        }));
      bugFixes = store.db
        .prepare(
          "SELECT bug_id, problem_description, affected_entities_json, confirmed_root_cause, fix_summary, test_references_json FROM bug_fix_records ORDER BY bug_id ASC LIMIT 100"
        )
        .all()
        .map((row) => ({
          bug_id: row.bug_id,
          title: row.problem_description,
          symptom: row.problem_description,
          root_cause: row.confirmed_root_cause || "",
          fix_summary: row.fix_summary || "",
          related_files: JSON.parse(row.affected_entities_json || "[]"),
          tests: JSON.parse(row.test_references_json || "[]"),
        }));
    } catch {
      // non-fatal if sqlite rows cannot be queried
    } finally {
      if (store) {
        try {
          store.close();
        } catch {}
      }
    }
  }

  const stats = {
    files_indexed: Number(rawStats.files_indexed || 0),
    entities_count: Number(rawStats.entities_count || rawStats.symbols_count || 0),
    symbols_count: Number(rawStats.entities_count || rawStats.symbols_count || 0),
    relationships_count: Number(rawStats.relationships_count || 0),
    test_links_count: Number(rawStats.test_relationships_count || rawStats.test_links_count || 0),
    knowledge_annotations_count: Math.max(
      Number(rawStats.knowledge_annotations_count || 0),
      annotations.length
    ),
    bug_fixes_count: Math.max(
      Number(rawStats.bug_fix_records_count || rawStats.bug_fixes_count || 0),
      bugFixes.length
    ),
    db_size_bytes: Number(rawStats.db_size_bytes || 0),
  };

  return {
    project_slug: identity.slug,
    repo_full_name: identity.repo_full_name,
    mode: indexResult?.mode || "update",
    freshness_status: indexResult?.freshnessStatus || "FRESH",
    revision: indexResult?.currentRevision || rawStats.last_revision || "",
    branch,
    machine: os.hostname(),
    stats,
    annotations,
    bug_fixes: bugFixes,
    synced_at: new Date().toISOString(),
  };
}

export async function syncCodeGraphTelemetry(
  snapshot,
  {
    zettlyApiUrl = "",
    zettlyApiToken = "",
    centralGatewayUrl = "",
    fetchImpl = fetch,
  } = {}
) {
  const out = {
    zettly: { ok: false, skipped: true },
    pocketbase: { ok: false, skipped: true },
  };
  if (!snapshot || !snapshot.project_slug) return out;

  let resolvedZettlyUrl = zettlyApiUrl;
  let resolvedZettlyToken = zettlyApiToken;
  if (!resolvedZettlyUrl || !resolvedZettlyToken) {
    try {
      const cfg = await resolveZettlyConfig();
      if (cfg?.base && cfg?.token) {
        resolvedZettlyUrl = cfg.base;
        resolvedZettlyToken = cfg.token;
      }
    } catch {}
  }

  if (resolvedZettlyUrl && resolvedZettlyToken) {
    try {
      const res = await fetchImpl(
        `${resolvedZettlyUrl.replace(/\/+$/, "")}/api/v1/engineering/code-graph/sync`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${resolvedZettlyToken}`,
          },
          body: JSON.stringify(snapshot),
        }
      );
      out.zettly = { ok: res.ok, status: res.status, skipped: false };
    } catch (err) {
      out.zettly = { ok: false, skipped: false, error: err.message };
    }
  }

  const gatewayUrl = centralGatewayUrl || resolveCentralGatewayMcpUrl();
  if (gatewayUrl) {
    try {
      const callGatewayTool = async (name, args) => {
        const res = await fetchImpl(gatewayUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        if (!res.ok) throw new Error(`Gateway HTTP ${res.status}`);
        const rpc = await res.json();
        const text = rpc?.result?.content?.[0]?.text || "{}";
        if (rpc?.result?.isError) throw new Error(text);
        return JSON.parse(text);
      };

      const pbData = {
        project_slug: snapshot.project_slug,
        repo_full_name: snapshot.repo_full_name,
        branch: snapshot.branch,
        revision: snapshot.revision,
        machine: snapshot.machine,
        freshness_status: snapshot.freshness_status || "FRESH",
        files_indexed: snapshot.stats.files_indexed,
        symbols_count: snapshot.stats.symbols_count,
        relationships_count: snapshot.stats.relationships_count,
        test_links_count: snapshot.stats.test_links_count,
        knowledge_annotations_count: snapshot.stats.knowledge_annotations_count,
        bug_fixes_count: snapshot.stats.bug_fixes_count,
        stats: snapshot.stats,
        annotations: snapshot.annotations,
        bug_fixes: snapshot.bug_fixes,
        synced_at: snapshot.synced_at,
      };

      const existing = await callGatewayTool("pb_list_records", {
        collection: "zettly_code_graphs",
        filter: `project_slug='${snapshot.project_slug}'`,
        page: 1,
        perPage: 1,
      });
      const existingRecord = existing?.items?.[0];
      if (existingRecord?.id) {
        await callGatewayTool("pb_update_record", {
          collection: "zettly_code_graphs",
          id: existingRecord.id,
          data: pbData,
        });
        out.pocketbase = { ok: true, skipped: false, action: "updated", recordId: existingRecord.id };
      } else {
        const created = await callGatewayTool("pb_create_record", {
          collection: "zettly_code_graphs",
          data: pbData,
        });
        out.pocketbase = { ok: true, skipped: false, action: "created", recordId: created?.id || null };
      }
    } catch (err) {
      out.pocketbase = { ok: false, skipped: false, error: err.message };
    }
  }

  return out;
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
  const result = await mod.handleCodeIndex(args);
  const mode = String(args.mode || "status").toLowerCase();
  if (
    result?.ok &&
    (mode === "initialize" || mode === "update") &&
    !args.skipTelemetrySync &&
    zettlySyncEnabled()
  ) {
    try {
      const snapshot = await extractCodeGraphSnapshot(args.projectDir || process.cwd(), result);
      result.telemetrySync = await syncCodeGraphTelemetry(snapshot);
    } catch {
      // Telemetry sync is always best-effort and never blocks local code_index
    }
  }
  return result;
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
