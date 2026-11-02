import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { enqueue, drainSync, backoffSeconds, queueDepth } from "../db/replicate.js";

/**
 * Antrean replika adalah alasan Postgres boleh mati.
 *
 * Tanpa antrean, kegagalan mengirim salinan ke dashboard harus ditelan diam-diam
 * (data hilang) atau menggagalkan penyimpanan (workflow berhenti karena jaringan).
 * Dengan antrean, penyimpanan selalu berhasil dan yang tertinggal terlihat.
 */
async function withQueue(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-queue-"));
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "t.db") });
  await adapter.connect();
  try {
    await fn(adapter);
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const pendingCount = (adapter) =>
  adapter.db.prepare("SELECT count(*) AS c FROM sync_queue").get().c;

test("enqueue idempoten: kunci sama tidak menumpuk, isi terbaru menang", async () => {
  await withQueue(async (adapter) => {
    await enqueue(adapter, "state", "u|p|s", JSON.stringify({ v: 1 }));
    await enqueue(adapter, "state", "u|p|s", JSON.stringify({ v: 2 }));

    assert.equal(pendingCount(adapter), 1, "satu kunci = satu baris");

    const row = adapter.db
      .prepare("SELECT payload FROM sync_queue WHERE dedupe_key = 'u|p|s'")
      .get();
    assert.deepEqual(JSON.parse(row.payload), { v: 2 });
  });
});

test("replika mati tidak melempar dan antrean bertahan", async () => {
  await withQueue(async (adapter) => {
    await enqueue(adapter, "state", "k1", "{}");

    const failing = { push: async () => { throw new Error("ECONNREFUSED"); } };
    const r = await drainSync({ replica: failing, limit: 10, budgetMs: 1000, adapter });

    assert.equal(r.failed, 1);
    assert.equal(r.remaining, 1, "baris tidak boleh dibuang saat gagal");

    const row = adapter.db
      .prepare("SELECT attempts, last_error FROM sync_queue WHERE dedupe_key = 'k1'")
      .get();
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /ECONNREFUSED/);
  });
});

test("replika mati tidak pernah membuat save gagal", async () => {
  await withQueue(async (adapter) => {
    await enqueue(adapter, "state", "k2", "{}");
    const r = await drainSync({
      replica: { push: async () => { throw new Error("down"); } },
      limit: 10,
      budgetMs: 1000,
      adapter,
    });
    // Hasilnya laporan, bukan lemparan.
    assert.equal(typeof r.sent, "number");
    assert.equal(typeof r.failed, "number");
  });
});

test("backoff menaik lalu berhenti di 300 detik", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map(backoffSeconds),
    [1, 2, 4, 8, 16, 32, 64, 300],
  );
});

test("dua penguras tidak mengirim baris yang sama dua kali", async () => {
  await withQueue(async (adapter) => {
    await enqueue(adapter, "state", "u|p|s", "{}");

    const sent = [];
    const replica = { push: async (row) => { sent.push(row.dedupe_key); } };

    await Promise.all([
      drainSync({ replica, limit: 10, budgetMs: 1000, adapter }),
      drainSync({ replica, limit: 10, budgetMs: 1000, adapter }),
    ]);

    assert.deepEqual(sent, ["u|p|s"], "klaim baris mencegah kiriman ganda");
  });
});

test("baris yang berhasil dikirim dihapus dari antrean", async () => {
  await withQueue(async (adapter) => {
    await enqueue(adapter, "state", "k3", "{}");
    const r = await drainSync({ replica: { push: async () => {} }, limit: 10, budgetMs: 1000, adapter });
    assert.equal(r.sent, 1);
    assert.equal(pendingCount(adapter), 0);
  });
});

test("baris yang sedang menunggu backoff tidak dikirim lagi", async () => {
  await withQueue(async (adapter) => {
    await enqueue(adapter, "state", "k4", "{}");
    await drainSync({
      replica: { push: async () => { throw new Error("down"); } },
      limit: 10, budgetMs: 1000, adapter,
    });

    let pushed = 0;
    const r = await drainSync({
      replica: { push: async () => { pushed++; } },
      limit: 10, budgetMs: 1000, adapter,
    });
    assert.equal(pushed, 0, "backoff harus menahan pengiriman");
    assert.equal(r.sent, 0);
    assert.equal(r.remaining, 1);
  });
});

test("queueDepth melaporkan jumlah dan umur baris tertua", async () => {
  await withQueue(async (adapter) => {
    await enqueue(adapter, "state", "k5", "{}");
    const d = await queueDepth(adapter);
    assert.equal(d.pending, 1);
    assert.ok(d.oldestAgeMs >= 0);
    assert.ok(d.oldestAgeMs < 60000);
  });
});

test("queueDepth kosong melaporkan nol tanpa melempar", async () => {
  await withQueue(async (adapter) => {
    const d = await queueDepth(adapter);
    assert.deepEqual(d, { pending: 0, oldestAgeMs: 0 });
  });
});
