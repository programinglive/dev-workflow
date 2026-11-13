import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowState } from "../workflow-state.js";
import { handleStartTask } from "../tools/handler-modules/workflow-handlers.js";

function tempRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwf-checkpoint-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "a.txt"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return { dir, git };
}

const saved = { stateFile: process.env.DEV_WORKFLOW_STATE_FILE, monitor: process.env.DEVWF_MONITOR_URL, zettly: process.env.ZETTLY_SYNC_DISABLED };

async function withState(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwf-checkpoint-state-"));
  process.env.DEV_WORKFLOW_STATE_FILE = path.join(dir, "state.json");
  process.env.DEVWF_MONITOR_URL = "http://127.0.0.1:9";
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
    rmSync(dir, { recursive: true, force: true });
  }
}

test("checkpoint defaults are present before any checkpoint is written", async () => {
  await withState(async (ws) => {
    assert.equal(ws.state.checkpoint.summary, "");
    assert.deepEqual(ws.state.checkpoint.commits, []);
    assert.equal(ws.state.checkpoint.handover, null);
    assert.equal(ws.state.checkpoint.baseSha, null);
    assert.equal(ws.state.checkpoint.checkpointedAt, null);
  });
});

test("start_task records the machine and the base commit", async () => {
  const repo = tempRepo();
  const before = process.env.DEVWF_MACHINE;
  process.env.DEVWF_MACHINE = "Mac";
  try {
    await withState(async (ws) => {
      await handleStartTask(
        {
          description: "record the base commit",
          type: "feature",
          projectDir: repo.dir,
          definitionOfDone: ["the base commit is recorded"],
          plan: ["record the base commit"],
        },
        ws,
        null
      );
      assert.equal(ws.state.machine, "Mac");
      assert.equal(ws.state.checkpoint.baseSha, repo.git("rev-parse", "HEAD").trim());
    });
  } finally {
    if (before === undefined) delete process.env.DEVWF_MACHINE;
    else process.env.DEVWF_MACHINE = before;
    rmSync(repo.dir, { recursive: true, force: true });
    if (saved.stateFile === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = saved.stateFile;
  }
});
