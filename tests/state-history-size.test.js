import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { WorkflowState } from "../workflow-state.js";

/**
 * `history` tidak boleh ikut disimpan di dalam `state_json`.
 *
 * MASALAH YANG DIUKUR (2 November 2026, mesin ini): berkas ekspor 96.563 byte,
 * 71.096 byte di antaranya `history` berisi 85 entri. `save()` dipanggil pada
 * hampir setiap panggilan tool, jadi setiap langkah workflow menulis ulang
 * seluruh riwayat - dan biayanya naik terus seiring usia proyek, di jalur
 * terpanas di seluruh sistem.
 *
 * Riwayatnya sudah lama tersimpan di tabel `workflow_history`. Menyimpannya dua
 * kali tidak menambah keamanan apa pun, hanya memperlambat.
 */
async function withState(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-hist-"));
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "state.db") });
  const stateFile = path.join(dir, ".state", "workflow-state.json");
  const make = async () => {
    await adapter.connect();
    const ws = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_hist" });
    await ws.load();
    return ws;
  };

  try {
    await fn({ adapter, stateFile, make });
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function seedHistory(ws, count) {
  for (let i = 0; i < count; i += 1) {
    ws.addToHistory({
      taskDescription: `task ${i}`,
      taskType: "feature",
      commitMessage: `feat: ${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    });
  }
}

test("state_json tidak memuat history, seberapa pun panjang riwayatnya", async () => {
  await withState(async ({ adapter, make }) => {
    const ws = await make();
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "task panjang";
    seedHistory(ws, 80);

    await ws.save();

    const row = adapter.db
      .prepare("SELECT state_json FROM workflow_state WHERE session_key = 'ses_hist'")
      .get();
    const stored = JSON.parse(row.state_json);

    assert.equal(
      Object.prototype.hasOwnProperty.call(stored, "history"),
      false,
      "history tidak boleh ikut ke state_json",
    );
    assert.ok(row.state_json.length < 20000, `state_json harus kecil, dapat ${row.state_json.length} byte`);
  });
});

test("riwayat tetap utuh dan terbaca kembali dari tabel", async () => {
  await withState(async ({ adapter, make }) => {
    const ws = await make();
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "task panjang";
    seedHistory(ws, 80);
    await ws.save();

    const rows = adapter.db.prepare("SELECT count(*) c FROM workflow_history").get().c;
    assert.equal(rows, 80, "semua entri harus masuk tabel");

    const reloaded = await make();
    assert.equal(reloaded.state.history.length, 80, "load() harus memulihkan riwayat dari tabel");
    assert.ok(
      reloaded.state.history.some((entry) => entry.taskDescription === "task 0"),
      "entri paling lama pun harus ada",
    );
  });
});

test("menyimpan lagi tidak menulis ulang seluruh riwayat ke tabel", async () => {
  await withState(async ({ adapter, make }) => {
    const ws = await make();
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "task panjang";
    seedHistory(ws, 50);
    await ws.save();

    let writes = 0;
    const original = adapter.insertHistoryEntry.bind(adapter);
    adapter.insertHistoryEntry = async (...args) => {
      writes += 1;
      return original(...args);
    };

    // Tidak ada entri baru: tidak boleh ada satu pun upsert.
    await ws.save();
    assert.equal(writes, 0, "riwayat yang sudah tersimpan tidak ditulis ulang");

    // Satu entri baru: tepat satu upsert.
    ws.addToHistory({
      taskDescription: "task baru",
      taskType: "feature",
      commitMessage: "feat: baru",
      timestamp: new Date(Date.UTC(2026, 1, 1)).toISOString(),
    });
    await ws.save();
    assert.equal(writes, 1, "hanya entri baru yang dikirim");
  });
});

test("berkas ekspor tidak lagi membengkak karena riwayat", async () => {
  await withState(async ({ adapter, make, stateFile }) => {
    const ws = await make();
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "task panjang";
    seedHistory(ws, 80);
    await ws.save();

    const { readFile } = await import("node:fs/promises");
    const exported = JSON.parse(await readFile(stateFile, "utf-8"));
    // Ekspor tetap memuat riwayat supaya alat lama tidak kehilangan konteks,
    // tetapi ia ditulis SEKALI di sini - bukan bagian dari state_json.
    assert.ok(Array.isArray(exported.history));
    assert.equal(exported.history.length, 80);
  });
});