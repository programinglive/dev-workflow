import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../db/adapters/sqlite.js";

/**
 * State hidup disimpan per SESI, bukan per proyek.
 *
 * Sampai 2 November 2026 kuncinya `(user_id, project_path)`: dua jendela pada
 * proyek yang sama menulis baris yang sama, dan yang terakhir menang tanpa
 * perlawanan. Diukur di mesin ini: 757 baris `workflow_state` untuk 757 proyek,
 * masing-masing berisi state penulis TERAKHIR, bukan state sesi mana pun.
 */
async function withAdapter(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-state-"));
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "test.db") });
  await adapter.connect();
  try {
    await fn(adapter);
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("simpan pertama membuat versi 1", async () => {
  await withAdapter(async (adapter) => {
    const first = await adapter.saveStateVersioned({
      userId: "u",
      projectPath: "p",
      sessionKey: "s",
      state: { a: 1 },
      expectedVersion: null,
    });
    assert.equal(first.version, 1);

    const loaded = await adapter.loadStateVersioned({
      userId: "u",
      projectPath: "p",
      sessionKey: "s",
    });
    assert.deepEqual(loaded.state, { a: 1 });
    assert.equal(loaded.version, 1);
  });
});

test("sesi yang belum pernah menyimpan mengembalikan null, bukan state kosong", async () => {
  await withAdapter(async (adapter) => {
    const loaded = await adapter.loadStateVersioned({
      userId: "u",
      projectPath: "p",
      sessionKey: "belum-ada",
    });
    assert.equal(loaded, null);
  });
});

test("dua sesi berbeda tidak saling menimpa", async () => {
  await withAdapter(async (adapter) => {
    await adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "A", state: { who: "A" }, expectedVersion: null });
    await adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "B", state: { who: "B" }, expectedVersion: null });

    const a = await adapter.loadStateVersioned({ userId: "u", projectPath: "p", sessionKey: "A" });
    const b = await adapter.loadStateVersioned({ userId: "u", projectPath: "p", sessionKey: "B" });
    assert.equal(a.state.who, "A");
    assert.equal(b.state.who, "B");
  });
});

test("versi basi ditolak dengan StateConflict, isi pemenang tidak rusak", async () => {
  await withAdapter(async (adapter) => {
    await adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { v: 1 }, expectedVersion: null });
    await adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { v: 2 }, expectedVersion: 1 });

    await assert.rejects(
      adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { v: 3 }, expectedVersion: 1 }),
      (e) => e.code === "STATE_CONFLICT" && e.actualVersion === 2 && e.expectedVersion === 1,
    );

    const loaded = await adapter.loadStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S" });
    assert.deepEqual(loaded.state, { v: 2 }, "penulis basi tidak boleh menang");
    assert.equal(loaded.version, 2);
  });
});

test("menyimpan dua kali dengan expectedVersion yang benar menaikkan versi", async () => {
  await withAdapter(async (adapter) => {
    await adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { n: 1 }, expectedVersion: null });
    const second = await adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { n: 2 }, expectedVersion: 1 });
    assert.equal(second.version, 2);
  });
});

test("project_path yang berbeda penulisannya menunjuk baris yang sama", async () => {
  await withAdapter(async (adapter) => {
    const queryPath = process.platform === "win32" ? "d:/code/foo" : "D:/Code/Foo";
    await adapter.saveStateVersioned({
      userId: "u",
      projectPath: "D:\\Code\\Foo\\",
      sessionKey: "S",
      state: { n: 1 },
      expectedVersion: null,
    });
    const loaded = await adapter.loadStateVersioned({
      userId: "u",
      projectPath: queryPath,
      sessionKey: "S",
    });
    assert.equal(loaded.state.n, 1, "satu proyek harus jadi satu baris");
  });
});

test("updated_at memakai jam SQLite, bukan jam proses", async () => {
  await withAdapter(async (adapter) => {
    await adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: {}, expectedVersion: null });
    const row = adapter.db
      .prepare("select updated_at from workflow_state where session_key = 'S'")
      .get();
    assert.ok(row.updated_at, "updated_at harus terisi");
    // Format jam SQLite: YYYY-MM-DD HH:MM:SS, bukan ISO dengan T dan Z.
    assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

test("dua proses sungguhan memperebutkan kunci yang sama: satu menang, satu konflik", async () => {
  await withAdapter(async (adapter) => {
    await adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { n: 0 }, expectedVersion: null });

    // Dua penulis membaca versi yang sama, lalu menulis berurutan.
    const readA = await adapter.loadStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S" });
    const readB = await adapter.loadStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S" });
    assert.equal(readA.version, readB.version);

    await adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { n: 1 }, expectedVersion: readA.version });

    await assert.rejects(
      adapter.saveStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S", state: { n: 2 }, expectedVersion: readB.version }),
      (e) => e.code === "STATE_CONFLICT",
    );

    const final = await adapter.loadStateVersioned({ userId: "u", projectPath: "p", sessionKey: "S" });
    assert.deepEqual(final.state, { n: 1 });
  });
});
