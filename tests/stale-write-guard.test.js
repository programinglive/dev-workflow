import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleStartTask } from "../tools/handler-modules/workflow-handlers.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";

/**
 * Tes untuk bug "start_task melaporkan sukses, tetapi task-nya hilang".
 *
 * Kejadian nyata 29 Okt 2026: `start_task` menjawab "✅ Task Started" dengan
 * deskripsi yang benar, tetapi `get_workflow_status` berikutnya menampilkan
 * task LAIN yang sudah lama berjalan. Ternyata satu proses MCP yang memegang
 * state BASI menyimpan sesudahnya dan menimpa task yang baru ditulis.
 *
 * Akar masalahnya bukan "history hilang" - rekonsiliasi sudah mengarsipkan
 * task yang tertimpa. Akar masalahnya: penulis basi tetap MENANG, dan pemanggil
 * tetap diberi tahu "berhasil".
 *
 * Tiga janji yang diuji:
 *   1. Penulis basi TIDAK boleh menimpa task berjalan yang lebih baru.
 *   2. `start_task` tetap boleh mengganti task (itu memang maksudnya), dan
 *      task yang diganti tercatat di history.
 *   3. Kalau berkas berubah di antara tulis dan baca-ulang, `save()` harus
 *      MELEMPAR, bukan melaporkan sukses palsu.
 */

async function withStateFile(callback) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "stale-write-"));
  const stateFile = path.join(tempDir, "state.json");
  try {
    await callback(stateFile, tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Instance kedua di berkas yang sama, mewakili proses MCP lain. */
async function otherProcess(stateFile) {
  const ws = new WorkflowState(stateFile);
  await ws.load();
  return ws;
}

async function readDisk(stateFile) {
  return JSON.parse(await readFile(stateFile, "utf-8"));
}

test("penulis basi tidak menimpa task berjalan yang lebih baru", async () => {
  await withStateFile(async (stateFile) => {
    // Proses A memuat state kosong, lalu "tertinggal" (state-nya jadi basi).
    const stale = new WorkflowState(stateFile);
    await stale.load();

    // Proses B mengerjakan task sungguhan.
    const worker = await otherProcess(stateFile);
    worker.state.currentPhase = "coding";
    worker.state.taskDescription = "[TASK-B] pekerjaan yang benar-benar jalan";
    await worker.save();

    // Proses A (basi) menyimpan sesuatu untuk task lamanya.
    stale.state.currentPhase = "coding";
    stale.state.taskDescription = "[TASK-A] pekerjaan lama yang sudah usang";
    const reconciled = await stale.save();

    const disk = await readDisk(stateFile);
    assert.equal(
      disk.taskDescription,
      "[TASK-B] pekerjaan yang benar-benar jalan",
      "task yang lebih baru tidak boleh tertimpa oleh penulis basi",
    );
    assert.ok(
      reconciled?.conflict,
      "save() harus melaporkan konflik, bukan diam-diam menimpa",
    );
    assert.equal(reconciled.conflict.diskTask, "[TASK-B] pekerjaan yang benar-benar jalan");
    assert.equal(reconciled.conflict.staleTask, "[TASK-A] pekerjaan lama yang sudah usang");
  });
});

test("setelah konflik, instance basi memakai state dari disk", async () => {
  await withStateFile(async (stateFile) => {
    const stale = new WorkflowState(stateFile);
    await stale.load();

    const worker = await otherProcess(stateFile);
    worker.state.currentPhase = "coding";
    worker.state.taskDescription = "[TASK-B] milik proses lain";
    await worker.save();

    stale.state.taskDescription = "[TASK-A] usang";
    await stale.save();

    assert.equal(
      stale.state.taskDescription,
      "[TASK-B] milik proses lain",
      "penulis basi harus mengadopsi state terbaru supaya langkah berikutnya tidak salah task",
    );
  });
});

test("start_task tetap boleh mengganti task dan mengarsipkan yang lama", async () => {
  await withStateFile(async (stateFile) => {
    const first = new WorkflowState(stateFile);
    await first.load();
    await handleStartTask({ description: "[TASK-1] lama", type: "other", definitionOfDone: ["task tercatat"] }, first);

    // Proses lain memegang state yang masih memuat TASK-1.
    const second = await otherProcess(stateFile);
    await handleStartTask({ description: "[TASK-2] baru", type: "bugfix", definitionOfDone: ["task tercatat"] }, second);

    const disk = await readDisk(stateFile);
    assert.equal(disk.taskDescription, "[TASK-2] baru");
    assert.ok(
      (disk.history || []).some((e) => e.taskDescription === "[TASK-1] lama"),
      "task yang diganti harus tercatat di history",
    );
  });
});

test("verifyPersisted melempar kalau isi disk bukan yang kita tulis", async () => {
  await withStateFile(async (stateFile) => {
    const ws = new WorkflowState(stateFile);
    await ws.load();

    // Kita menulis TASK-KITA...
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "[KITA] seharusnya tersimpan";
    await ws.save();

    // ...lalu proses lain menimpanya sesudah kita selesai.
    const racer = await otherProcess(stateFile);
    racer.state.currentPhase = "coding";
    racer.state.taskDescription = "[RACER] menulis sesudah kita";
    await racer.save();

    const disk = await readDisk(stateFile);
    assert.equal(disk.taskDescription, "[RACER] menulis sesudah kita");

    // Verifikasi harus menyadari bahwa tulisan kita tidak bertahan.
    await assert.rejects(
      () => ws.verifyPersisted("[KITA] seharusnya tersimpan"),
      /tidak bertahan/,
      "save() tidak boleh melaporkan sukses untuk state yang sudah ditimpa",
    );
  });
});

test("penulisan normal di sesi yang sama tidak dianggap konflik", async () => {
  await withStateFile(async (stateFile) => {
    const ws = new WorkflowState(stateFile);
    await ws.load();

    await handleStartTask({ description: "[TASK] normal", type: "bugfix", definitionOfDone: ["task tercatat"] }, ws);
    ws.state.bugFixed = true;
    const reconciled = await ws.save();

    assert.equal(reconciled?.conflict, undefined, "penulisan berurutan tidak boleh dianggap konflik");
    const disk = await readDisk(stateFile);
    assert.equal(disk.taskDescription, "[TASK] normal");
    assert.equal(disk.bugFixed, true);
  });
});

function ctx(workflowState, name, args) {
  return { request: { params: { name, arguments: args } }, workflowState, normalizeRequestArgs };
}

test("tool memberi tahu bahwa aksinya TIDAK berlaku, bukan 'berhasil'", async () => {
  await withStateFile(async (stateFile) => {
    // Proses basi memegang task lamanya sendiri.
    const stale = new WorkflowState(stateFile);
    await stale.load();
    stale.state.currentPhase = "coding";
    stale.state.taskDescription = "[A] task lama yang sudah usang";
    stale.state.featureFlowCreated = true;

    // Proses lain memulai task baru sesudahnya.
    const worker = await otherProcess(stateFile);
    await handleStartTask({ description: "[B] task yang benar-benar jalan", type: "bugfix", definitionOfDone: ["task tercatat"] }, worker);

    // Proses basi menjalankan tool yang menyimpan.
    const response = await handleToolCall(
      ctx(stale, "mark_bug_fixed", { summary: "dari state basi" }),
    );
    const text = response.content[0].text;

    assert.match(text, /AKSI TIDAK BERLAKU/, "pengguna harus diberi tahu aksinya gagal");
    assert.ok(
      text.indexOf("AKSI TIDAK BERLAKU") < text.indexOf("marked as fixed"),
      "peringatan harus di DEPAN, jangan 'berhasil' dulu lalu peringatan",
    );
    assert.match(text, /\[B\] task yang benar-benar jalan/);

    const disk = await readDisk(stateFile);
    assert.equal(disk.taskDescription, "[B] task yang benar-benar jalan");
  });
});

test("tool yang tidak menyimpan tidak menampilkan peringatan", async () => {
  await withStateFile(async (stateFile) => {
    const ws = new WorkflowState(stateFile);
    await ws.load();
    await handleStartTask({ description: "[TASK] normal", type: "other", definitionOfDone: ["task tercatat"] }, ws);

    const response = await handleToolCall(ctx(ws, "get_workflow_status", {}));
    assert.doesNotMatch(response.content[0].text, /AKSI TIDAK BERLAKU/);
  });
});
