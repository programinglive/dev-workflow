import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleResumeSession, findResumableCandidates } from "../tools/handler-modules/resume-handlers.js";

const text = (r) => r.content[0].text;

/**
 * State disimpan per sesi, jadi sesi yang ditutup meninggalkan pekerjaannya.
 * Tanpa jalur reconnect, sesi baru mulai dari nol dan pekerjaan itu tidak
 * pernah terlihat lagi - diukur 1 November 2026: satu task tertinggal di fase
 * release dan tidak terbaca siapa pun.
 */

async function withProject(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "dwf-resume-"));
  const projectDir = path.join(root, "projects", "demo-abc123");
  const userDir = path.join(projectDir, "users", "user-1");
  await mkdir(userDir, { recursive: true });

  const currentFile = path.join(userDir, "workflow-state.ses_CURRENT.json");
  const otherFile = path.join(userDir, "workflow-state.ses_OTHER.json");

  const write = async (file, data) => writeFile(file, JSON.stringify(data, null, 2), "utf8");

  await write(otherFile, {
    currentPhase: "documentation",
    taskDescription: "Task yang tertinggal",
    projectDir: "D:\\code\\demo",
    definitionOfDone: [
      { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test -> 10 pass", revision: 0 },
      { id: "dod-2", text: "README diperbarui", status: "open", evidence: "", revision: 0 },
    ],
    dodRevision: 0,
    plan: [
      { id: "plan-1", text: "telusuri", status: "done" },
      { id: "plan-2", text: "implementasi", status: "open" },
    ],
    owner: { pid: 999999, updatedAt: Date.now() - 60 * 60 * 1000 },
    history: [],
  });

  const state = new WorkflowState(currentFile);
  await state.load();

  try {
    return await fn({ state, projectDir, userDir, currentFile, otherFile, write, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("resume_session tanpa argumen mendaftar state yang tertinggal", async () => {
  await withProject(async ({ state }) => {
    const r = await handleResumeSession({}, state);
    assert.match(text(r), /ses_OTHER/);
    assert.match(text(r), /Task yang tertinggal/);
    assert.match(text(r), /DoD: 1\/2/);
    assert.match(text(r), /Rencana: 1\/2/);
    assert.match(text(r), /bisa diambil/);
  });
});

test('resuming another task preserves pending Zettly outcomes from the target session',async()=>{
 await withProject(async({state})=>{
  state.state.zettlyOutbox=[{status:'completed',snapshot:{workflowTaskId:'pending-target-task',zettly:{todoId:42}}}];
  await handleResumeSession({adopt:'ses_OTHER'},state);
  assert.equal(state.state.zettlyOutbox.length,1);
  assert.equal(state.state.zettlyOutbox[0].snapshot.workflowTaskId,'pending-target-task');
 });
});

test("resume_session menolak mengambil task milik proses yang masih menulis", async () => {
  await withProject(async ({ state, otherFile }) => {
    await writeFile(
      otherFile,
      JSON.stringify({
        currentPhase: "coding",
        taskDescription: "Sedang dikerjakan",
        definitionOfDone: [],
        dodRevision: 0,
        plan: [],
        owner: { pid: process.pid, updatedAt: Date.now() },
      }),
      "utf8",
    );

    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /sedang dikerjakan/i);
    assert.equal(state.state.currentPhase, "idle");
  });
});

test("resume_session menyalin state dan tidak menghapus berkas asli", async () => {
  await withProject(async ({ state, otherFile }) => {
    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^✅/);
    assert.equal(state.state.taskDescription, "Task yang tertinggal");
    assert.equal(state.state.currentPhase, "documentation");
    assert.equal(state.state.definitionOfDone.length, 2);
    assert.equal(state.state.plan.length, 2);
    assert.ok(existsSync(otherFile), "berkas sumber tidak boleh dihapus");
  });
});

test("resume_session menolak bila sesi ini sedang mengerjakan task", async () => {
  await withProject(async ({ state }) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task saya sendiri";
    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /Task saya sendiri/);
  });
});

test("resume_session menyebut kunci yang tersedia saat kunci salah", async () => {
  await withProject(async ({ state }) => {
    const r = await handleResumeSession({ adopt: "ses_TIDAK_ADA" }, state);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /ses_OTHER/);
  });
});

test("findResumableCandidates mengabaikan state menganggur dan sesi ini sendiri", async () => {
  await withProject(async ({ state, userDir }) => {
    await writeFile(
      path.join(userDir, "workflow-state.ses_IDLE.json"),
      JSON.stringify({ currentPhase: "idle", taskDescription: "", definitionOfDone: [] }),
      "utf8",
    );

    const candidates = findResumableCandidates({ stateFile: state.stateFile });
    assert.deepEqual(candidates.map((c) => c.sessionKey), ["ses_OTHER"]);
  });
});
