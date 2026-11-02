import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { archiveLegacyState } from "../db/schema.js";
import { migrateLegacyJson } from "../db/migrate-legacy.js";
import { enqueue, drainSync } from "../db/replicate.js";
import { WorkflowState, resolveSessionKey } from "../workflow-state.js";
import { normalizeProjectPath } from "../db/session-key.js";

/**
 * Temuan review terhadap rilis 1.20.0.
 *
 * Enam hal di bawah ini lolos seluruh 905 tes sebelumnya, karena tesnya menguji
 * lapisan yang salah: adapter diuji, jalur yang dipakai `save()` tidak.
 */
async function withLayout(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "devwf-review-"));
  const repoDir = path.join(root, "repo");
  const baseDir = path.join(repoDir, ".state");
  await mkdir(baseDir, { recursive: true });
  const adapter = new SqliteAdapter({ dbPath: path.join(baseDir, "dev-workflow.db") });
  await adapter.connect();
  try {
    await fn({ root, repoDir, baseDir, adapter, projectPath: normalizeProjectPath(repoDir) });
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("migrasi ditandai per proyek, bukan sekali untuk semua proyek", async () => {
  await withLayout(async ({ baseDir, adapter }) => {
    // Proyek A dimigrasikan lebih dulu.
    await migrateLegacyJson(adapter, { baseDir });
    adapter.db
      .prepare("INSERT OR IGNORE INTO migration_log (name, applied_at) VALUES (?, datetime('now'))")
      .run(`legacy-json-v1:${normalizeProjectPath(path.dirname(baseDir))}`);

    // Proyek B memakai database yang sama; berkasnya harus tetap dimigrasikan.
    const baseB = path.join(baseDir, "..", "repoB", ".state");
    const dirB = path.join(baseB, "projects", "p", "users", "u");
    await mkdir(dirB, { recursive: true });
    await writeFile(
      path.join(dirB, "workflow-state.ses_b.json"),
      JSON.stringify({ taskDescription: "task proyek B" }),
    );

    const r = await migrateLegacyJson(adapter, { baseDir: baseB });
    assert.equal(r.sessions, 1, "proyek B harus tetap dimigrasikan");
  });
});

test("arsip menormalkan project_path supaya cadangan legacy bisa ditemukan", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE workflow_state (
    user_id TEXT, project_path TEXT DEFAULT '', state_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, project_path))`);
  // Bentuk path lama: backslash dan huruf drive besar.
  db.prepare("INSERT INTO workflow_state (user_id, project_path, state_json) VALUES (?,?,?)")
    .run("u", "D:\\Code\\Foo", '{"taskDescription":"sisa"}');

  archiveLegacyState(db);

  const row = db.prepare("SELECT project_path FROM workflow_state_legacy").get();
  assert.equal(row.project_path, "d:/code/foo", "harus dinormalkan saat diarsipkan");
});

test("penulis yang memegang versi lama tidak boleh mengembalikan fase", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-ver-"));
  const dbPath = path.join(dir, "state.db");
  const stateFile = path.join(dir, ".state", "workflow-state.json");
  const opened = [];

  try {
    const mk = async () => {
      const adapter = new SqliteAdapter({ dbPath });
      await adapter.connect();
      opened.push(adapter);
      const ws = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_v" });
      await ws.load();
      return ws;
    };

    const w1 = await mk();
    w1.state.currentPhase = "coding";
    w1.state.taskDescription = "task sama";
    await w1.save();

    const w2 = await mk();
    w2.state.currentPhase = "coding";
    w2.state.taskDescription = "task sama";
    await w2.save();

    // Dua proses sekarang memegang versi yang SAMA - keadaan normal ketika satu
    // sesi dilayani dua proses MCP.
    const a = await mk();
    const b = await mk();
    assert.equal(a.stateVersion, b.stateVersion);

    a.state.currentPhase = "commit";
    await a.save();

    // b memegang versi lama dan mencoba menyimpan fase lamanya. Ini TIDAK boleh
    // menimpa "commit".
    b.state.currentPhase = "coding";
    const r = await b.save();

    assert.ok(r, "save() harus mengembalikan hasil");
    // Penulis basi menggabungkan kemajuannya ke baris tersimpan, jadi ia TIDAK
    // menghapus fase yang sudah dicapai - itulah yang diuji di bawah.
    const fresh = await mk();
    assert.equal(fresh.state.currentPhase, "commit", "fase tidak boleh mundur");
  } finally {
    for (const adapter of opened) await adapter.close();
    // Windows kadang masih menahan handle sesaat setelah close.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("enqueue tidak membersihkan klaim atau backoff baris yang sedang menunggu", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-clm-"));
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "state.db") });
  await adapter.connect();

  try {
    await enqueue(adapter, "state", "k", "{}");
    await drainSync({
      replica: { push: async () => { throw new Error("down"); } },
      limit: 10, budgetMs: 1000, adapter,
    });

    const before = adapter.db
      .prepare("SELECT next_attempt_at, attempts FROM sync_queue WHERE dedupe_key = 'k'")
      .get();
    assert.ok(before.next_attempt_at, "baris harus menunggu backoff");

    // Sesi yang sibuk menyimpan lagi dengan kunci yang sama.
    await enqueue(adapter, "state", "k", '{"v":2}');

    const after = adapter.db
      .prepare("SELECT next_attempt_at, attempts, payload FROM sync_queue WHERE dedupe_key = 'k'")
      .get();
    assert.equal(after.next_attempt_at, before.next_attempt_at, "klaim/backoff tidak boleh direset");
    assert.equal(after.attempts, before.attempts);
    assert.deepEqual(JSON.parse(after.payload), { v: 2 }, "isinya tetap yang terbaru");
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("penyimpanan state tetap SQLite walau DEV_WORKFLOW_DB_TYPE menyebut postgres", async () => {
  const { getLocalAdapter } = await import("../db/index.js");
  const original = process.env.DEV_WORKFLOW_DB_TYPE;
  process.env.DEV_WORKFLOW_DB_TYPE = "postgres";
  try {
    const adapter = await getLocalAdapter();
    assert.equal(typeof adapter.saveStateVersioned, "function", "harus adapter SQLite");
  } finally {
    if (original === undefined) delete process.env.DEV_WORKFLOW_DB_TYPE;
    else process.env.DEV_WORKFLOW_DB_TYPE = original;
  }
});

test("verifyPersisted melempar StateConflict, bukan Error biasa", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-vp-"));
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "state.db") });
  await adapter.connect();

  try {
    const ws = new WorkflowState(path.join(dir, ".state", "workflow-state.json"), {
      db: adapter, sessionId: "ses_vp",
    });
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "task asli";
    await ws.save();

    // Proses lain menulis task berbeda pada kunci yang sama.
    const sessionKey = ws._sessionKey().key;
    adapter.db
      .prepare("UPDATE workflow_state SET state_json = ? WHERE session_key = ?")
      .run(JSON.stringify({ currentPhase: "coding", taskDescription: "task lain" }), sessionKey);

    await assert.rejects(
      () => ws.verifyPersisted("task asli"),
      (e) => e.code === "STATE_CONFLICT",
    );
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("kunci sesi cadangan bukan pid- lagi", () => {
  const key = resolveSessionKey({}, null);
  assert.match(key, /^proc-[0-9a-f-]{36}$/, "pid tidak memisahkan dua jendela dalam satu proses");
});