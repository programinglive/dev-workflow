import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { archiveLegacyState } from "../db/schema.js";
import { migrateLegacyJson } from "../db/migrate-legacy.js";
import { normalizeProjectPath } from "../db/session-key.js";

/**
 * Migrasi tidak boleh kehilangan task.
 *
 * Bentuk lama menyimpan state di berkas JSON per sesi, dan isi `workflow_state`
 * lama hanya milik penulis TERAKHIR sebuah proyek. Memakai baris lama sebagai
 * state hidup berarti satu sesi mewarisi task sesi lain, jadi yang dipakai
 * adalah berkas JSON - satu-satunya sumber yang benar per sesi.
 */

const OLD_DDL = `CREATE TABLE workflow_state (
  user_id TEXT, project_path TEXT DEFAULT '', state_json TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, project_path)
)`;

function rawDb() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS workflow_state_legacy (user_id TEXT NOT NULL, project_path TEXT NOT NULL, state_json TEXT NOT NULL, updated_at TEXT, archived_at TEXT NOT NULL)");
  return db;
}

async function withTree(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "devwf-migrate-"));
  const repoDir = path.join(root, "repo");
  const baseDir = path.join(repoDir, ".state");
  await mkdir(baseDir, { recursive: true });

  const adapter = new SqliteAdapter({ dbPath: path.join(baseDir, "dev-workflow.db") });
  await adapter.connect();
  try {
    await fn({ adapter, baseDir, projectPath: normalizeProjectPath(repoDir) });
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSessionFile(baseDir, projectKey, user, sessionKey, state) {
  const dir = path.join(baseDir, "projects", projectKey, "users", user);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `workflow-state.${sessionKey}.json`), JSON.stringify(state));
}

test("baris workflow_state lama diarsipkan, bukan dijadikan state hidup", () => {
  const db = rawDb();
  db.exec(OLD_DDL);
  db.prepare("INSERT INTO workflow_state (user_id, project_path, state_json) VALUES (?, ?, ?)")
    .run("u", "p", '{"taskDescription":"milik sesi lain"}');

  const r = archiveLegacyState(db);

  assert.equal(r.archived, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM workflow_state").get().c, 0);
  assert.equal(db.prepare("SELECT count(*) c FROM workflow_state_legacy").get().c, 1);
});

test("state per sesi dimigrasikan dari berkas JSON, bukan dari baris DB", async () => {
  await withTree(async ({ adapter, baseDir, projectPath }) => {
    await writeSessionFile(baseDir, "foo-b1", "user-x", "ses_aaa", {
      taskDescription: "task A",
      projectDir: "D:\\code\\foo",
    });

    await adapter.db
      .prepare("INSERT INTO workflow_state_legacy (user_id, project_path, state_json, updated_at, archived_at) VALUES (?,?,?,?,datetime('now'))")
      .run("user-x", projectPath, '{"taskDescription":"milik sesi lain"}', "2026-11-01 00:00:00");

    await migrateLegacyJson(adapter, { baseDir });

    const loaded = await adapter.loadStateVersioned({
      userId: "user-x",
      projectPath,
      sessionKey: "ses_aaa",
    });
    assert.equal(loaded.state.taskDescription, "task A", "JSON yang menang, bukan baris DB");

    const writer = adapter.db
      .prepare("SELECT key_source FROM state_writer WHERE session_key = 'ses_aaa'")
      .get();
    assert.equal(writer.key_source, "legacy-file");
  });
});

test("pengguna tanpa berkas JSON memakai baris legacy sebagai cadangan", async () => {
  await withTree(async ({ adapter, baseDir, projectPath }) => {
    await writeSessionFile(baseDir, "foo-b1", "user-with-json", "ses_aaa", { taskDescription: "task A" });

    await adapter.db
      .prepare("INSERT INTO workflow_state_legacy (user_id, project_path, state_json, updated_at, archived_at) VALUES (?,?,?,?,datetime('now'))")
      .run("user-y", projectPath, '{"taskDescription":"sisa"}', "2026-11-01 00:00:00");

    await migrateLegacyJson(adapter, { baseDir });

    const fallback = await adapter.loadStateVersioned({
      userId: "user-y",
      projectPath,
      sessionKey: "legacy-project",
    });
    assert.equal(fallback.state.taskDescription, "sisa");

    const notFallback = await adapter.loadStateVersioned({
      userId: "user-with-json",
      projectPath,
      sessionKey: "legacy-project",
    });
    assert.equal(notFallback, null, "pengguna yang punya JSON tidak boleh memakai cadangan");
  });
});

test("migrasi kedua tidak menggandakan apa pun", async () => {
  await withTree(async ({ adapter, baseDir }) => {
    await writeSessionFile(baseDir, "foo-b1", "user-x", "ses_aaa", { taskDescription: "task A" });
    await migrateLegacyJson(adapter, { baseDir });

    const before = adapter.db.prepare("SELECT count(*) c FROM workflow_state").get().c;
    await migrateLegacyJson(adapter, { baseDir });
    const after = adapter.db.prepare("SELECT count(*) c FROM workflow_state").get().c;

    assert.equal(after, before);
  });
});

test("berkas lama dipindah, tidak dihapus", async () => {
  await withTree(async ({ adapter, baseDir }) => {
    await writeSessionFile(baseDir, "foo-b1", "user-x", "ses_aaa", { taskDescription: "task A" });
    await migrateLegacyJson(adapter, { baseDir });

    const asli = path.join(baseDir, "projects", "foo-b1", "users", "user-x", "workflow-state.ses_aaa.json");
    assert.equal(existsSync(asli), false, "berkas lama harus pindah dari tempatnya");

    const legacyRoot = path.join(baseDir, "legacy-json");
    assert.equal(existsSync(legacyRoot), true, "salinan harus ada, bukan dihapus");

    const stamps = await readdir(legacyRoot);
    assert.ok(stamps.length >= 1);
  });
});

test("berkas rusak tidak menggagalkan migrasi berkas lain", async () => {
  await withTree(async ({ adapter, baseDir, projectPath }) => {
    await writeSessionFile(baseDir, "foo-b1", "user-x", "ses_good", { taskDescription: "baik" });
    const badDir = path.join(baseDir, "projects", "foo-b1", "users", "user-x");
    await writeFile(path.join(badDir, "workflow-state.ses_bad.json"), "{ bukan json");

    const r = await migrateLegacyJson(adapter, { baseDir });

    assert.equal(r.sessions, 1, "yang baik tetap masuk");
    assert.ok(r.skipped >= 1, "yang rusak dilaporkan, bukan disembunyikan");

    const loaded = await adapter.loadStateVersioned({
      userId: "user-x", projectPath, sessionKey: "ses_good",
    });
    assert.equal(loaded.state.taskDescription, "baik");
  });
});

test("migrasi mencatat jumlah yang masuk", async () => {
  await withTree(async ({ adapter, baseDir }) => {
    await writeSessionFile(baseDir, "p1", "user-a", "ses_1", { n: 1 });
    await writeSessionFile(baseDir, "p2", "user-b", "ses_2", { n: 2 });

    const r = await migrateLegacyJson(adapter, { baseDir });
    assert.equal(r.sessions, 2);
  });
});