import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import { WorkflowState } from "../workflow-state.js";

// Kenapa tes ini ada:
//
// `syncToDatabase()` memanggil `getCurrentUserId()`, yang membaca cache modul
// `cachedUserId`. Cache itu hanya terisi bila `resolveUserId()` pernah
// dijalankan - dan itu hanya terjadi lewat `resolveStateFile()`.
//
// Praktisnya: siapa pun yang membuat `WorkflowState` dengan path EKSPLISIT
// (skrip perbaikan, CLI, tes) tidak pernah memicu `resolveUserId()`. Dalam
// keadaan itu `getCurrentUserId()` diam-diam mengembalikan "default".
//
// Akibatnya riwayat satu proyek terpecah jadi dua identitas di database yang
// sama: `user-…` untuk pemakaian normal dan `default` untuk pemakaian lewat
// path eksplisit.

async function makeProjectWithUserFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stable-user-"));
  const stateDir = path.join(dir, ".state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "user-id"), "user-stabil-123\n");

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, stateFile: path.join(stateDir, "workflow-state.json") };
}

function captureUserId() {
  const calls = [];
  return {
    calls,
    db: {
      insertHistoryEntry: async (userId) => calls.push(userId),
      updateSummaryForUser: async () => {},
      saveState: async () => {},
    },
  };
}

test("user id yang dipakai menyimpan history tidak boleh jatuh ke 'default'", async (t) => {
  const { stateFile } = await makeProjectWithUserFile(t);

  const state = new WorkflowState(stateFile);
  await state.load();
  state.state.history = [
    { taskDescription: "tugas", taskType: "other", timestamp: "2026-10-30T01:00:00.000Z" },
  ];

  const { calls, db } = captureUserId();
  await state.syncToDatabase({ db });

  assert.equal(calls.length, 1, "satu entri history harus disinkronkan");
  assert.notEqual(
    calls[0],
    "default",
    "user id tidak boleh diam-diam menjadi 'default' hanya karena path state diberikan eksplisit",
  );
  assert.equal(
    calls[0],
    "user-stabil-123",
    "user id harus diambil dari berkas .state/user-id milik proyek itu",
  );
});

test("dua proyek berbeda dalam satu proses memakai user id masing-masing", async (t) => {
  // Ini juga skenario nyata: satu proses MCP bisa melayani beberapa location.
  const a = await makeProjectWithUserFile(t);
  await fs.writeFile(path.join(a.dir, ".state", "user-id"), "user-proyek-A\n");

  const b = await makeProjectWithUserFile(t);
  await fs.writeFile(path.join(b.dir, ".state", "user-id"), "user-proyek-B\n");

  const stateA = new WorkflowState(a.stateFile);
  await stateA.load();
  stateA.state.history = [
    { taskDescription: "tugas A", taskType: "other", timestamp: "2026-10-30T01:00:00.000Z" },
  ];

  const stateB = new WorkflowState(b.stateFile);
  await stateB.load();
  stateB.state.history = [
    { taskDescription: "tugas B", taskType: "other", timestamp: "2026-10-30T01:00:00.000Z" },
  ];

  const captureA = captureUserId();
  await stateA.syncToDatabase({ db: captureA.db });

  const captureB = captureUserId();
  await stateB.syncToDatabase({ db: captureB.db });

  assert.deepEqual(captureA.calls, ["user-proyek-A"], "proyek A memakai user id-nya sendiri");
  assert.deepEqual(captureB.calls, ["user-proyek-B"], "proyek B tidak boleh mewarisi user id proyek A");
});
