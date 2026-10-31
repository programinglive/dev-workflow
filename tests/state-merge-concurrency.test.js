import test from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";

// Kenapa tes ini ada
// ------------------
// 31 Oktober 2026, lewat MCP: `mark_bug_fixed` menjawab "✅ marked as fixed",
// lalu `create_tests` menjawab "⚠️ Please mark your feature/bug as fixed first".
// `check_ready_to_commit` sempat menyatakan SEMUA lolos, lalu `commit_and_push`
// melihat tiga langkah belum selesai. Gejalanya intermiten, jadi mudah
// disalahkan pada hal lain.
//
// Penyebabnya: OpenCode men-spawn LEBIH DARI SATU proses MCP untuk sesi yang
// sama, dan keduanya menulis berkas state yang sama. Proses yang memegang state
// basi menimpa langkah yang sudah dicapai proses lain. Penjaga yang ada
// (`detectStaleOverwrite`) hanya melindungi `taskDescription`, bukan flag
// langkah - jadi penimpaan lolos tanpa terdeteksi.
//
// Yang dikunci di sini:
//   1. flag pencapaian tidak bisa mundur karena penulis basi
//   2. gerbang kualitas (readyCheckCompleted dkk) TETAP bisa direset, karena
//      itu bagian dari alur normal dan melemahkannya berbahaya
//   3. task berbeda tidak digabung: start_task harus benar-benar mulai dari nol

async function withStateFile(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "state-race-"));
  const file = path.join(dir, "workflow-state.json");
  try {
    return await body(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Dua instance menunjuk berkas yang sama = dua proses MCP yang melayani sesi
// yang sama. Masing-masing punya memori sendiri.
async function twoWriters(file) {
  const a = new WorkflowState(file);
  const b = new WorkflowState(file);
  await a.load();
  await b.load();
  return { a, b };
}

function beginTask(state, description = "task bersama") {
  state.reset({ archive: false });
  state.state.currentPhase = "coding";
  state.state.taskDescription = description;
  state.state.taskType = "bugfix";
}

test("REGRESI: langkah yang dicapai satu proses tidak hilang karena penulis basi", async () => {
  await withStateFile(async (file) => {
    const { a, b } = await twoWriters(file);

    beginTask(a);
    await a.save({ allowReplaceRunningTask: true });

    // b memuat state yang sama, lalu keduanya berjalan sendiri-sendiri.
    await b.load();
    assert.strictEqual(b.state.bugFixed, false, "b mulai dari kondisi belum fixed");

    a.state.bugFixed = true;
    await a.save();

    // b masih memegang memori lama (bugFixed=false) dan menyimpan langkah lain.
    b.state.testsCreated = true;
    await b.save();

    const disk = new WorkflowState(file);
    await disk.load();
    assert.strictEqual(disk.state.bugFixed, true,
      "bugFixed tidak boleh mundur karena penulis basi");
    assert.strictEqual(disk.state.testsCreated, true,
      "langkah yang ditulis b tetap tercatat");
  });
});

test("REGRESI: beberapa langkah pencapaian bergabung, bukan saling menimpa", async () => {
  await withStateFile(async (file) => {
    const { a, b } = await twoWriters(file);

    beginTask(a);
    await a.save({ allowReplaceRunningTask: true });
    await b.load();

    a.state.bugFixed = true;
    await a.save();

    b.state.testsCreated = true;
    await b.save();

    // Putaran berikutnya: a menyimpan documentation, b masih basi.
    a.state.documentationCreated = true;
    await a.save();

    const disk = new WorkflowState(file);
    await disk.load();
    assert.strictEqual(disk.state.bugFixed, true);
    assert.strictEqual(disk.state.testsCreated, true);
    assert.strictEqual(disk.state.documentationCreated, true);
  });
});

test("gerbang kualitas TETAP bisa direset oleh penulis yang sah", async () => {
  // readyCheckCompleted direset `create_tests` supaya ready check diulang.
  // Kalau penggabungan memaksa nilainya true, gerbangnya jadi tidak bermakna.
  await withStateFile(async (file) => {
    const { a } = await twoWriters(file);

    beginTask(a);
    a.state.readyCheckCompleted = true;
    a.state.readyToCommit = true;
    a.state.commitAndPushCompleted = true;
    await a.save({ allowReplaceRunningTask: true });

    // Langkah baru membatalkan gerbang sebelumnya.
    a.state.readyCheckCompleted = false;
    a.state.readyToCommit = false;
    a.state.commitAndPushCompleted = false;
    await a.save();

    const disk = new WorkflowState(file);
    await disk.load();
    assert.strictEqual(disk.state.readyCheckCompleted, false,
      "gerbang harus bisa direset, bukan dipaksa true");
    assert.strictEqual(disk.state.readyToCommit, false);
    assert.strictEqual(disk.state.commitAndPushCompleted, false);
  });
});

test("task berbeda tidak digabung: start_task benar-benar mulai dari nol", async () => {
  await withStateFile(async (file) => {
    const { a } = await twoWriters(file);

    beginTask(a, "task lama");
    a.state.bugFixed = true;
    a.state.testsPassed = true;
    await a.save({ allowReplaceRunningTask: true });

    // Task baru: flag harus bersih, bukan dihidupkan kembali dari task lama.
    beginTask(a, "task baru");
    await a.save({ allowReplaceRunningTask: true });

    const disk = new WorkflowState(file);
    await disk.load();
    assert.strictEqual(disk.state.taskDescription, "task baru");
    assert.strictEqual(disk.state.bugFixed, false,
      "flag task lama tidak boleh bocor ke task baru");
    assert.strictEqual(disk.state.testsPassed, false);
  });
});

test("disk idle tidak menggabungkan apa pun", async () => {
  await withStateFile(async (file) => {
    const { a } = await twoWriters(file);

    beginTask(a, "task selesai");
    a.state.bugFixed = true;
    await a.save({ allowReplaceRunningTask: true });

    // complete_task mereset ke idle.
    a.reset({ archive: false });
    await a.save();

    const disk = new WorkflowState(file);
    await disk.load();
    assert.strictEqual(disk.state.currentPhase, "idle");
    assert.strictEqual(disk.state.bugFixed, false);
  });
});
