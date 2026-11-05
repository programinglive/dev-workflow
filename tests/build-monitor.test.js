import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeBuildState,
  formatBuildStatusBlock,
  extractActiveBuildFromEvents,
} from "../build-monitor.js";
import { buildSnapshot } from "../monitor.js";
import { getToolList } from "../tools/definitions.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { WorkflowState } from "../workflow-state.js";
import { createGitMock, testUtils } from "./test-helpers.js";
import { hapusSementara } from "./helpers/hapus-sementara.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withTempState(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "build-monitor-test-"));
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

test("normalizeBuildState tracks target, command, stage, progress, and timestamps", () => {
  const started = normalizeBuildState({
    status: "building",
    target: "Clinic Docker Image v0.2.11 + Trivy Scan",
    command: "docker build -t clinic:v0.2.11 . && trivy image clinic:v0.2.11",
    stage: "Step 2/4: Compiling Vite frontend assets",
    progress: 45,
    output: "vite v5.4.0 building for production...",
  });

  assert.equal(started.status, "building");
  assert.equal(started.target, "Clinic Docker Image v0.2.11 + Trivy Scan");
  assert.equal(started.progress, 45);
  assert.ok(started.startedAt);
  assert.ok(started.updatedAt);
  assert.equal(started.finishedAt, "");

  const finished = normalizeBuildState(
    {
      status: "succeeded",
      stage: "Step 4/4: Image built and Trivy scan clean",
      progress: 100,
    },
    started,
  );

  assert.equal(finished.status, "succeeded");
  assert.equal(finished.target, "Clinic Docker Image v0.2.11 + Trivy Scan");
  assert.equal(finished.startedAt, started.startedAt);
  assert.equal(finished.progress, 100);
  assert.ok(finished.finishedAt);
});

test("build host is preserved within a build and cleared for a new target", () => {
  const started = normalizeBuildState({status: "building", target: "Android APK", buildHost: "builder-vm"});
  const finished = normalizeBuildState({status: "succeeded", target: "Android APK"}, started);
  const next = normalizeBuildState({status: "building", target: "Web bundle"}, finished);
  assert.equal(started.buildHost, "builder-vm");
  assert.equal(finished.buildHost, "builder-vm");
  assert.equal(next.buildHost, "");
  assert.match(formatBuildStatusBlock(started), /\*\*Build host\*\*: builder-vm/);
  assert.ok(getToolList().find((tool) => tool.name === "report_build_status").inputSchema.properties.buildHost);
});

test("formatBuildStatusBlock renders active build progress bar, target, command, and stage", () => {
  const active = normalizeBuildState({
    status: "building",
    target: "central-mcp-gateway bundle",
    command: "npm run build",
    stage: "Bundling ESM modules",
    progress: 60,
    output: "dist/index.js 42kb",
  });

  const block = formatBuildStatusBlock(active, []);
  assert.match(block, /🏗️ Active Build \/ Execution Monitor/);
  assert.match(block, /BUILDING/i);
  assert.match(block, /central-mcp-gateway bundle/);
  assert.match(block, /npm run build/);
  assert.match(block, /Bundling ESM modules/);
  assert.match(block, /60%/);
});

test("report_build_status tool is registered and updates workflow state and get_workflow_status output", async () => {
  const toolDef = getToolList().find((t) => t.name === "report_build_status");
  assert.ok(toolDef, "report_build_status must be registered in tools/definitions.js");
  assert.ok(toolDef.inputSchema.properties.status);
  assert.ok(toolDef.inputSchema.properties.target);
  assert.ok(toolDef.inputSchema.properties.command);
  assert.ok(toolDef.inputSchema.properties.stage);
  assert.ok(toolDef.inputSchema.properties.progress);

  await withTempState(async (state, dir) => {
    await handleToolCall({
      request: {
        params: {
          name: "start_task",
          arguments: {
            description: "Build and scan Clinic production image",
            type: "feature",
            projectDir: dir,
            definitionOfDone: ["Docker image built", "Trivy scan passed"],
            plan: ["Build image", "Scan image"],
          },
        },
      },
      normalizeRequestArgs,
      workflowState: state,
      git: createGitMock(),
      utils: testUtils,
      zettlyOptions: { enabled: false },
    });

    const buildResp = await handleToolCall({
      request: {
        params: {
          name: "report_build_status",
          arguments: {
            status: "building",
            target: "clinic-app:v0.2.11",
            command: "/tmp/step4-image.sh",
            stage: "Building Docker layers & running Trivy scan",
            progress: 50,
            output: "Step 8/14 : RUN npm run build",
          },
        },
      },
      normalizeRequestArgs,
      workflowState: state,
      git: createGitMock(),
      utils: testUtils,
      zettlyOptions: { enabled: false },
    });

    assert.match(buildResp.content[0].text, /🏗️ Active Build \/ Execution Monitor/);
    assert.match(buildResp.content[0].text, /clinic-app:v0.2.11/);

    const snap = buildSnapshot({ state: state.state, sessionKey: "ses_build_1", projectPath: dir });
    assert.ok(snap.activeBuild);
    assert.equal(snap.activeBuild.target, "clinic-app:v0.2.11");
    assert.equal(snap.activeBuild.status, "building");

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

    assert.match(statusResp.content[0].text, /🏗️ Active Build \/ Execution Monitor/);
    assert.match(statusResp.content[0].text, /clinic-app:v0.2.11/);
    assert.match(statusResp.content[0].text, /Building Docker layers/);
  });
});

test("extractActiveBuildFromEvents reconstructs live build state for dashboard sessions", () => {
  const events = [
    {
      session_key: "ses_1",
      machine: "Mac",
      project_name: "clinic",
      kind: "build_started",
      detail: JSON.stringify({
        status: "building",
        target: "clinic:v0.2.11",
        command: "/tmp/step4-image.sh",
        stage: "Docker build + Trivy scan",
        progress: 70,
      }),
      at: new Date().toISOString(),
    },
  ];

  const map = extractActiveBuildFromEvents(events);
  assert.ok(map.get("ses_1"));
  assert.equal(map.get("ses_1").target, "clinic:v0.2.11");
  assert.equal(map.get("ses_1").progress, 70);
});

test("monitor-server/dashboard.cjs includes Live Build Monitor UI, KPI strip, and pipeline stepper", () => {
  const dash = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");
  assert.match(dash, /id="build-monitor"/);
  assert.match(dash, /id="kpi-strip"/);
  assert.match(dash, /id="modal-build"/);
  assert.match(dash, /renderBuildMonitor/);
  assert.match(dash, /renderPipeline/);
  assert.match(dash, /active_build/);
});
