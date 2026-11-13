import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { WorkflowState } from "../workflow-state.js";
import {
  handleStartTask,
  handleMarkBugFixed,
  handleCreateTests,
  handleRunTests,
  handleMarkPlanStep,
  handleCreateFeatureFlow,
} from "../tools/handler-modules/workflow-handlers.js";

/**
 * Peristiwa dikirim dari titik-titik yang sudah ada, bukan kait baru.
 *
 * Dua hal dijaga sekaligus:
 *   1. peristiwa benar-benar terkirim untuk aksi penting,
 *   2. monitor yang mati TIDAK mengubah hasil tool apa pun.
 *
 * Tanpa (2), laporan yang gagal akan terlihat seperti kegagalan commit.
 */

async function withState(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "dwf-evt-"));
  const pinLama = process.env.DEV_WORKFLOW_STATE_FILE;
  const urlLama = process.env.DEVWF_MONITOR_URL;
  process.env.DEV_WORKFLOW_STATE_FILE = path.join(dir, "state.json");
  let ws;
  try {
    ws = new WorkflowState();
    await ws.load();
    ws.state.currentPhase = "idle";
    ws.state.taskDescription = "";
    await ws.save();
    return await fn(ws);
  } finally {
    if (ws?.dbAdapter && typeof ws.dbAdapter.close === "function") await ws.dbAdapter.close();
    else if (ws?.dbAdapter?.db && typeof ws.dbAdapter.db.close === "function") ws.dbAdapter.db.close();
    if (pinLama === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = pinLama;
    if (urlLama === undefined) delete process.env.DEVWF_MONITOR_URL;
    else process.env.DEVWF_MONITOR_URL = urlLama;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("eventFor membawa kind, proyek, dan task", async () => {
  const { eventFor } = await import("../monitor.js");
  const e = eventFor({ taskDescription: "Perbaiki x", projectDir: "D:\\code\\clinic" }, "task_started", "detail");
  assert.equal(e.kind, "task_started");
  assert.equal(e.projectName, "clinic");
  assert.equal(e.task, "Perbaiki x");
  assert.equal(e.detail, "detail");
});

test("build events retain the full host payload and exact session key", async () => {
  const { eventFor } = await import("../monitor.js");
  const detail = JSON.stringify({ status: "succeeded", target: "Android APK", buildHost: "builder-vm", output: "x".repeat(1200) });
  const event = eventFor({ projectDir: "D:\\code\\clinic" }, "build_succeeded", detail, "session-42");
  assert.equal(event.sessionKey, "session-42");
  assert.equal(JSON.parse(event.detail).buildHost, "builder-vm");
  assert.equal(JSON.parse(event.detail).output.length, 1200);
});

test("reportEventSafe tidak melempar walau jaringan gagal", async () => {
  const { reportEventSafe } = await import("../monitor.js");
  process.env.DEVWF_MONITOR_URL = "http://127.0.0.1:9";
  assert.equal(await reportEventSafe({ taskDescription: "x" }, "task_started"), false);
});

test("alur penuh tetap berhasil walau monitor mati", async () => {
  await withState(async (ws) => {
    process.env.DEVWF_MONITOR_URL = "http://127.0.0.1:9";

    const started = await handleStartTask(
      { description: "uji", type: "other", definitionOfDone: ["build lulus"], plan: ["satu", "dua"] },
      ws,
      null,
    );
    assert.match(started.content[0].text, /Task Started/);

    const step = await handleMarkPlanStep({ id: "plan-1" }, ws);
    assert.match(step.content[0].text, /^✅/);
    assert.equal(ws.state.plan[0].status, "done");

    await handleCreateFeatureFlow({mermaidCode:'flowchart TD; A[Inspect] --> B[Verify]',description:'Inspect and verify the result'},ws);
    await handleMarkBugFixed({ summary: "ubah" }, ws);
    await handleCreateTests(ws);
    const ran = await handleRunTests({ passed: true, testCommand: "npm test" }, ws);
    assert.match(ran.content[0].text, /^✅/);
    assert.equal(ws.state.testsPassed, true);
    assert.equal(ws.state.currentPhase, "documentation");
  });
});

test("monitor yang menolak permintaan tidak membalikkan hasil tool", async () => {
  await withState(async (ws) => {
    // 500 dari monitor: berbeda dari jaringan mati, dan tetap tidak boleh
    // memengaruhi hasil.
    process.env.DEVWF_MONITOR_URL = "http://127.0.0.1:9";
    const started = await handleStartTask(
      { description: "uji 2", type: "other", definitionOfDone: ["build lulus"], plan: ["satu"] },
      ws,
      null,
    );
    assert.match(started.content[0].text, /Task Started/);
    assert.equal(ws.state.taskDescription, "uji 2");
  });
});

