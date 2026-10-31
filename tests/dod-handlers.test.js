import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";

/**
 * Tes untuk Definition of Done lokal.
 *
 * Janji yang diuji:
 *   1. Task tidak bisa dimulai tanpa DoD yang bisa dibuktikan.
 *   2. Item DoD tidak bisa dicentang tanpa bukti, atau dikecualikan tanpa alasan.
 *   3. Ready check, commit, dan complete menolak selama masih ada item terbuka.
 *   4. Bukti lama menjadi basi saat ada perubahan kerja baru setelah commit.
 *   5. Checklist papan Factory diimpor sebagai rencana, bukan sebagai bukti.
 */

async function withState(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "dod-handlers-"));
  const stateFile = path.join(dir, "state.json");
  const state = new WorkflowState(stateFile);
  await state.load();

  try {
    await callback(state, stateFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function call(name, args, workflowState) {
  return handleToolCall({
    request: { params: { name, arguments: args } },
    normalizeRequestArgs,
    workflowState,
    exec: async () => ({ stdout: "" }),
    git: {
      hasWorkingChanges: async () => false,
      hasStagedChanges: async () => false,
      getCurrentBranch: async () => "main",
      getPrimaryBranch: async () => "main",
      getHeadSha: async () => "a".repeat(40),
      getRemoteBranchSha: async () => "a".repeat(40),
      getLastCommitMessage: async () => "",
      getStatusOutput: async () => "",
    },
    utils: {},
  });
}

const text = (response) => response?.content?.[0]?.text || "";

// ---------------------------------------------------------------------------
// start_task wajib menyertakan DoD
// ---------------------------------------------------------------------------

test("start_task tanpa definitionOfDone ditolak dan menyebut field-nya", async () => {
  await withState(async (state) => {
    const response = await call("start_task", { description: "Kerjakan sesuatu", type: "feature" }, state);
    const out = text(response);

    assert.match(out, /definitionOfDone/);
    assert.match(out, /build lulus/, "pesan harus memberi contoh konkret");
    assert.equal(state.state.taskDescription, "", "task tidak boleh mulai");
    assert.equal(state.state.currentPhase, "idle");
  });
});

test("start_task dengan DoD kosong ditolak", async () => {
  await withState(async (state) => {
    const response = await call(
      "start_task",
      { description: "Kerjakan sesuatu", type: "feature", definitionOfDone: [] },
      state,
    );

    assert.match(text(response), /minimal satu/i);
    assert.equal(state.state.taskDescription, "");
  });
});

test("start_task menolak item duplikat", async () => {
  await withState(async (state) => {
    const response = await call(
      "start_task",
      {
        description: "Kerjakan sesuatu",
        type: "feature",
        definitionOfDone: ["Build Lulus", "build lulus"],
      },
      state,
    );

    assert.match(text(response), /duplikat/i);
    assert.equal(state.state.taskDescription, "");
  });
});

test("start_task menyimpan item DoD sebagai open dengan sumber manual", async () => {
  await withState(async (state) => {
    const response = await call(
      "start_task",
      {
        description: "Perbaiki validasi form",
        type: "bugfix",
        definitionOfDone: ["  build lulus  ", "validasi menolak input kosong"],
      },
      state,
    );

    assert.match(text(response), /Task Started/);
    assert.equal(state.state.definitionOfDone.length, 2);
    assert.deepEqual(
      state.state.definitionOfDone.map((item) => item.text),
      ["build lulus", "validasi menolak input kosong"],
    );
    assert.deepEqual(
      state.state.definitionOfDone.map((item) => item.status),
      ["open", "open"],
    );
    assert.equal(state.state.dodSource, "manual");
    assert.equal(state.state.dodRevision, 0);
  });
});
