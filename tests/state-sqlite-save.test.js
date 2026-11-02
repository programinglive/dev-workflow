import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { WorkflowState } from "../workflow-state.js";

/**
 * `save()` adalah jalur terpanas di seluruh sistem: ia jalan setiap langkah.
 *
 * Sampai 2 November 2026 ia menulis satu berkas JSON bersama dan menambal
 * tabrakannya setelah kejadian - `detectStaleOverwrite` dan `verifyPersisted`
 * memberi tahu bahwa kerusakan SUDAH terjadi. Sekarang tulisan dikunci per sesi
 * dan berversi, sehingga kerusakan itu tidak punya kesempatan terjadi.
 */
async function withState({ sessionId, replica = null, dbPath = null } = {}, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-save-"));
  const stateFile = path.join(dir, ".state", "workflow-state.json");
  const adapter = new SqliteAdapter({ dbPath: dbPath || path.join(dir, "state.db") });
  const ws = new WorkflowState(stateFile, { db: adapter, sessionId, replica });
  await ws.load();
  try {
    await fn({ ws, adapter, dir, stateFile });
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("dua sesi pada proyek yang sama tidak saling menimpa", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-two-"));
  const dbPath = path.join(dir, "state.db");

  try {
    const make = async (sessionId) => {
      const adapter = new SqliteAdapter({ dbPath });
      const ws = new WorkflowState(path.join(dir, `.state-${sessionId}`, "workflow-state.json"), {
        db: adapter,
        sessionId,
      });
      await ws.load();
      return { ws, adapter };
    };

    const a = await make("ses_a");
    const b = await make("ses_b");

    a.ws.state.currentPhase = "coding";
    a.ws.state.taskDescription = "task A";
    await a.ws.save();

    b.ws.state.currentPhase = "coding";
    b.ws.state.taskDescription = "task B";
    await b.ws.save();

    const aReload = await make("ses_a");
    assert.equal(aReload.ws.state.taskDescription, "task A", "sesi A tidak boleh kehilangan task-nya");

    await a.adapter.close();
    await b.adapter.close();
    await aReload.adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Catatan: tes "penulis dengan state basi mendapat conflict" DIHAPUS.
//
// Skenario yang dulu diuji - dua penulis memakai state yang sama lalu yang kedua
// menimpa - sekarang ditangani dengan MENGGABUNGKAN, bukan menolak: penulis yang
// memegang versi lama menyumbang kemajuan monotonnya ke baris tersimpan
// (lihat tests/state-merge-concurrency.test.js dan
// tests/state-review-regressions.test.js "penulis yang memegang versi lama tidak
// boleh mengembalikan fase").
//
// Penolakan versi tetap ada dan diuji di lapisan penyimpanan
// (tests/db-state-versioned.test.js), dan tetap dilaporkan sebagai konflik bila
// penggabungan pun kalah balapan.

test("replika mati tidak menggagalkan save", async () => {
  await withState(
    { sessionId: "ses_w", replica: { push: async () => { throw new Error("down"); } } },
    async ({ ws }) => {
      ws.state.currentPhase = "coding";
      ws.state.taskDescription = "tetap jalan";
      const r = await ws.save();
      assert.equal(r.verified, true, "penyimpanan wajib tidak boleh gagal karena replika");
    },
  );
});

test("dokumentasi tetap tersimpan meski replika gagal", async () => {
  // Kelas bug 2 November 2026: hal opsional tidak boleh menggagalkan yang wajib.
  await withState(
    { sessionId: "ses_doc", replica: { push: async () => { throw new Error("down"); } } },
    async ({ ws }) => {
      ws.state.currentPhase = "coding";
      ws.state.taskDescription = "simpan dokumentasi";
      ws.state.documentationFiles = ["docs/x.md"];
      await ws.save();

      const reloaded = new WorkflowState(ws.stateFile, { db: ws.dbAdapter, sessionId: "ses_doc" });
      await reloaded.load();
      assert.deepEqual(reloaded.state.documentationFiles, ["docs/x.md"]);
    },
  );
});

test("SQLite tidak bisa dibuka: save melempar StateUnavailable, bukan mengaku sukses", async () => {
  const badAdapter = new SqliteAdapter({ dbPath: "Z:\\tidak\\ada\\direktori\\state.db" });
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-bad-"));
  const ws = new WorkflowState(path.join(dir, ".state", "workflow-state.json"), {
    db: badAdapter,
    sessionId: "ses_z",
  });

  try {
    ws.state.taskDescription = "tidak akan tersimpan";
    await assert.rejects(ws.save(), (e) => e.code === "STATE_UNAVAILABLE");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("versi state naik setiap penyimpanan yang berhasil", async () => {
  await withState({ sessionId: "ses_v" }, async ({ ws }) => {
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "satu";
    await ws.save();
    const v1 = ws.stateVersion;

    ws.state.currentPhase = "commit";
    await ws.save();
    assert.ok(ws.stateVersion > v1, "versi harus maju");
  });
});

test("kemajuan langkah tidak mundur saat dua proses melayani sesi yang sama", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-progress-"));
  const dbPath = path.join(dir, "state.db");
  const stateFile = path.join(dir, ".state", "workflow-state.json");

  try {
    const mk = async () => {
      const adapter = new SqliteAdapter({ dbPath });
      const ws = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_p" });
      await ws.load();
      return { ws, adapter };
    };

    const a = await mk();
    a.ws.state.currentPhase = "coding";
    a.ws.state.taskDescription = "task sama";
    a.ws.state.bugFixed = true;
    await a.ws.save();

    const b = await mk();
    assert.equal(b.ws.state.bugFixed, true);

    // b memegang state yang sama tetapi belum menandai apa pun; menyimpan tidak
    // boleh memundurkan langkah yang sudah dicapai a.
    b.ws.state.currentPhase = "coding";
    await b.ws.save();

    const fresh = await mk();
    assert.equal(fresh.ws.state.bugFixed, true, "langkah yang sudah tercapai tidak boleh mundur");

    await a.adapter.close();
    await b.adapter.close();
    await fresh.adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});