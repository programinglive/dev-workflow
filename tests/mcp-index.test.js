import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MCP_ECOSYSTEM_INDEX,
  recommendMcpTools,
  formatMcpRecommendations,
  formatFullMcpCatalog,
} from "../mcp-index.js";
import { getToolList } from "../tools/definitions.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { WorkflowState } from "../workflow-state.js";
import { createGitMock, testUtils } from "./test-helpers.js";
import { hapusSementara } from "./helpers/hapus-sementara.js";

async function withTempState(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-index-test-"));
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  const state = new WorkflowState(path.join(dir, "state.json"));
  await state.load();
  try {
    await fn(state, dir);
  } finally {
    try {
      if (state.dbAdapter && typeof state.dbAdapter.close === "function") {
        await state.dbAdapter.close();
      }
      if (state.dbAdapter?.db && typeof state.dbAdapter.db.close === "function") {
        state.dbAdapter.db.close();
      }
    } catch {}
    await hapusSementara(dir);
  }
}

test("MCP_ECOSYSTEM_INDEX covers all core MCP servers in the ecosystem", () => {
  assert.ok(Array.isArray(MCP_ECOSYSTEM_INDEX), "MCP_ECOSYSTEM_INDEX must be an array");
  const ids = MCP_ECOSYSTEM_INDEX.map((entry) => entry.id);

  const requiredIds = [
    "central-gateway",
    "pocketbase",
    "infra-knowledge",
    "notify",
    "zettly",
    "clinic-helper",
    "playwright",
    "cloudflare",
    "gcp",
    "netlify",
    "mermaid",
  ];

  for (const id of requiredIds) {
    assert.ok(ids.includes(id), `Expected MCP_ECOSYSTEM_INDEX to include '${id}'`);
  }
  assert.equal(ids.includes("factory"), false, "Retired factory MCP server must not be in MCP_ECOSYSTEM_INDEX");

  for (const entry of MCP_ECOSYSTEM_INDEX) {
    assert.ok(typeof entry.id === "string" && entry.id.length > 0);
    assert.ok(typeof entry.serverName === "string" && entry.serverName.length > 0);
    assert.ok(typeof entry.summary === "string" && entry.summary.length > 0);
    assert.ok(Array.isArray(entry.tools) && entry.tools.length > 0, `${entry.id} must list tools`);
    assert.ok(entry.triggers && Array.isArray(entry.triggers.keywords), `${entry.id} must have trigger keywords`);
  }
});

test("recommendMcpTools ranks clinic-helper and playwright for Clinic Laravel UI tasks", () => {
  const result = recommendMcpTools({
    description: "Fix Livewire invoice calculation and verify in browser on Clinic ERP",
    projectDir: "D:/code/clinic",
    definitionOfDone: ["Paratest passes", "Playwright browser snapshot verified"],
    plan: ["Run clinic_doctor", "Inspect Livewire component"],
  });

  assert.ok(result.recommendations.length >= 2);
  const topIds = result.recommendations.map((r) => r.id);
  assert.ok(topIds.includes("clinic-helper"), `Expected clinic-helper in [${topIds.join(", ")}]`);
  assert.ok(topIds.includes("playwright"), `Expected playwright in [${topIds.join(", ")}]`);
});

test("recommendMcpTools ranks pocketbase and infra-knowledge for database + VM deployment tasks", () => {
  const result = recommendMcpTools({
    description: "Add PocketBase collection for authentication logs and deploy systemd service to n8n-instance via SSH",
    projectDir: "D:/code/notification-hub",
    definitionOfDone: ["PocketBase collection created", "Systemd service active on VM"],
  });

  const topIds = result.recommendations.map((r) => r.id);
  assert.ok(topIds.includes("pocketbase"), `Expected pocketbase in [${topIds.join(", ")}]`);
  assert.ok(topIds.includes("infra-knowledge"), `Expected infra-knowledge in [${topIds.join(", ")}]`);
});

test("recommendMcpTools ranks notify for Discord/Pusher/Email alert tasks", () => {
  const result = recommendMcpTools({
    description: "Send real-time Pusher event and Discord webhook alert when backup fails",
    projectDir: "D:/code/notification-hub",
  });

  const topIds = result.recommendations.map((r) => r.id);
  assert.equal(topIds[0], "notify");
  const notifyRec = result.recommendations.find((r) => r.id === "notify");
  assert.ok(notifyRec.matchedTools.some((t) => t.name.includes("notify_send")));
});

test("recommendMcpTools ranks zettly for todo and outcome coordination tasks", () => {
  const result = recommendMcpTools({
    query: "How do I sync Zettly todo outcome and active focus?",
  });

  const topIds = result.recommendations.map((r) => r.id);
  assert.ok(topIds.includes("zettly"), `Expected zettly in [${topIds.join(", ")}]`);
});

test("formatMcpRecommendations renders readable section with tool names and match reasons", () => {
  const rec = recommendMcpTools({
    description: "Check fleet health and SSH into VM instance to inspect nginx logs",
    projectDir: "D:/code/central-mcp-gateway",
  });
  const formatted = formatMcpRecommendations(rec);

  assert.match(formatted, /🧭 Recommended MCP Tools/);
  assert.match(formatted, /infra-knowledge/);
  assert.match(formatted, /recommend_mcp_tools/);
});

test("recommend_mcp_tools tool is registered in definitions and callable via handleToolCall", async () => {
  const tools = getToolList();
  const toolDef = tools.find((t) => t.name === "recommend_mcp_tools");
  assert.ok(toolDef, "recommend_mcp_tools must be registered in tools/definitions.js");
  assert.equal(toolDef.inputSchema.type, "object");
  assert.ok(toolDef.inputSchema.properties.query);
  assert.ok(toolDef.inputSchema.properties.projectDir);
  assert.ok(toolDef.inputSchema.properties.includeAll);

  await withTempState(async (state) => {
    const queryResp = await handleToolCall({
      request: {
        params: {
          name: "recommend_mcp_tools",
          arguments: {
            query: "query PocketBase records and send Pusher notification",
            projectDir: "D:/code/notification-hub",
          },
        },
      },
      normalizeRequestArgs,
      workflowState: state,
      git: createGitMock(),
      utils: testUtils,
    });

    const text = queryResp.content[0].text;
    assert.match(text, /🧭 Recommended MCP Tools/);
    assert.match(text, /pb_list_records|pocketbase/i);
    assert.match(text, /notify_send|notify/i);

    const catalogResp = await handleToolCall({
      request: {
        params: {
          name: "recommend_mcp_tools",
          arguments: { includeAll: true },
        },
      },
      normalizeRequestArgs,
      workflowState: state,
      git: createGitMock(),
      utils: testUtils,
    });

    const catalogText = catalogResp.content[0].text;
    assert.match(catalogText, /📚 Complete MCP Ecosystem Index/);
    assert.match(catalogText, /central-gateway/);
    assert.match(catalogText, /clinic-helper/);
  });
});

test("start_task and get_workflow_status automatically include context-aware MCP recommendations", async () => {
  await withTempState(async (state, dir) => {
    const startResp = await handleToolCall({
      request: {
        params: {
          name: "start_task",
          arguments: {
            description: "Inspect PocketBase collections and deploy update to VM via SSH",
            type: "feature",
            projectDir: dir,
            definitionOfDone: ["PocketBase schema verified", "Deployed to VM"],
            plan: ["Check pb_list_collections", "Deploy via ssh_vm"],
          },
        },
      },
      normalizeRequestArgs,
      workflowState: state,
      git: createGitMock(),
      utils: testUtils,
      zettlyOptions: { enabled: false },
    });

    const startText = startResp.content[0].text;
    assert.match(startText, /✅ Task Started:/);
    assert.match(startText, /🧭 Recommended MCP Tools/);
    assert.match(startText, /pocketbase|pb_list_collections/i);
    assert.match(startText, /infra-knowledge|ssh_vm/i);

    const statusResp = await handleToolCall({
      request: {
        params: {
          name: "get_workflow_status",
          arguments: {},
        },
      },
      normalizeRequestArgs,
      workflowState: state,
      git: createGitMock(),
      utils: testUtils,
      zettlyOptions: { enabled: false },
    });

    const statusText = statusResp.content[0].text;
    assert.match(statusText, /📊 Current Workflow Status:/);
    assert.match(statusText, /🧭 Recommended MCP Tools/);
  });
});
