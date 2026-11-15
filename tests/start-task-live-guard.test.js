import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleStartTask } from "../tools/handler-modules/workflow-handlers.js";
import { setIsAliveForTests } from "../process-lock.js";

const text = (response) => response.content[0].text;

const args = (extra = {}) => ({
  description: "task baru",
  type: "feature",
  projectDir: undefined,
  definitionOfDone: ["build lulus"],
  ...extra,
});

/**
 * `start_task` tidak boleh menghapus task yang sedang berjalan di proses LAIN.
 *
 * 1 November 2026 satu sesi kehilangan seluruh DoD-nya dua kali dalam satu jam.
 * Penjaga `activeForeignLock` sebenarnya sudah ada, tetapi `force: true` bisa
 * melewatinya - dan `start_task` memanggil `reset()` yang mengosongkan
 * `definitionOfDone` milik task tersebut. Bukti DoD yang sudah dikumpulkan tidak
 * bisa dipulihkan dari arsip `history`.
 */
async function withState(diskState) {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-guard-"));
  const file = path.join(dir, "state.json");
  if (diskState) {
    await writeFile(file, JSON.stringify(diskState), "utf8");
  }
  const state = new WorkflowState(file);
  await state.load();
  return {
    state,
    file,
    cleanup: async () => {
      await state.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const liveTask = (overrides = {}) => ({
  currentPhase: "coding",
  taskDescription: "task sesi lain",
  taskType: "feature",
  projectDir: "D:\\code\\proyek-lain",
  definitionOfDone: [
    { id: "dod-1", text: "bukti milik sesi lain", status: "done", evidence: "npm test -> 42 pass", revision: 0 },
  ],
  dodRevision: 0,
  owner: { processMarker: "proc-99999-lain", pid: 99999, updatedAt: Date.now() },
  ...overrides,
});

test("start_task menolak menghapus task aktif milik proses hidup", async () => {
  const { state, cleanup } = await withState(liveTask());
  try {
    setIsAliveForTests(() => true);
    const r = await handleStartTask(args(), state, null);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /task sesi lain/);
    // DoD milik sesi lain harus utuh.
    assert.equal(state.state.definitionOfDone[0].text, "bukti milik sesi lain");
  } finally {
    setIsAliveForTests(null);
    await cleanup();
  }
});

test("force tidak bisa melewati penjaga task hidup", async () => {
  const { state, cleanup } = await withState(liveTask());
  try {
    setIsAliveForTests(() => true);
    const r = await handleStartTask(args({ force: true }), state, null);
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /force/i);
    assert.equal(state.state.taskDescription, "task sesi lain");
    assert.equal(state.state.definitionOfDone[0].text, "bukti milik sesi lain");
  } finally {
    setIsAliveForTests(null);
    await cleanup();
  }
});

test("start_task boleh jalan bila pemilik task sudah mati", async () => {
  const { state, cleanup } = await withState(liveTask());
  try {
    setIsAliveForTests(() => false);
    const r = await handleStartTask(args({ force: true }), state, null);
    assert.match(text(r), /Task Started/);
    assert.equal(state.state.taskDescription, "task baru");
  } finally {
    setIsAliveForTests(null);
    await cleanup();
  }
});

test("penjaga berhenti menghalangi setelah pemilik lama tidak menulis state", async () => {
  // Keadaan normal di mesin ini: proses MCP lama tetap hidup berjam-jam setelah
  // jendela OpenCode-nya ditutup. Tanpa batas basi, penjaga memblokir SELAMANYA
  // dan `force` pun tidak menolong - penjaga yang mustahil dilewati akan
  // dilewati orang dengan membunuh proses.
  const { state, cleanup } = await withState(
    liveTask({ owner: { processMarker: "proc-99999-lain", pid: 99999, updatedAt: Date.now() - 60 * 60 * 1000 } }),
  );
  try {
    setIsAliveForTests(() => true);
    const r = await handleStartTask(args(), state, null);
    assert.match(text(r), /Task Started/);
    assert.equal(state.state.taskDescription, "task baru");
  } finally {
    setIsAliveForTests(null);
    await cleanup();
  }
});

test("start_task boleh jalan bila state menganggur", async () => {
  const { state, cleanup } = await withState({
    currentPhase: "idle",
    taskDescription: "",
    owner: { processMarker: "proc-99999-lain", pid: 99999 },
  });
  try {
    const r = await handleStartTask(args(), state, null);
    assert.match(text(r), /Task Started/);
    assert.equal(state.state.taskDescription, "task baru");
  } finally {
    await cleanup();
  }
});

test("start_task boleh jalan bila task di disk milik proses ini sendiri", async () => {
  const { state, cleanup } = await withState(liveTask({ owner: { processMarker: "", pid: process.pid } }));
  try {
    const r = await handleStartTask(args(), state, null);
    assert.match(text(r), /Task Started/);
  } finally {
    await cleanup();
  }
});
