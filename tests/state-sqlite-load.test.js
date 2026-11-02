import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { WorkflowState } from "../workflow-state.js";

/**
 * Membaca state tidak boleh lagi bergantung pada berkas JSON.
 *
 * Berkas JSON kini hanya EKSPOR: alat lama boleh membacanya, tetapi mengubahnya
 * dengan tangan tidak boleh mengubah apa pun yang dipakai agen. Kalau berkas itu
 * masih dianggap kebenaran, dua penulis bisa berbeda pendapat tentang isi state
 * dan yang kalah adalah yang menyimpan lebih dulu.
 */
async function withLayout(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "devwf-load-"));
  const repoDir = path.join(root, "repo");
  const baseDir = path.join(repoDir, ".state");
  const userDir = path.join(baseDir, "users", "alice");
  await mkdir(userDir, { recursive: true });

  const stateFile = path.join(userDir, "workflow-state.ses_load.json");
  const adapter = new SqliteAdapter({ dbPath: path.join(baseDir, "dev-workflow.db") });

  try {
    await fn({ root, repoDir, baseDir, userDir, stateFile, adapter });
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("load memakai state dari SQLite walau berkas JSON tidak ada", async () => {
  await withLayout(async ({ stateFile, adapter }) => {
    await adapter.connect();

    const writer = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_load" });
    writer.state.currentPhase = "coding";
    writer.state.taskDescription = "dari database";
    await writer.save();

    // Hapus berkas ekspor: state harus tetap terbaca.
    await rm(stateFile, { force: true });

    const reader = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_load" });
    await reader.load();
    assert.equal(reader.state.taskDescription, "dari database");
  });
});

test("mengubah berkas JSON dengan tangan tidak mengubah state sesi", async () => {
  await withLayout(async ({ stateFile, adapter }) => {
    await adapter.connect();
    const writer = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_load" });
    writer.state.currentPhase = "coding";
    writer.state.taskDescription = "asli";
    await writer.save();

    await writeFile(stateFile, JSON.stringify({ taskDescription: "diubah tangan" }));

    const reader = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_load" });
    await reader.load();
    assert.equal(reader.state.taskDescription, "asli", "SQLite yang menang");
  });
});

test("sesi baru dimulai dengan state default tanpa melempar", async () => {
  await withLayout(async ({ stateFile, adapter }) => {
    await adapter.connect();
    const ws = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_baru" });
    await ws.load();
    assert.equal(ws.state.currentPhase, "idle");
    assert.equal(ws.state.taskDescription, "");
    assert.equal(ws.stateVersion, null);
  });
});

test("state_json rusak ditolak, tidak dianggap kosong", async () => {
  await withLayout(async ({ stateFile, adapter }) => {
    await adapter.connect();
    const writer = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_bad" });
    writer.state.taskDescription = "akan dirusak";
    await writer.save();

    adapter.db
      .prepare("UPDATE workflow_state SET state_json = '{ terpotong' WHERE session_key = 'ses_bad'")
      .run();

    const reader = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_bad" });
    await assert.rejects(
      () => reader.load(),
      (e) => e.code === "STATE_UNAVAILABLE",
      "state rusak harus gagal keras, bukan mulai dari nol",
    );
  });
});

test("load memigrasikan berkas JSON lama satu kali saja", async () => {
  await withLayout(async ({ baseDir, userDir, stateFile, adapter }) => {
    // Berkas lama sebelum ada SQLite.
    const legacyDir = path.join(baseDir, "projects", "repo-x", "users", "alice");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "workflow-state.ses_lama.json"),
      JSON.stringify({ currentPhase: "coding", taskDescription: "task lama" }),
    );

    await adapter.connect();
    const ws = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_baru" });
    await ws.load();

    const migrated = adapter.db
      .prepare("SELECT count(*) c FROM workflow_state WHERE session_key = 'ses_lama'")
      .get().c;
    assert.equal(migrated, 1, "berkas lama harus masuk ke database");

    const logRows = adapter.db
      .prepare("SELECT count(*) c FROM migration_log WHERE name LIKE 'legacy-json-v1%'")
      .get().c;
    assert.equal(logRows, 1, "migrasi harus tercatat per proyek, bukan diulang tiap load");

    // Menjalankan load lagi tidak menggandakan apa pun.
    const again = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_baru" });
    await again.load();
    const after = adapter.db
      .prepare("SELECT count(*) c FROM workflow_state WHERE session_key = 'ses_lama'")
      .get().c;
    assert.equal(after, 1);
  });
});

test("history ditulis ke tabel workflow_history saat menyimpan", async () => {
  await withLayout(async ({ stateFile, adapter }) => {
    await adapter.connect();
    const ws = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_h" });
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "task history";
    ws.state.history = [
      {
        taskDescription: "task yang sudah selesai",
        taskType: "feature",
        commitMessage: "feat: sesuatu",
        timestamp: new Date().toISOString(),
      },
    ];
    await ws.save();

    const rows = adapter.db.prepare("SELECT count(*) c FROM workflow_history").get().c;
    assert.equal(rows, 1, "history harus masuk tabel, bukan hanya berkas");
  });
});