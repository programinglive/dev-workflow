import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleResumeSession, findResumableCandidates } from "../tools/handler-modules/resume-handlers.js";
import { writeHandshake, tryClaimHandshake, markClaimAdopted } from "../monitor-server/restart-handshake-store.cjs";

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
  // Adoption acquires the worktree mutex, which is keyed by canonical Git
  // working-tree identity, so the fixture project must be a real worktree.
  execFileSync("git", ["init", "-q", projectDir], { windowsHide: true });

  const currentFile = path.join(userDir, "workflow-state.ses_CURRENT.json");
  const otherFile = path.join(userDir, "workflow-state.ses_OTHER.json");

  const write = async (file, data) => writeFile(file, JSON.stringify(data, null, 2), "utf8");

  await write(otherFile, {
    currentPhase: "documentation",
    taskDescription: "Task yang tertinggal",
    // A real worktree path: adoption now acquires the worktree mutex, and a
    // recorded projectDir that does not exist cannot be owned.
    projectDir,
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
  // A real session knows the worktree it runs in; the fixture must too, or the
  // cross-project guard compares against the test runner's cwd.
  state.state.projectDir = projectDir;

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

test("adoption binds the worktree mutex so the new owner can save", async () => {
  await withProject(async ({ state }) => {
    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^✅/);
    assert.ok(state.boundKernelCapability, "adoption must bind the worktree capability");
    // A guarded write after adoption must succeed: this is what a checkpoint does.
    state.state.taskDescription = "Task yang tertinggal";
    await assert.doesNotReject(() => state.save());
  });
});

test("adoption is refused while another owner still holds the worktree", async () => {
  const { acquireWorktreeMutex, releaseWorktreeMutex } = await import("../process-lock.js");
  await withProject(async ({ state, projectDir, otherFile }) => {
    const held = await acquireWorktreeMutex({ projectDir, ownerKey: "other-live-owner" });
    assert.equal(held.ok, true);
    try {
      const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
      assert.match(text(r), /^⚠️/);
      assert.match(text(r), /refus/i);
      // Nothing changed: the current session did not inherit the task.
      assert.equal(state.state.currentPhase, "idle");
      assert.ok(existsSync(otherFile));
    } finally {
      await releaseWorktreeMutex(held.capability);
    }
  });
});

/**
 * A handover is a fenced transfer, not a generic left-behind session. Only the
 * winning claimant may adopt it, and only after the controller proved the old
 * owner exited.
 */
async function withHandover(fn) {
  return withProject(async (ctx) => {
    const { state, otherFile } = ctx;
    state.sessionId = "ses_CURRENT";
    const sidecar = `${otherFile}.restart-handshake.json`;
    writeHandshake(otherFile, {
      state: "PROCESS_EXIT_VERIFIED",
      history: [],
      handover: { sessionKey: "ses_OTHER", machine: "CANARY", projectDir: ctx.projectDir, todoId: 1, snapshot: { taskDescription: "Task yang tertinggal", workflowTaskId: null, todoId: 1, phase: "documentation", dodRevision: 0 } },
    });
    return fn({ ...ctx, sidecar });
  });
}

test("adoption of a handover is refused without a claim", async () => {
  await withHandover(async ({ state }) => {
    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /no claim/i);
    assert.equal(state.state.currentPhase, "idle");
  });
});

test("adoption of a handover is refused for a session that did not win the claim", async () => {
  await withHandover(async ({ state, sidecar }) => {
    tryClaimHandshake(sidecar, { sessionKey: "ses_WINNER", at: Date.now(), pid: 1, generation: 1 });
    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /ses_WINNER/);
    assert.equal(state.state.currentPhase, "idle");
  });
});

test("adoption of an already adopted handover is refused", async () => {
  await withHandover(async ({ state, sidecar }) => {
    tryClaimHandshake(sidecar, { sessionKey: "ses_CURRENT", at: Date.now(), pid: 1, generation: 1 });
    markClaimAdopted(sidecar, { sessionKey: "ses_CURRENT" });
    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /already adopted/i);
    assert.equal(state.state.currentPhase, "idle");
  });
});

test("the winning claimant adopts the handover and the claim is marked adopted", async () => {
  await withHandover(async ({ state, sidecar }) => {
    tryClaimHandshake(sidecar, { sessionKey: "ses_CURRENT", at: Date.now(), pid: process.pid, generation: 1 });
    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^✅/);
    assert.equal(state.state.taskDescription, "Task yang tertinggal");
    const { readClaim } = await import("../monitor-server/restart-handshake-store.cjs");
    assert.ok(readClaim(sidecar).adoptedAt, "the claim is marked adopted");
  });
});

test("adoption is refused when the claim belongs to another process", async () => {
  await withHandover(async ({ state, sidecar }) => {
    tryClaimHandshake(sidecar, { sessionKey: "ses_CURRENT", at: Date.now(), pid: process.pid + 1, generation: 1 });
    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /PID/);
    assert.equal(state.state.currentPhase, "idle");
  });
});

test("adoption replaces an existing successor row instead of reloading it", async () => {
  await withProject(async ({ state }) => {
    // The successor already has its own stored state. Adoption must replace it,
    // not silently reload the old row and report success.
    state.state.currentPhase = "idle";
    state.state.taskDescription = "Old successor task";
    await state.save();

    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^✅/);
    assert.equal(state.state.taskDescription, "Task yang tertinggal");
    assert.equal(state.state.currentPhase, "documentation");
  });
});

test("adoption refuses a sidecar that names a different session", async () => {
  await withHandover(async ({ state, sidecar }) => {
    tryClaimHandshake(sidecar, { sessionKey: "ses_CURRENT", at: Date.now(), pid: process.pid, generation: 1 });
    const { readHandshake, writeHandshake } = await import("../monitor-server/restart-handshake-store.cjs");
    const rec = readHandshake(sidecar).record;
    writeHandshake(sidecar, { ...rec, handover: { ...rec.handover, sessionKey: "ses_SOMETHING_ELSE" } });
    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /ses_SOMETHING_ELSE/);
    assert.equal(state.state.currentPhase, "idle");
  });
});

test("adoption refuses a source state that no longer matches the checkpointed snapshot", async () => {
  await withHandover(async ({ state, sidecar, otherFile }) => {
    tryClaimHandshake(sidecar, { sessionKey: "ses_CURRENT", at: Date.now(), pid: process.pid, generation: 1 });
    // The source file changed after the owner checkpointed it.
    const src = JSON.parse(await readFile(otherFile, "utf8"));
    src.taskDescription = "A different task";
    await writeFile(otherFile, JSON.stringify(src, null, 2));
    const r = await handleResumeSession({ adopt: "ses_OTHER" }, state);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /snapshot/i);
    assert.equal(state.state.currentPhase, "idle");
  });
});
