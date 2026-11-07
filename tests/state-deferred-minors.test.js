import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { enqueue, drainSync } from "../db/replicate.js";
import { normalizeProjectPath } from "../db/session-key.js";

/**
 * Enam temuan yang ditinggalkan setelah rilis 1.20.2.
 *
 * Masing-masing kecil, tetapi tiga di antaranya menyangkut data yang bisa hilang
 * atau menumpuk tanpa batas.
 */
async function withAdapter(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-minor-"));
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "state.db") });
  await adapter.connect();
  try {
    await fn({ adapter, dir });
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// --- 1. normalizeProjectPath: peka platform, bukan seragam mengecil ---------

test("di Windows, ejaan yang berbeda tetap menjadi satu baris", () => {
  if (process.platform !== "win32") {
    // Di POSIX, dua ejaan ini adalah dua direktori berbeda dan HARUS tetap
    // terpisah - lihat tes berikutnya.
    assert.notEqual(normalizeProjectPath("D:\\Code\\Foo\\"), normalizeProjectPath("d:/code/foo"));
    return;
  }
  const a = normalizeProjectPath("D:\\Code\\Foo\\");
  const b = normalizeProjectPath("d:/code/foo");
  assert.equal(a, b);
  assert.equal(a, "d:/code/foo");
});

test("di POSIX, huruf besar-kecil dipertahankan", () => {
  const a = normalizeProjectPath("/srv/App");
  if (process.platform === "win32") {
    // Windows tidak membedakan huruf pada path, jadi menyeragamkannya benar.
    assert.equal(a, "/srv/app");
    return;
  }
  // POSIX membedakan; menyatukannya berarti menggabungkan dua proyek berbeda.
  assert.equal(a, "/srv/App");
  assert.notEqual(a, normalizeProjectPath("/srv/app"));
});

test("jalur akar tidak menjadi string kosong", () => {
  assert.equal(normalizeProjectPath("/"), "/");
  assert.equal(normalizeProjectPath("C:\\"), process.platform === "win32" ? "c:/" : "C:/");
});

// --- 2. state_writer_history: index + retensi ------------------------------

test("pertikaian penulis terdeteksi lewat method adapter", async () => {
  await withAdapter(async ({ adapter }) => {
    const touch = (token) =>
      adapter.db
        .prepare(
          `INSERT INTO state_writer_history (user_id, project_path, session_key, process_token, written_at)
           VALUES ('u','p','s',?,datetime('now'))`,
        )
        .run(token);
    touch("t1");
    touch("t2");

    assert.equal(adapter.contenders("u", "p", "s"), 2);
  });
});

test("riwayat penulis lama dibuang, yang baru dipertahankan", async () => {
  await withAdapter(async ({ adapter }) => {
    adapter.db
      .prepare(
        `INSERT INTO state_writer_history (user_id, project_path, session_key, process_token, written_at)
         VALUES ('u','p','s','lama',datetime('now','-30 days'))`,
      )
      .run();
    adapter.db
      .prepare(
        `INSERT INTO state_writer_history (user_id, project_path, session_key, process_token, written_at)
         VALUES ('u','p','s','baru',datetime('now'))`,
      )
      .run();

    const removed = adapter.pruneWriterHistory({ days: 7 });
    assert.equal(removed, 1);
    assert.equal(adapter.db.prepare("SELECT count(*) c FROM state_writer_history").get().c, 1);
  });
});

// --- 3. drainSync: kalah klaim bukan alasan berhenti -----------------------

test("kalah klaim di kepala antrean tidak menghentikan baris berikutnya", async () => {
  await withAdapter(async ({ adapter }) => {
    await enqueue(adapter, "snapshot", "k1", JSON.stringify({ n: 1 }));
    await enqueue(adapter, "snapshot", "k2", JSON.stringify({ n: 2 }));

    // Baris pertama sedang diklaim proses lain: belum jatuh tempo.
    adapter.db
      .prepare(
        `UPDATE sync_queue SET next_attempt_at = datetime('now','+300 seconds')
          WHERE dedupe_key = 'k1'`,
      )
      .run();

    const sent = [];
    const r = await drainSync({
      replica: { push: async (row) => { sent.push(row.dedupe_key); } },
      limit: 10,
      budgetMs: 2000,
      adapter,
    });

    assert.deepEqual(sent, ["k2"], "baris yang bisa dikirim tetap dikirim");
    assert.equal(r.sent, 1);
  });
});

// --- 4. security/audit.js memakai resolver yang sama -----------------------

test("audit dan adapter menunjuk berkas database yang sama", async () => {
  const { auditDbPath } = await import("../security/audit.js");
  const { resolveDbPath } = await import("../db/adapters/sqlite.js");

  const stateFile = path.join("D:", "repo", ".state", "workflow-state.json");
  assert.equal(
    auditDbPath({ stateFile, env: {}, cwd: path.join("D:", "repo") }),
    resolveDbPath({ stateFile, env: {}, cwd: path.join("D:", "repo") }),
  );
});

// --- 5. legacy-project bisa dilihat ----------------------------------------

test("state cadangan legacy-project bisa ditemukan", async () => {
  await withAdapter(async ({ adapter }) => {
    adapter.db
      .prepare(
        `INSERT INTO workflow_state (user_id, project_path, session_key, state_json, version, updated_at)
         VALUES ('u','p','legacy-project',?,1,datetime('now'))`,
      )
      .run(JSON.stringify({ taskDescription: "sisa yang belum dipulihkan" }));

    const found = adapter.findOrphanStates("u", "p");
    assert.equal(found.length, 1);
    assert.equal(found[0].taskDescription, "sisa yang belum dipulihkan");
  });
});

// --- 6. timestamp riwayat memakai jam SQLite -------------------------------

test("timestamp riwayat tidak bergantung pada jam proses", async () => {
  await withAdapter(async ({ adapter }) => {
    // Jam proses digeser 24 jam ke depan. Kalau riwayat memakai `new Date()`,
    // baris ini akan tampak "besok" dan urutannya kacau terhadap baris lain.
    const asliSekarang = Date.now;
    Date.now = () => asliSekarang() + 24 * 3600 * 1000;
    try {
      await adapter.insertHistoryEntry("u", "p", {
        taskDescription: "task jam salah",
        taskType: "feature",
        commitMessage: "feat: x",
      });
    } finally {
      Date.now = asliSekarang;
    }

    const row = adapter.db.prepare("SELECT timestamp FROM workflow_history LIMIT 1").get();
    const tertulis = Date.parse(row.timestamp.replace(" ", "T") + "Z");
    const selisihDetik = Math.abs(asliSekarang() - tertulis) / 1000;
    assert.ok(selisihDetik < 3600, `timestamp harus jam database, selisih ${selisihDetik}s`);
  });
});