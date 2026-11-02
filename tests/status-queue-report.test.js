import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { WorkflowState } from "../workflow-state.js";
import { enqueue } from "../db/replicate.js";
import { handleGetWorkflowStatus } from "../tools/handler-modules/status-handlers.js";

/**
 * Dua hal yang tidak akan terlihat tanpa sengaja ditampilkan:
 * salinan replika yang tertinggal, dan dua proses yang berebut sesi yang sama.
 *
 * Keduanya dulu tidak punya suara sama sekali. Yang pertama membuat dashboard
 * tampak kosong padahal datanya ada; yang kedua membuat agen saling menimpa
 * tanpa ada yang tahu sebabnya.
 */
async function withStatus(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-status-"));
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "state.db") });
  const ws = new WorkflowState(path.join(dir, ".state", "workflow-state.json"), {
    db: adapter,
    sessionId: "ses_status",
  });
  await ws.load();

  try {
    await fn({ ws, adapter, dir });
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const textOf = (response) => response.content[0].text;

test("antrean kosong tidak menampilkan baris replika", async () => {
  await withStatus(async ({ ws }) => {
    const text = textOf(await handleGetWorkflowStatus(ws));
    assert.equal(text.includes("Replika:"), false, "jangan menampilkan angka nol yang tidak berguna");
  });
});

test("antrean terisi menampilkan jumlahnya", async () => {
  await withStatus(async ({ ws, adapter }) => {
    await enqueue(adapter, "state", "k1", "{}");
    const text = textOf(await handleGetWorkflowStatus(ws));
    assert.match(text, /Replika: tertunda 1/);
  });
});

test("satu proses menulis berulang tidak memicu peringatan pertikaian", async () => {
  await withStatus(async ({ ws, adapter }) => {
    const { userId, projectPath, sessionKey } = ws._storageIds();
    const touch = () =>
      adapter.db
        .prepare(
          `INSERT INTO state_writer_history (user_id, project_path, session_key, process_token, written_at)
           VALUES (?, ?, ?, 't1', datetime('now'))`,
        )
        .run(userId, projectPath, sessionKey);

    touch();
    touch();

    const text = textOf(await handleGetWorkflowStatus(ws));
    assert.equal(text.includes("Dua proses"), false);
  });
});

test("dua proses berbeda pada sesi yang sama memicu peringatan", async () => {
  await withStatus(async ({ ws, adapter }) => {
    const { userId, projectPath, sessionKey } = ws._storageIds();
    const touch = (token) =>
      adapter.db
        .prepare(
          `INSERT INTO state_writer_history (user_id, project_path, session_key, process_token, written_at)
           VALUES (?, ?, ?, ?, datetime('now'))`,
        )
        .run(userId, projectPath, sessionKey, token);

    touch("t1");
    touch("t2");

    const text = textOf(await handleGetWorkflowStatus(ws));
    assert.match(text, /Dua proses menulis sesi yang sama/);
  });
});