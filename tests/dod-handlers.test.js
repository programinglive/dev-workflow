import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { resetToCommitIfWorkingChanges } from "../tools/handler-modules/shared.js";
import { summarize } from "../tools/handler-modules/dod.js";

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

// ---------------------------------------------------------------------------
// set_definition_of_done
// ---------------------------------------------------------------------------

test("set_definition_of_done ditolak kalau belum ada task aktif", async () => {
  await withState(async (state) => {
    const response = await call("set_definition_of_done", { items: ["build lulus"] }, state);

    assert.match(text(response), /No active task/);
    assert.deepEqual(state.state.definitionOfDone, []);
  });
});

test("set_definition_of_done mengisi daftar task yang belum punya DoD", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task lama tanpa DoD";

    const response = await call(
      "set_definition_of_done",
      { items: ["build lulus", "migrasi aman"] },
      state,
    );

    assert.match(text(response), /disusun: 2 item/);
    assert.deepEqual(
      state.state.definitionOfDone.map((item) => item.text),
      ["build lulus", "migrasi aman"],
    );
    assert.equal(state.state.dodSource, "manual");
  });
});

test("set_definition_of_done menolak mengganti daftar yang sudah punya bukti", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task dengan bukti";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const response = await call("set_definition_of_done", { items: ["kondisi lain"] }, state);

    assert.match(text(response), /membuang bukti/i);
    assert.match(text(response), /append/);
    assert.equal(state.state.definitionOfDone.length, 1, "bukti tidak boleh hilang");
    assert.equal(state.state.definitionOfDone[0].status, "done");
  });
});

test("set_definition_of_done dengan append menambah tanpa membuang bukti", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task dengan bukti";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const response = await call(
      "set_definition_of_done",
      { items: ["migrasi aman"], append: true },
      state,
    );

    assert.match(text(response), /ditambah: 2 item/);
    assert.deepEqual(
      state.state.definitionOfDone.map((item) => item.text),
      ["build lulus", "migrasi aman"],
    );
    assert.equal(state.state.definitionOfDone[0].status, "done");
    assert.equal(state.state.definitionOfDone[1].status, "open");
    assert.equal(state.state.definitionOfDone[1].id, "dod-2");
  });
});

test("set_definition_of_done menolak total di atas 20 item", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task panjang";
    state.state.definitionOfDone = Array.from({ length: 20 }, (_, index) => ({
      id: `dod-${index + 1}`,
      text: `kondisi ${index + 1}`,
      status: "open",
      evidence: "",
      waivedReason: "",
      revision: 0,
      updatedAt: "",
    }));

    const response = await call("set_definition_of_done", { items: ["kondisi ekstra"], append: true }, state);

    assert.match(text(response), /melebihi batas 20/);
    assert.equal(state.state.definitionOfDone.length, 20);
  });
});

// ---------------------------------------------------------------------------
// mark_dod_item
// ---------------------------------------------------------------------------

test("mark_dod_item menolak item tanpa bukti", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "open", evidence: "", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const without = await call("mark_dod_item", { id: "dod-1" }, state);
    assert.match(text(without), /evidence/);
    assert.equal(state.state.definitionOfDone[0].status, "open");

    const tooShort = await call("mark_dod_item", { id: "dod-1", evidence: "ok" }, state);
    assert.match(text(tooShort), /5-500/);
    assert.equal(state.state.definitionOfDone[0].status, "open");
  });
});

test("mark_dod_item menyimpan bukti dan membuka jalur berikutnya", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task";
    state.state.readyCheckCompleted = true;
    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "open", evidence: "", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const response = await call("mark_dod_item", { id: "dod-1", evidence: "npm test 482 pass" }, state);

    assert.match(text(response), /terbukti/);
    assert.equal(state.state.definitionOfDone[0].status, "done");
    assert.equal(state.state.definitionOfDone[0].evidence, "npm test 482 pass");
    assert.equal(state.state.definitionOfDone[0].revision, state.state.dodRevision);
    assert.equal(state.state.readyCheckCompleted, false, "ready check harus diulang");
  });
});

test("mark_dod_item idempoten dan menyegarkan bukti", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", evidence: "bukti lama", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const response = await call("mark_dod_item", { id: "dod-1", evidence: "bukti baru yang lebih lengkap" }, state);

    assert.match(text(response), /terbukti/);
    assert.equal(state.state.definitionOfDone[0].evidence, "bukti baru yang lebih lengkap");
  });
});

test("mark_dod_item menolak item yang sudah dikecualikan", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "deploy staging", status: "waived", evidence: "", waivedReason: "staging mati", revision: 0, updatedAt: "" },
    ];

    const response = await call("mark_dod_item", { id: "dod-1", evidence: "sudah dicoba" }, state);

    assert.match(text(response), /dikecualikan/);
    assert.equal(state.state.definitionOfDone[0].status, "waived");
  });
});

test("mark_dod_item menyebut id yang tersedia saat id tidak dikenal", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task";
    state.state.definitionOfDone = [
      { id: "dod-7", text: "build lulus", status: "open", evidence: "", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const response = await call("mark_dod_item", { id: "dod-1", evidence: "npm test" }, state);

    assert.match(text(response), /dod-7/);
  });
});

// ---------------------------------------------------------------------------
// waive_dod_item
// ---------------------------------------------------------------------------

test("waive_dod_item mencatat alasan", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "deploy staging", status: "open", evidence: "", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const response = await call(
      "waive_dod_item",
      { id: "dod-1", reason: "staging sedang maintenance sampai besok" },
      state,
    );

    assert.match(text(response), /dikecualikan/);
    assert.equal(state.state.definitionOfDone[0].status, "waived");
    assert.match(state.state.definitionOfDone[0].waivedReason, /maintenance/);
  });
});

test("waive_dod_item menolak alasan kosong", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "deploy staging", status: "open", evidence: "", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const response = await call("waive_dod_item", { id: "dod-1", reason: "  " }, state);

    assert.match(text(response), /reason/);
    assert.equal(state.state.definitionOfDone[0].status, "open");
  });
});

test("waive_dod_item menolak item yang sudah terbukti", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    state.state.taskDescription = "Task";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const response = await call("waive_dod_item", { id: "dod-1", reason: "tidak perlu lagi" }, state);

    assert.match(text(response), /sudah terbukti/);
    assert.equal(state.state.definitionOfDone[0].status, "done");
  });
});

// ---------------------------------------------------------------------------
// Gerbang: ready check, commit, complete
// ---------------------------------------------------------------------------

async function readyState(state) {
  state.state.currentPhase = "ready";
  state.state.taskDescription = "Task siap";
  state.state.featureFlowCreated = true;
  state.state.bugFixed = true;
  state.state.testsCreated = true;
  state.state.testsPassed = true;
  state.state.documentationCreated = true;
}

test("ready check menolak selama masih ada item DoD terbuka", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "coding";
    await call("start_task", {
      description: "Task siap",
      type: "feature",
      definitionOfDone: ["build lulus", "login terverifikasi"],
    }, state);
    await readyState(state);

    const blocked = await call("check_ready_to_commit", {}, state);
    assert.match(text(blocked), /❌ Definition of done satisfied/);
    assert.match(text(blocked), /NOT READY/);
    assert.equal(state.state.readyCheckCompleted, false);

    await call("mark_dod_item", { id: "dod-1", evidence: "npm test 482 pass" }, state);
    await call("mark_dod_item", { id: "dod-2", evidence: "login dicoba di tenant nyata" }, state);

    const passed = await call("check_ready_to_commit", {}, state);
    assert.match(text(passed), /ALL CHECKS PASSED/);
    assert.match(text(passed), /✅ Definition of done satisfied/);
    assert.equal(state.state.readyCheckCompleted, true);
  });
});

test("ready check menolak task yang belum punya item DoD sama sekali", async () => {
  await withState(async (state) => {
    await readyState(state);
    state.state.definitionOfDone = [];

    const response = await call("check_ready_to_commit", {}, state);

    assert.match(text(response), /❌ Definition of done recorded/);
    assert.match(text(response), /set_definition_of_done/);
  });
});

test("commit_and_push menolak dan menyebut item yang masih terbuka", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "commit";
    state.state.taskDescription = "Task";
    state.state.readyToCommit = true;
    state.state.readyCheckCompleted = true;
    state.state.definitionOfDone = [
      { id: "dod-3", text: "migrasi bisa di-rollback", status: "open", evidence: "", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const commands = [];
    const response = await handleToolCall({
      request: { params: { name: "commit_and_push", arguments: { commitMessage: "feat: x" } } },
      normalizeRequestArgs,
      workflowState: state,
      exec: async (command) => {
        commands.push(command);
        return { stdout: "" };
      },
      git: {
        hasWorkingChanges: async () => true,
        hasStagedChanges: async () => false,
        getCurrentBranch: async () => "main",
        getPrimaryBranch: async () => "main",
        getStatusOutput: async () => "M tests/x.test.js",
      },
      utils: {},
    });

    assert.match(text(response), /dod-3/);
    assert.match(text(response), /migrasi bisa di-rollback/);
    assert.equal(commands.length, 0, "tidak boleh ada git add sebelum DoD terpenuhi");
  });
});

test("complete_task menolak selama item DoD terbuka", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "ready_to_complete";
    state.state.taskDescription = "Task";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "open", evidence: "", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const response = await call("complete_task", { commitMessage: "feat: x" }, state);

    assert.match(text(response), /dod-1/);
    assert.equal(state.state.currentPhase, "ready_to_complete", "task tidak boleh ditutup");
    assert.equal(state.state.history.length, 0);
  });
});

test("complete_task menerima setelah semua item terpenuhi dan mencatat dodSummary", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "ready_to_complete";
    state.state.taskDescription = "Task";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test", waivedReason: "", revision: 0, updatedAt: "" },
      { id: "dod-2", text: "deploy staging", status: "waived", evidence: "", waivedReason: "staging mati", revision: 0, updatedAt: "" },
    ];

    const response = await call("complete_task", { commitMessage: "feat: x" }, state);

    assert.match(text(response), /Task completed/);
    assert.equal(state.state.currentPhase, "idle");
    const entry = state.state.history.at(-1);
    assert.equal(entry.definitionOfDoneSummary.done, 1);
    assert.equal(entry.definitionOfDoneSummary.waived, 1);
    assert.deepEqual(entry.definitionOfDoneSummary.waivedReasons, ["staging mati"]);
  });
});

test("force_complete_task tetap bisa menutup dan mencatat alasannya", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "ready_to_complete";
    state.state.taskDescription = "Task";
    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "open", evidence: "", waivedReason: "", revision: 0, updatedAt: "" },
    ];

    const response = await call(
      "force_complete_task",
      { commitMessage: "feat: x", reason: "klien minta segera rilis" },
      state,
    );

    assert.match(text(response), /force-completed/);
    const entry = state.state.history.at(-1);
    assert.equal(entry.forced, true);
    assert.equal(entry.forceReason, "klien minta segera rilis");
    assert.equal(entry.definitionOfDoneSummary.open, 1);
  });
});

test("perubahan kerja baru setelah commit membuat bukti lama basi, waive tetap bertahan", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "release";
    state.state.taskDescription = "Task";
    state.state.commitAndPushCompleted = true;
    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test", waivedReason: "", revision: 0, updatedAt: "" },
      { id: "dod-2", text: "deploy staging", status: "waived", evidence: "", waivedReason: "staging mati", revision: 0, updatedAt: "" },
    ];

    const changed = await resetToCommitIfWorkingChanges(state, {
      hasWorkingChanges: async () => true,
      hasStagedChanges: async () => false,
    });

    assert.equal(changed, true);
    assert.equal(state.state.dodRevision, 1, "revisi harus naik");

    const summary = summarize(state.state.definitionOfDone, state.state.dodRevision);
    assert.equal(summary.done, 0, "bukti lama tidak lagi berlaku");
    assert.equal(summary.open, 1);
    assert.equal(summary.waived, 1, "waive bukan bukti, jadi bertahan");

    await call("mark_dod_item", { id: "dod-1", evidence: "npm test diulang setelah perubahan" }, state);
    assert.equal(summarize(state.state.definitionOfDone, state.state.dodRevision).open, 0);
  });
});
