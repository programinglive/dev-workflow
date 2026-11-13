import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter, isTestProcess, isTempDatabasePath } from "../db/adapters/sqlite.js";

/**
 * Menjalankan tes TIDAK boleh menulis ke database state yang sebenarnya.
 *
 * MASALAH NYATA (2 November 2026): perintah `node --test tests/xxx.test.js`
 * tanpa `--import ./tests/setup-env.js` membuat `DEV_WORKFLOW_DB_PATH` kosong,
 * sehingga `getDbPath()` memilih `.state/dev-workflow.db` milik repo - dan
 * sekarang berkas itu adalah SUMBER KEBENARAN state workflow. Diukur hari itu:
 * 122 baris `workflow_state`, 111 baris `state_writer`, dan 2.544 baris
 * `workflow_history` berisi path `%TEMP%\shared-state-*`, semuanya menumpang di
 * database produksi.
 *
 * Penjaga ini melempar SEBELUM berkasnya dibuka, dengan pesan yang menyebut cara
 * memperbaikinya - bukan gagal belakangan dengan gejala yang membingungkan.
 */

test("proses tes dikenali dari NODE_TEST_CONTEXT atau argumen --test", () => {
  const original = process.env.NODE_TEST_CONTEXT;
  try {
    process.env.NODE_TEST_CONTEXT = "child-v8";
    assert.equal(isTestProcess(), true);

    delete process.env.NODE_TEST_CONTEXT;
    // Jalur kedua: proses utama `node --test` tidak punya NODE_TEST_CONTEXT.
    assert.equal(isTestProcess({ argv: ["node", "--test", "x.js"] }), true);
    assert.equal(isTestProcess({ argv: ["node", "index.js"] }), false);
  } finally {
    if (original === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = original;
  }
});

test("path database dianggap aman hanya bila berada di direktori sementara", () => {
  assert.equal(isTempDatabasePath(path.join(tmpdir(), "x", "state.db")), true);
  assert.equal(isTempDatabasePath("D:\\code\\proyek\\.state\\dev-workflow.db"), false);
  assert.equal(isTempDatabasePath("C:/Users/a/proyek/.state/dev-workflow.db"), false);
});

test("membuka database di luar tmp saat proses tes DITOLAK, sebelum berkas dibuat", async () => {
  const target = "D:\\code\\dev-workflow-mcp-server\\.state\\harus-tidak-dibuat.db";
  const adapter = new SqliteAdapter({ dbPath: target });

  await assert.rejects(
    () => adapter.connect(),
    (error) => {
      assert.equal(error.code, "STATE_UNAVAILABLE");
      assert.match(error.message, /sementara|tmp|setup-env/i, "pesan harus menyebut cara memperbaikinya");
      return true;
    },
  );

  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(target), false, "berkas tidak boleh dibuat sama sekali");
});

test("database di direktori sementara tetap bisa dibuka saat proses tes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-guard-ok-"));
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "state.db") });
  try {
    await adapter.connect();
    const r = await adapter.saveStateVersioned({
      userId: "u", projectPath: "p", sessionKey: "s", state: { ok: true }, expectedVersion: null,
    });
    assert.equal(r.version, 1);
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("penjaga tidak aktif di jalur produksi", () => {
  // Proses biasa: path repo adalah pilihan yang benar, bukan kesalahan.
  assert.equal(isTestProcess({ argv: ["node", "index.js"], env: {} }), false);
});