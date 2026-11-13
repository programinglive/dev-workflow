import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../db/adapters/sqlite.js";

/**
 * Satu proyek harus jadi SATU baris di SEMUA tabel.
 *
 * MASALAH NYATA (2 November 2026): `normalizeProjectPath` hanya diterapkan ke
 * `workflow_state`. Tabel lain memakai `projectPath || ''` apa adanya, sehingga
 * satu database berisi `c:/users/.../write-safety-...` di `workflow_state` dan
 * `C:\Users\...\write-safety-...` di `state_writer` untuk sesi yang SAMA.
 *
 * Akibatnya riwayat dan ringkasan proyek terpecah, rekap durasi per proyek
 * menghitung dua proyek untuk satu proyek, dan `getHistoryForUser` bisa
 * mengembalikan nol baris untuk path yang ejaannya berbeda.
 */
async function withAdapter(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-norm-"));
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "state.db") });
  await adapter.connect();
  try {
    await fn(adapter);
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const ENTRY = {
  taskDescription: "task uji normalisasi",
  taskType: "feature",
  commitMessage: "feat: uji",
  timestamp: "2026-11-02T10:00:00.000Z",
};

const EXPECTED_NORM = process.platform === "win32" ? "d:/code/foo" : "D:/Code/Foo";
const ALT_SPELLING = process.platform === "win32" ? "d:/code/foo" : "D:/Code/Foo/";

test("riwayat ditulis dengan path ternormalisasi", async () => {
  await withAdapter(async (adapter) => {
    await adapter.insertHistoryEntry("u", "D:\\Code\\Foo\\", ENTRY);
    const row = adapter.db
      .prepare("SELECT project_path FROM workflow_history LIMIT 1")
      .get();
    assert.equal(row.project_path, EXPECTED_NORM);
  });
});

test("riwayat dengan ejaan berbeda menunjuk baris yang sama", async () => {
  await withAdapter(async (adapter) => {
    await adapter.insertHistoryEntry("u", "D:\\Code\\Foo", ENTRY);
    await adapter.insertHistoryEntry("u", ALT_SPELLING, ENTRY);
    const rows = adapter.db.prepare("SELECT count(*) c FROM workflow_history").get().c;
    assert.equal(rows, 1, "satu proyek = satu baris riwayat");
  });
});

test("membaca riwayat dengan ejaan berbeda tetap menemukannya", async () => {
  await withAdapter(async (adapter) => {
    await adapter.insertHistoryEntry("u", "D:\\Code\\Foo", ENTRY);
    const result = await adapter.getHistoryForUser("u", ALT_SPELLING, { pageSize: 10 });
    assert.equal(result.total, 1);
    assert.equal(result.entries.length, 1);
  });
});

test("ringkasan proyek ditulis dan dibaca dengan path ternormalisasi", async () => {
  await withAdapter(async (adapter) => {
    await adapter.insertHistoryEntry("u", "D:\\Code\\Foo", ENTRY);
    await adapter.updateSummaryForUser("u", "D:/Code/Foo/");

    const summary = await adapter.getSummaryForUser("u", ALT_SPELLING);
    assert.ok(summary, "ringkasan harus ditemukan dengan ejaan lain");
    assert.equal(summary.totalTasks, 1);

    const rows = adapter.db.prepare("SELECT count(*) c FROM project_summary").get().c;
    assert.equal(rows, 1, "satu proyek = satu baris ringkasan");
  });
});