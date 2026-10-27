import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";

/**
 * Tes untuk bug state workflow yang DIPAKAI BERSAMA antar sesi agen.
 *
 * Kejadian nyata 26-27 Okt 2026: `start_task` di satu sesi menghapus state sesi
 * lain, dan task yang sedang berjalan lenyap tanpa jejak karena `history` hanya
 * ditulis saat task DITUTUP. Akibatnya pekerjaan resize docker-alma tidak pernah
 * muncul di view_history, dan agen nyaris meng-commit atas nama task orang lain.
 *
 * Yang diuji di sini bukan "fungsi bisa jalan", melainkan tiga janji:
 *   1. Pekerjaan yang tertimpa TIDAK hilang tanpa jejak.
 *   2. `reset()` tanpa opsi tidak menambah history (complete_task sudah menulis
 *      sendiri - kalau reset ikut mengarsipkan, entri jadi ganda).
 *   3. Agen DIBERI TAHU ketika state terakhir ditulis proses lain.
 */

async function withState(callback) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "shared-state-"));
  const stateFile = path.join(tempDir, "state.json");
  const state = new WorkflowState(stateFile);
  await state.load();

  try {
    await callback(state, stateFile);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Tulis berkas state seolah-olah proses MCP LAIN yang menulisnya. */
async function writeForeignState(stateFile, overrides = {}) {
  const payload = {
    currentPhase: "coding",
    taskDescription: "Pekerjaan sesi lain yang sedang berjalan",
    taskType: "feature",
    lastCommitMessage: "",
    history: [],
    owner: {
      token: "proc-other-session",
      pid: 4242,
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  };
  await writeFile(stateFile, JSON.stringify(payload, null, 2));
  return payload;
}

function createRequest(name, args) {
  return { params: { name, arguments: args } };
}

/** Bentuk pemanggilan yang sama dengan index.js: { request, normalizeRequestArgs, ... }. */
function callTool(name, args, workflowState) {
  return handleToolCall({
    request: createRequest(name, args),
    normalizeRequestArgs,
    workflowState,
  });
}

function responseText(response) {
  return response?.content?.[0]?.text || "";
}

// ---------------------------------------------------------------------------
// 1. reset() harus tetap kompatibel dengan complete_task
// ---------------------------------------------------------------------------

test("reset() tanpa opsi tidak menambah history (kompatibel dengan complete_task)", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "ready";
    state.state.taskDescription = "Task yang sudah selesai";
    state.addToHistory({ taskDescription: "Task yang sudah selesai", commitMessage: "abc" });

    state.reset();

    assert.equal(state.state.history.length, 1, "tidak boleh ada entri tambahan");
    assert.equal(state.state.history[0].interrupted, undefined);
  });
});

test("reset({archive:true}) menyimpan task berjalan sebagai interrupted", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task yang belum selesai";
    state.state.taskType = "feature";

    const result = state.reset({ archive: true });

    assert.equal(result.archivedTask, "Task yang belum selesai");
    assert.equal(state.state.history.length, 1);
    const entry = state.state.history[0];
    assert.equal(entry.taskDescription, "Task yang belum selesai");
    assert.equal(entry.interrupted, true);
    assert.equal(entry.interruptedAtPhase, "coding");
    assert.match(entry.dropReason, /start_task/);
    // state sendiri harus bersih
    assert.equal(state.state.currentPhase, "idle");
    assert.equal(state.state.taskDescription, "");
  });
});

test("reset({archive:true}) tidak mengarsipkan apa pun saat idle", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "idle";
    state.state.taskDescription = "";

    const result = state.reset({ archive: true });

    assert.equal(result.archivedTask, null);
    assert.equal(state.state.history.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Deteksi proses lain
// ---------------------------------------------------------------------------

test("isForeignWrite: false untuk state yang belum punya owner", async () => {
  await withState(async (state) => {
    assert.equal(state.isForeignWrite({ taskDescription: "x" }), false);
    assert.equal(state.isForeignWrite(null), false);
  });
});

test("isForeignWrite: true untuk token proses lain", async () => {
  await withState(async (state) => {
    assert.equal(state.isForeignWrite({ owner: { token: "proc-other-session" } }), true);
  });
});

test("isForeignWrite: false untuk token proses sendiri", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "punya saya";
    await state.save();

    const disk = await state.readDiskState();
    assert.equal(state.isForeignWrite(disk), false, "state sendiri bukan 'foreign'");
    assert.ok(disk.owner.token, "owner harus tercap ke disk");
    assert.equal(disk.owner.pid, process.pid);
  });
});

// ---------------------------------------------------------------------------
// 3. save() menyelamatkan pekerjaan proses lain
// ---------------------------------------------------------------------------

test("save() menyelamatkan task berjalan milik proses lain sebelum menimpanya", async () => {
  await withState(async (state, stateFile) => {
    await writeForeignState(stateFile, {
      taskDescription: "Resize docker-alma 8 GB ke 4 GB",
      currentPhase: "testing",
    });

    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task saya sendiri";
    const reconciled = await state.save();

    assert.equal(reconciled.preservedTask, "Resize docker-alma 8 GB ke 4 GB");

    const preserved = state.state.history.find(
      (entry) => entry.taskDescription === "Resize docker-alma 8 GB ke 4 GB"
    );
    assert.ok(preserved, "task proses lain harus ada di history");
    assert.equal(preserved.interrupted, true);
    assert.equal(preserved.interruptedAtPhase, "testing");
    assert.equal(preserved.interruptedBy, "proc-other-session");
  });
});

test("save() menggabungkan history proses lain, bukan membuangnya", async () => {
  await withState(async (state, stateFile) => {
    const foreignEntry = {
      taskDescription: "Task yang sudah selesai di sesi lain",
      commitMessage: "feat: sesuatu",
      timestamp: "2026-10-26T10:00:00.000Z",
    };
    await writeForeignState(stateFile, { history: [foreignEntry] });

    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task saya";
    const reconciled = await state.save();

    assert.equal(reconciled.mergedHistory, 1);
    assert.ok(
      state.state.history.some(
        (entry) => entry.taskDescription === "Task yang sudah selesai di sesi lain"
      ),
      "history proses lain harus ikut"
    );
  });
});

test("arsip tidak dobel walau save() dipanggil berulang", async () => {
  await withState(async (state, stateFile) => {
    await writeForeignState(stateFile, { taskDescription: "Task asing" });

    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task saya";
    await state.save();
    const firstCount = state.state.history.filter((e) => e.interrupted).length;

    await state.save();
    await state.save();
    const laterCount = state.state.history.filter((e) => e.interrupted).length;

    assert.equal(firstCount, 1);
    assert.equal(laterCount, 1, "tidak boleh menumpuk arsip yang sama");
  });
});

test("save() tidak mengarsipkan task asing yang sudah idle", async () => {
  await withState(async (state, stateFile) => {
    await writeForeignState(stateFile, { currentPhase: "idle", taskDescription: "" });

    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task saya";
    const reconciled = await state.save();

    assert.equal(reconciled.preservedTask, null);
    assert.equal(state.state.history.filter((e) => e.interrupted).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Agen harus DIBERI TAHU
// ---------------------------------------------------------------------------

test("start_task memberi peringatan dan menyelamatkan task proses lain", async () => {
  await withState(async (state, stateFile) => {
    await writeForeignState(stateFile, {
      taskDescription: "Pekerjaan penting sesi lain",
    });

    const response = await callTool("start_task", { description: "Task baru saya", type: "bugfix" }, state);

    const text = responseText(response);
    assert.match(text, /Task Started: Task baru saya/);
    assert.match(text, /proses agen lain/i, "harus ada peringatan");
    assert.match(text, /Pekerjaan penting sesi lain/, "task asing harus disebut namanya");
    assert.match(text, /interrupted/);

    assert.ok(
      state.state.history.some(
        (entry) => entry.interrupted && entry.taskDescription === "Pekerjaan penting sesi lain"
      )
    );
    assert.equal(state.state.taskDescription, "Task baru saya");
  });
});

test("start_task memberi tahu kalau task sebelumnya belum selesai", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task lama yang belum selesai";
    await state.save();

    const response = await callTool("start_task", { description: "Task pengganti", type: "feature" }, state);

    const text = responseText(response);
    assert.match(text, /Task lama yang belum selesai/);
    assert.match(text, /interrupted/);
    assert.ok(
      state.state.history.some(
        (entry) => entry.interrupted && entry.taskDescription === "Task lama yang belum selesai"
      )
    );
  });
});

test("start_task tanpa task sebelumnya tidak menampilkan peringatan", async () => {
  await withState(async (state) => {
    const response = await callTool("start_task", { description: "Task pertama", type: "feature" }, state);

    const text = responseText(response);
    assert.doesNotMatch(text, /proses agen lain/i);
    assert.doesNotMatch(text, /interrupted/);
    assert.equal(state.state.history.length, 0);
  });
});

test("get_workflow_status memperingatkan saat state ditulis proses lain", async () => {
  await withState(async (state, stateFile) => {
    await writeForeignState(stateFile, {
      taskDescription: "Task milik proses lain",
      currentPhase: "coding",
    });

    const response = await callTool("get_workflow_status", {}, state);

    const text = responseText(response);
    assert.match(text, /PERINGATAN/);
    assert.match(text, /proses MCP LAIN/);
    assert.match(text, /Task milik proses lain/);
  });
});

test("get_workflow_status tidak memperingatkan untuk state sendiri", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task saya";
    await state.save();

    const response = await callTool("get_workflow_status", {}, state);

    const text = responseText(response);
    assert.doesNotMatch(text, /PERINGATAN/);
    assert.match(text, /Task saya/);
  });
});
