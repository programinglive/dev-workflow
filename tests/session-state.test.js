import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState, resolveStateFile, resolveHistoryFile, resolveProjectRootForState } from "../workflow-state.js";

/**
 * Tes untuk pemisahan state PER SESI.
 *
 * Masalah nyata 28 Okt 2026: empat proses MCP berbagi satu
 * `workflow-state.json`. Akibatnya `start_task` di satu sesi mengganti task
 * sesi lain di tengah jalan (8 entri `interrupted` di history), dan gerbang
 * kualitas ikut dibagi sehingga sesi B bisa memakai `readyCheckCompleted`
 * milik sesi A untuk commit.
 *
 * Janji yang diuji di sini:
 *   1. Task yang sedang dikerjakan milik SESI, bukan milik mesin.
 *   2. Gerbang kualitas (ready check, tests, docs) juga milik sesi.
 *   3. `history` tetap milik PROYEK - task yang selesai di satu sesi harus
 *      terlihat dari sesi lain.
 *   4. Pemanggil yang memberi path eksplisit tetap memakai satu berkas
 *      (kompatibel dengan pemakaian lama dan tes lain).
 */

const originalCwd = process.cwd();
const originalSessionId = process.env.DEV_WORKFLOW_SESSION_ID;
const originalOpencodeSession = process.env.OPENCODE_SESSION_ID;
const originalStateFile = process.env.DEV_WORKFLOW_STATE_FILE;
const originalUserId = process.env.DEV_WORKFLOW_USER_ID;

async function withProject(callback) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "session-state-"));
  // findProjectRoot mencari penanda proyek; package.json sudah cukup.
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "fixture" }));

  // Adapter DB adalah singleton dengan handle SQLite terbuka, dan Windows
  // mengunci direktori yang memuatnya. Arahkan ke luar projectRoot supaya
  // pembersihan direktori tes tidak gagal karena hal yang tidak diuji di sini.
  if (!process.env.DEV_WORKFLOW_DB_PATH) {
    process.env.DEV_WORKFLOW_DB_PATH = path.join(tmpdir(), `session-state-tests-${process.pid}.db`);
  }

  delete process.env.DEV_WORKFLOW_STATE_FILE;
  delete process.env.OPENCODE_SESSION_ID;
  process.env.DEV_WORKFLOW_USER_ID = "user-test";
  process.chdir(projectRoot);

  try {
    await callback(projectRoot);
  } finally {
    process.chdir(originalCwd);
    if (originalUserId === undefined) delete process.env.DEV_WORKFLOW_USER_ID;
    else process.env.DEV_WORKFLOW_USER_ID = originalUserId;
    if (originalSessionId === undefined) delete process.env.DEV_WORKFLOW_SESSION_ID;
    else process.env.DEV_WORKFLOW_SESSION_ID = originalSessionId;
    if (originalOpencodeSession === undefined) delete process.env.OPENCODE_SESSION_ID;
    else process.env.OPENCODE_SESSION_ID = originalOpencodeSession;
    if (originalStateFile === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = originalStateFile;
    // SQLite menahan berkas db-nya sebentar setelah ditulis; beri kesempatan
    // retry sebelum menyimpulkan tes gagal karena pembersihan.
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Membuat WorkflowState untuk sesi tertentu, seperti proses MCP sesi itu. */
async function stateFor(sessionId) {
  process.env.DEV_WORKFLOW_SESSION_ID = sessionId;
  const state = new WorkflowState();
  await state.load();
  await state.ensurePrimaryFile();
  return state;
}

test("dua sesi memakai berkas state yang berbeda", async () => {
  await withProject(async () => {
    const a = await stateFor("ses-aaa");
    const b = await stateFor("ses-bbb");

    assert.notEqual(a.stateFile, b.stateFile, "tiap sesi harus punya berkas sendiri");
    assert.ok(a.stateFile.includes("ses-aaa") || a.stateFile.includes("ses_aaa") || /ses[-_]aaa/.test(a.stateFile), "path memuat identitas sesi A");
    assert.ok(/ses[-_]bbb/.test(b.stateFile), "path memuat identitas sesi B");
  });
});

test("start_task di satu sesi tidak mengganti task sesi lain", async () => {
  await withProject(async () => {
    const a = await stateFor("ses-aaa");
    a.state.currentPhase = "coding";
    a.state.taskDescription = "Task milik sesi A";
    await a.save();

    const b = await stateFor("ses-bbb");
    b.state.currentPhase = "coding";
    b.state.taskDescription = "Task milik sesi B";
    await b.save();

    // Sesi A dibaca ulang setelah B menulis: task A harus utuh.
    process.env.DEV_WORKFLOW_SESSION_ID = "ses-aaa";
    const aReloaded = new WorkflowState();
    await aReloaded.load();
    assert.equal(aReloaded.state.taskDescription, "Task milik sesi A", "task sesi A tidak boleh tertimpa");
    assert.equal(aReloaded.state.currentPhase, "coding");

    process.env.DEV_WORKFLOW_SESSION_ID = "ses-bbb";
    const bReloaded = new WorkflowState();
    await bReloaded.load();
    assert.equal(bReloaded.state.taskDescription, "Task milik sesi B");
  });
});

test("gerbang kualitas tidak bisa dipinjam sesi lain", async () => {
  await withProject(async () => {
    const a = await stateFor("ses-aaa");
    a.state.currentPhase = "commit";
    a.state.taskDescription = "Task sesi A";
    a.state.readyCheckCompleted = true;
    a.state.testsPassed = true;
    a.state.documentationCreated = true;
    await a.save();

    // Sesi B belum mengerjakan apa pun; tidak boleh mewarisi gerbang A.
    const b = await stateFor("ses-bbb");
    assert.equal(b.state.readyCheckCompleted, false, "ready check milik sesi, bukan mesin");
    assert.equal(b.state.testsPassed, false);
    assert.equal(b.state.documentationCreated, false);
    assert.equal(b.state.currentPhase, "idle", "sesi baru mulai dari idle");
  });
});

test("history tetap dibagi antar sesi karena milik proyek", async () => {
  await withProject(async () => {
    const a = await stateFor("ses-aaa");
    a.addToHistory({ taskDescription: "Task selesai di sesi A", taskType: "feature", commitMessage: "feat: a" });
    a.reset();
    await a.save();

    const b = await stateFor("ses-bbb");
    const descriptions = b.state.history.map((entry) => entry.taskDescription);
    assert.ok(
      descriptions.includes("Task selesai di sesi A"),
      `history sesi A harus terlihat di sesi B, dapat: ${JSON.stringify(descriptions)}`,
    );

    // Dan sebaliknya: B menyelesaikan task, A harus melihatnya.
    b.addToHistory({ taskDescription: "Task selesai di sesi B", taskType: "bugfix", commitMessage: "fix: b" });
    b.reset();
    await b.save();

    process.env.DEV_WORKFLOW_SESSION_ID = "ses-aaa";
    const aReloaded = new WorkflowState();
    await aReloaded.load();
    const aDescriptions = aReloaded.state.history.map((entry) => entry.taskDescription);
    assert.ok(aDescriptions.includes("Task selesai di sesi B"), "history dua arah harus bertemu");
    assert.ok(aDescriptions.includes("Task selesai di sesi A"), "entri lama tidak boleh hilang");
  });
});

test("history tidak berganda walau berkali-kali disimpan", async () => {
  await withProject(async () => {
    const a = await stateFor("ses-aaa");
    a.addToHistory({ taskDescription: "Task sekali", taskType: "feature", commitMessage: "feat: x" });
    a.reset();
    await a.save();
    await a.save();
    await a.save();

    const b = await stateFor("ses-bbb");
    const occurrences = b.state.history.filter((entry) => entry.taskDescription === "Task sekali").length;
    assert.equal(occurrences, 1, "entri history yang sama tidak boleh digandakan");
  });
});

test("identitas sesi stabil untuk proses yang sama", async () => {
  await withProject(async () => {
    delete process.env.DEV_WORKFLOW_SESSION_ID;
    delete process.env.OPENCODE_SESSION_ID;

    // Tanpa env, identitas jatuh ke proses: harus sama setiap kali dipanggil,
    // supaya modul yang di-reload tidak berpindah berkas.
    const first = resolveStateFile();
    const second = resolveStateFile();
    assert.equal(first, second, "path state harus stabil dalam satu proses");
  });
});

test("OPENCODE_SESSION_ID dipakai bila DEV_WORKFLOW_SESSION_ID tidak ada", async () => {
  await withProject(async () => {
    delete process.env.DEV_WORKFLOW_SESSION_ID;
    process.env.OPENCODE_SESSION_ID = "ses_dari_opencode_123";
    const resolved = resolveStateFile();
    assert.ok(/ses_dari_opencode_123/.test(resolved), `path harus memuat id sesi editor, dapat: ${resolved}`);
  });
});

test("path eksplisit tetap memakai satu berkas (kompatibel)", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "explicit-state-"));
  try {
    const stateFile = path.join(tempDir, "state.json");
    assert.equal(resolveHistoryFile(stateFile), stateFile, "di luar tata letak .state/users, history menempel di berkas yang sama");

    const state = new WorkflowState(stateFile);
    await state.load();
    state.addToHistory({ taskDescription: "Task eksplisit", taskType: "other", commitMessage: "" });
    state.reset();
    await state.save();

    const written = JSON.parse(await readFile(stateFile, "utf-8"));
    assert.equal(written.history.length, 1);
    assert.equal(written.taskDescription, "", "reset mengosongkan task");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("projectRoot dikenali dari letak .state, bukan dari jumlah dirname", () => {
  // Tata letak sekarang tetap sedalam layout lama, jadi menghitung empat
  // dirname masih "kebetulan benar". Tes ini mengunci maksud sebenarnya:
  // projectRoot adalah induk direktori .state, sedalam apa pun berkasnya.
  // path.resolve dipakai supaya perbandingan ikut menyertakan drive letter.
  const root = path.resolve(path.sep, "projects", "app");

  const shallow = path.join(root, ".state", "users", "user-x", "workflow-state.json");
  assert.equal(resolveProjectRootForState(shallow), root, "layout saat ini");

  const deeper = path.join(root, ".state", "users", "user-x", "sessions", "s1", "workflow-state.json");
  assert.equal(
    resolveProjectRootForState(deeper),
    root,
    "kedalaman berbeda harus tetap menunjuk projectRoot yang sama, bukan <root>/.state",
  );
});

test("projectRoot untuk path di luar .state memakai direktori berkasnya", () => {
  const explicit = path.resolve(path.sep, "tmp", "scratch", "state.json");
  assert.equal(resolveProjectRootForState(explicit), path.dirname(explicit));
});

test("history bersama disimpan di berkas kanonik user", async () => {  await withProject(async (projectRoot) => {
    const a = await stateFor("ses-aaa");
    a.state.taskDescription = "Task sesi A yang masih berjalan";
    a.addToHistory({ taskDescription: "Task kanonik", taskType: "feature", commitMessage: "" });
    await a.save();
    a.reset();
    await a.save();

    const canonical = path.join(projectRoot, ".state", "users", "user-test", "workflow-state.json");
    const shared = JSON.parse(await readFile(canonical, "utf-8"));
    assert.ok(
      shared.history.some((entry) => entry.taskDescription === "Task kanonik"),
      "history bersama harus ada di workflow-state.json kanonik",
    );
    assert.notEqual(
      shared.taskDescription,
      "Task sesi A yang masih berjalan",
      "task milik satu sesi tidak boleh jadi task di berkas bersama",
    );
  });
});
