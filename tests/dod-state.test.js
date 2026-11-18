import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";

async function withStateFile(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "dod-state-"));
  const file = path.join(dir, "state.json");
  try {
    await callback(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("state lama tanpa field DoD dimuat sebagai daftar kosong, bukan undefined", async () => {
  await withStateFile(async (file) => {
    // Bentuk berkas yang ditulis versi sebelum fitur DoD ada.
    await writeFile(
      file,
      JSON.stringify({
        currentPhase: "coding",
        taskDescription: "Task lama",
        bugFixed: false,
      }),
    );

    const state = new WorkflowState(file);
    await state.load();

    assert.deepEqual(state.state.definitionOfDone, []);
    assert.equal(state.state.dodSource, "");
    assert.equal(state.state.dodRevision, 0);
  });
});

test("status asing di disk dinormalkan menjadi open", async () => {
  await withStateFile(async (file) => {
    await writeFile(
      file,
      JSON.stringify({
        currentPhase: "coding",
        taskDescription: "Task lama",
        definitionOfDone: [
          { id: "dod-1", text: "build lulus", status: "selesai-kok", revision: "2" },
        ],
        dodRevision: "2",
      }),
    );

    const state = new WorkflowState(file);
    await state.load();

    assert.equal(state.state.definitionOfDone[0].status, "open");
    assert.equal(state.state.definitionOfDone[0].revision, 2);
    assert.equal(state.state.dodRevision, 2);
  });
});

test("reset mengosongkan DoD supaya task berikutnya tidak mewarisi bukti", async () => {
  await withStateFile(async (file) => {
    const state = new WorkflowState(file);
    await state.load();

    state.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test", revision: 0 },
    ];
    state.state.dodRevision = 3;

    state.reset();

    assert.deepEqual(state.state.definitionOfDone, []);
    assert.equal(state.state.dodSource, "");
    assert.equal(state.state.dodRevision, 0);
  });
});

test("bukti yang dicatat satu proses tidak dihapus proses lain yang memegang state basi", async () => {
  await withStateFile(async (file) => {
    const first = new WorkflowState(file);
    await first.load();
    first.state.currentPhase = "coding";
    first.state.taskDescription = "Task yang sama";
    first.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "open", evidence: "", waivedReason: "", revision: 0, updatedAt: "" },
    ];
    await first.save();

    const second = new WorkflowState(file);
    await second.load();
    second.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test 450 pass", waivedReason: "", revision: 0, updatedAt: "" },
    ];
    await second.save();

    // Proses pertama masih memegang state lama (status open) lalu menyimpan.
    assert.equal(first.state.definitionOfDone[0].status, "open");
    await first.save();

    const disk = JSON.parse(await readFile(file, "utf-8"));
    assert.equal(disk.definitionOfDone[0].status, "done");
    assert.match(disk.definitionOfDone[0].evidence, /450 pass/);
  });
});

test("revisi DoD hanya boleh maju saat digabung", async () => {
  await withStateFile(async (file) => {
    const first = new WorkflowState(file);
    await first.load();
    first.state.currentPhase = "coding";
    first.state.taskDescription = "Task yang sama";
    first.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test", waivedReason: "", revision: 1, updatedAt: "" },
    ];
    first.state.dodRevision = 1;
    await first.save();

    const second = new WorkflowState(file);
    await second.load();
    second.state.dodRevision = 4;
    await second.save();

    // Proses pertama masih memegang revisi 1 dan menyimpan; revisi tidak boleh mundur.
    await first.save();

    const disk = JSON.parse(await readFile(file, "utf-8"));
    assert.equal(disk.dodRevision, 4);
  });
});
