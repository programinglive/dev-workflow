import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { WorkflowState } from "../workflow-state.js";
import { enqueue, drainSync, queueDepth } from "../db/replicate.js";

/**
 * Antrean replika harus MENAMPUNG laporan yang gagal terkirim.
 *
 * MASALAH NYATA: `reportToMonitorSafe` mengirim snapshot ke dashboard dan
 * menelannya kalau gagal. Kalau server dashboard sedang mati - atau laptop
 * sedang di luar jaringan - laporan itu hilang. Dashboard lalu hanya melihat
 * laporan berikutnya, dan tidak pernah tahu ada langkah yang terlewat.
 *
 * Antrean sudah ada dan teruji, tetapi tidak tersambung ke mana pun: `sync_queue`
 * selalu kosong. Yang disambungkan di sini bukan jalur KEDUA - itu akan membuat
 * dashboard menerima data dari dua sumber dan kartu bisa berganda. Yang
 * disambungkan adalah penampung untuk jalur yang SUDAH ada.
 */
async function withState(fn, { replica = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-wire-"));
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "state.db") });
  const ws = new WorkflowState(path.join(dir, ".state", "workflow-state.json"), {
    db: adapter,
    sessionId: "ses_wire",
    replica,
  });
  await ws.load();

  try {
    await fn({ ws, adapter });
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("laporan yang gagal terkirim masuk antrean, bukan hilang", async () => {
  let attempts = 0;
  const replica = {
    push: async () => {
      attempts += 1;
      throw new Error("monitor mati");
    },
  };

  await withState(async ({ ws, adapter }) => {
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "task yang laporannya gagal";
    await ws.save();

    const depth = await queueDepth(adapter);
    assert.ok(attempts >= 1, "replika harus dicoba");
    assert.equal(depth.pending, 1, "yang gagal harus tetap ada di antrean");
  }, { replica });
});

test("antrean terkuras saat replika hidup lagi", async () => {
  let down = true;
  const replica = {
    push: async () => {
      if (down) throw new Error("monitor mati");
    },
  };

  await withState(async ({ ws, adapter }) => {
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "task";
    await ws.save();

    assert.equal((await queueDepth(adapter)).pending, 1);

    // Waktu backoff lewat. Tanpa ini, percobaan berikutnya ditahan oleh jeda
    // yang memang dirancang - dan tes akan menguji jam dinding, bukan perilaku.
    adapter.db
      .prepare("UPDATE sync_queue SET next_attempt_at = datetime('now', '-5 seconds')")
      .run();
    down = false;

    ws.state.currentPhase = "commit";
    await ws.save();

    assert.equal((await queueDepth(adapter)).pending, 0, "antrean harus terkuras");
  }, { replica });
});

test("antrean menyimpan isi laporan, bukan hanya penanda", async () => {
  const replica = { push: async () => { throw new Error("mati"); } };

  await withState(async ({ ws, adapter }) => {
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "isi harus ikut";
    await ws.save();

    const row = adapter.db.prepare("SELECT payload FROM sync_queue LIMIT 1").get();
    const payload = JSON.parse(row.payload);
    assert.equal(payload.task, "isi harus ikut", "snapshot membawa task, bukan state mentah");
    assert.equal(payload.phase, "coding");
  }, { replica });
});

test("tanpa replika, tidak ada yang masuk antrean", async () => {
  await withState(async ({ ws, adapter }) => {
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "tanpa replika";
    await ws.save();
    assert.equal((await queueDepth(adapter)).pending, 0);
  });
});

test("replika bawaan: dashboard tidak terjangkau berarti laporan TETAP di antrean", async () => {
  // Tanpa replika yang diinjeksi, `push` memakai `reportSnapshot`. Fungsi itu
  // mengembalikan `false` saat gagal - bukan melempar - sehingga antrean harus
  // memperlakukan `false` sebagai gagal. Tanpa itu baris dihapus tanpa pernah
  // sampai ke dashboard.
  const original = process.env.DEVWF_MONITOR_URL;
  process.env.DEVWF_MONITOR_URL = "http://127.0.0.1:59999";

  try {
    await withState(async ({ ws, adapter }) => {
      ws.state.currentPhase = "coding";
      ws.state.taskDescription = "tidak terjangkau";
      await ws.save();

      assert.equal((await queueDepth(adapter)).pending, 1, "laporan gagal harus bertahan");

      const row = adapter.db.prepare("SELECT attempts, last_error FROM sync_queue LIMIT 1").get();
      assert.equal(row.attempts, 1);
      assert.match(row.last_error, /tidak menerima|terjangkau|menolak/i);
    });
  } finally {
    if (original === undefined) delete process.env.DEVWF_MONITOR_URL;
    else process.env.DEVWF_MONITOR_URL = original;
  }
});

test("antrean tidak menggandakan baris untuk sesi yang sama", async () => {
  const replica = { push: async () => { throw new Error("mati"); } };

  await withState(async ({ ws, adapter }) => {
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "satu";
    await ws.save();

    ws.state.currentPhase = "commit";
    await ws.save();

    const rows = adapter.db.prepare("SELECT count(*) c FROM sync_queue").get().c;
    assert.equal(rows, 1, "satu sesi = satu baris antrean; isinya yang terbaru");
  }, { replica });
});