import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
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
      processMarker: "proc-other-session",
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
    assert.equal(state.isForeignWrite({ owner: { processMarker: "proc-other-session" } }), true);
  });
});

test("isForeignWrite: false untuk token proses sendiri", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "punya saya";
    await state.save();

    const disk = await state.readDiskState();
    assert.equal(state.isForeignWrite(disk), false, "state sendiri bukan 'foreign'");
    assert.ok(disk.owner.processMarker, "owner harus tercap ke disk");
    assert.equal(disk.owner.pid, process.pid);
  });
});

// ---------------------------------------------------------------------------
// 3. save() tidak boleh menghilangkan pekerjaan sesi lain
//
// Empat tes di sini DULU menguji mekanisme "selamatkan task asing dari berkas
// bersama": `reconcileWithDisk` membaca berkas, menemukan task proses lain, dan
// mengarsipkannya ke history sebelum menimpanya. Mekanisme itu ada karena SATU
// berkas dipakai semua sesi. Sejak state disimpan per sesi di SQLite, keadaan
// "task orang lain ada di baris saya" tidak bisa terjadi lagi, sehingga tes
// terhadap penyelamatan itu hanya bisa lulus kalau bug lamanya dikembalikan.
//
// Yang dijaga sekarang adalah janji yang sama dengan cara baru: pekerjaan sesi
// lain tidak boleh hilang, dan penyimpanan berulang tidak menggandakan apa pun.
// ---------------------------------------------------------------------------

async function withTwoSessions(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "shared-rows-"));
  const dbPath = path.join(dir, "state.db");

  const make = async (sessionId) => {
    const adapter = new SqliteAdapter({ dbPath });
    await adapter.connect();
    const ws = new WorkflowState(path.join(dir, `.state-${sessionId}`, "state.json"), {
      db: adapter,
      sessionId,
    });
    await ws.load();
    return { ws, adapter };
  };

  const a = await make("ses_shared_a");
  const b = await make("ses_shared_b");
  try {
    await callback(a, b);
  } finally {
    await a.adapter.close();
    await b.adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("task sesi lain tetap utuh setelah sesi ini menyimpan", async () => {
  await withTwoSessions(async ({ ws: a }, { ws: b }) => {
    a.state.currentPhase = "coding";
    a.state.taskDescription = "Resize docker-alma 8 GB ke 4 GB";
    await a.save();

    b.state.currentPhase = "coding";
    b.state.taskDescription = "Task saya sendiri";
    await b.save();

    assert.equal(
      a.state.taskDescription,
      "Resize docker-alma 8 GB ke 4 GB",
      "task sesi A tidak boleh tersentuh oleh penyimpanan sesi B",
    );
  });
});

test("menyimpan sesi lain tidak menghapus baris sesi ini", async () => {
  await withTwoSessions(async ({ ws: a, adapter }, { ws: b }) => {
    const rowOf = (key) =>
      adapter.db
        .prepare("SELECT state_json, version FROM workflow_state WHERE session_key = ?")
        .get(key);

    a.state.currentPhase = "coding";
    a.state.taskDescription = "Task A";
    await a.save();
    const afterA = rowOf("ses_shared_a");

    b.state.currentPhase = "coding";
    b.state.taskDescription = "Task B";
    await b.save();

    const afterB = rowOf("ses_shared_a");
    assert.deepEqual(afterB, afterA, "baris sesi A harus sama persis");
  });
});

test("penyimpanan berulang tidak menggandakan baris state", async () => {
  await withTwoSessions(async ({ ws: a, adapter }) => {
    a.state.currentPhase = "coding";
    a.state.taskDescription = "Task saya";
    await a.save();
    await a.save();
    await a.save();

    const rows = adapter.db
      .prepare("SELECT count(*) c FROM workflow_state WHERE session_key = 'ses_shared_a'")
      .get().c;
    assert.equal(rows, 1, "satu sesi = satu baris, berapa kali pun menyimpan");
  });
});

test("save() tidak menyentuh baris sesi lain sama sekali", async () => {
  await withTwoSessions(async ({ ws: a, adapter }, { ws: b }) => {
    b.state.currentPhase = "idle";
    b.state.taskDescription = "";
    await b.save();
    const before = adapter.db
      .prepare("SELECT state_json, version FROM workflow_state WHERE session_key = 'ses_shared_b'")
      .get();

    a.state.currentPhase = "coding";
    a.state.taskDescription = "Task saya";
    await a.save();

    const after = adapter.db
      .prepare("SELECT state_json, version FROM workflow_state WHERE session_key = 'ses_shared_b'")
      .get();
    assert.deepEqual(after, before);
  });
});

// ---------------------------------------------------------------------------
// 4. Agen harus DIBERI TAHU
// ---------------------------------------------------------------------------

test("start_task memberi peringatan dan menyelamatkan task proses lain", async () => {
  await withState(async (state) => {
    // "Task asing" sekarang hanya bisa berarti satu hal: proses MCP KEDUA yang
    // melayani sesi yang sama. Sesi lain punya barisnya sendiri, jadi tidak ada
    // lagi yang perlu diselamatkan dari sana.
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Pekerjaan penting sesi lain";
    await state.save();

    const sessionKey = state._sessionKey().key;
    const row = state.dbAdapter.db
      .prepare("SELECT state_json FROM workflow_state WHERE session_key = ?")
      .get(sessionKey);
    const stored = JSON.parse(row.state_json);
    stored.owner = {
      processMarker: "proc-other-session",
      pid: 4242,
      updatedAt: new Date().toISOString(),
    };
    state.dbAdapter.db
      .prepare("UPDATE workflow_state SET state_json = ? WHERE session_key = ?")
      .run(JSON.stringify(stored), sessionKey);

    const response = await callTool("start_task", { description: "Task baru saya", type: "bugfix", definitionOfDone: ["task tercatat"] }, state);

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

    const response = await callTool("start_task", { description: "Task pengganti", type: "feature", definitionOfDone: ["task tercatat"] }, state);

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
    const response = await callTool("start_task", { description: "Task pertama", type: "feature", definitionOfDone: ["task tercatat"] }, state);

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
