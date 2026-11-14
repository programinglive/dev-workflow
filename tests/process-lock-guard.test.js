import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  acquireProcessLock,
  activeForeignLock,
  processLockPath,
  refreshProcessLock,
  setIsAliveForTests,
  setIsHolderProcessForTests,
  clearHeldLeasesForTests,
  DEFAULT_LOCK_STALE_MS,
  LOCK_PROTOCOL_VERSION,
} from "../process-lock.js";
import { WorkflowState } from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { testUtils } from "./test-helpers.js";

/**
 * "Satu penulis per repo" harus punya gigi.
 *
 * 31 Oktober 2026 dua sesi OpenCode menulis satu working tree. Satu sesi
 * kehilangan seluruh suntingannya di `tools/handler-modules/index.js` tanpa
 * pesan apa pun — berkasnya kembali ke versi HEAD di tengah pekerjaan. Penanda
 * proses sudah ada, tetapi hanya dicatat sebagai peringatan, jadi tidak ada yang
 * menghentikan tabrakan.
 *
 * Yang diuji di sini:
 *   1. Penanda lain yang HIDUP menolak `start_task` (bahkan jika detaknya tua;
 *      pengambilalihan tanpa force hanya boleh saat pemegang terkonfirmasi mati).
 *   2. Penanda yang pemegangnya sudah MATI dipulihkan secara atomik.
 *   3. `force: true` tetap tersedia untuk pemilik mesin terhadap sesi v2.
 */

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "lock-guard-"));
  try {
    await callback(dir);
  } finally {
    setIsAliveForTests(null);
    setIsHolderProcessForTests(null);
    clearHeldLeasesForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeLock(dir, payload) {
  const fullPayload = {
    protocolVersion: LOCK_PROTOCOL_VERSION,
    leaseId: payload.leaseId || `lease-test-${payload.pid || 0}`,
    incarnationId: payload.incarnationId || `inc-test-${payload.pid || 0}`,
    ...payload,
  };
  await writeFile(processLockPath({ dir }), JSON.stringify(fullPayload), "utf8");
}

test("activeForeignLock mengabaikan penanda milik proses ini sendiri saat lease dipegang", async () => {
  await withTempDir(async (dir) => {
    acquireProcessLock({ dir, pid: process.pid, now: Date.now() });

    const holder = activeForeignLock({ dir, pid: process.pid, isAlive: () => true });

    assert.equal(holder, null);
  });
});

test("activeForeignLock mengabaikan proses yang sudah mati", async () => {
  await withTempDir(async (dir) => {
    await writeLock(dir, { pid: 999999, startedAt: Date.now(), heartbeatAt: Date.now() });

    const holder = activeForeignLock({ dir, pid: process.pid, isAlive: () => false });

    assert.equal(holder, null);
  });
});

test("activeForeignLock menemukan proses lain yang hidup dan baru bekerja", async () => {
  await withTempDir(async (dir) => {
    const now = Date.now();
    await writeLock(dir, { pid: 4242, startedAt: now - 60_000, heartbeatAt: now - 30_000, host: "MMCH" });

    const holder = activeForeignLock({ dir, pid: process.pid, now, isAlive: () => true });

    assert.ok(holder, "penanda segar milik proses lain harus terdeteksi");
    assert.equal(holder.pid, 4242);
    assert.equal(holder.host, "MMCH");
    assert.ok(holder.ageMs >= 30_000);
  });
});

test("activeForeignLock tetap melindungi proses yang masih hidup walau detaknya sudah tua (F4 no heartbeat-only takeover)", async () => {
  await withTempDir(async (dir) => {
    const now = Date.now();
    await writeLock(dir, {
      pid: 4242,
      startedAt: now - 3 * 60 * 60 * 1000,
      heartbeatAt: now - DEFAULT_LOCK_STALE_MS - 60_000,
    });

    const holderAlive = activeForeignLock({ dir, pid: process.pid, now, isAlive: () => true });
    assert.ok(holderAlive, "proses yang masih hidup tidak boleh diambil alih hanya karena detaknya tua");
    assert.equal(holderAlive.staleHeartbeat, true);

    const holderDead = activeForeignLock({ dir, pid: process.pid, now, isAlive: () => false });
    assert.equal(holderDead, null, "penanda basi yang prosesnya sudah mati boleh diambil alih");
  });
});

test("refreshProcessLock hanya menyegarkan penanda milik sendiri", async () => {
  await withTempDir(async (dir) => {
    const acq = acquireProcessLock({ dir, pid: process.pid, now: 1 });
    assert.equal(acq.acquired, true);

    const touched = refreshProcessLock({ dir, pid: process.pid, leaseId: acq.leaseId, now: 55555 });
    assert.equal(touched, true);

    const stored = JSON.parse(await readFile(processLockPath({ dir }), "utf8"));
    assert.equal(stored.heartbeatAt, 55555);
    assert.equal(stored.startedAt, 1, "startedAt tidak boleh ikut berubah");

    const foreign = refreshProcessLock({ dir, pid: process.pid + 1, now: 66666 });
    assert.equal(foreign, false, "penanda milik proses lain tidak boleh disentuh");
  });
});

test("acquireProcessLock mencatat detak pertama saat mengambil alih", async () => {
  await withTempDir(async (dir) => {
    const result = acquireProcessLock({ dir, pid: process.pid, now: 123456 });

    assert.equal(result.acquired, true);
    const stored = JSON.parse(await readFile(processLockPath({ dir }), "utf8"));
    assert.equal(stored.heartbeatAt, 123456);
  });
});

test("start_task menolak saat proses MCP lain masih aktif di proyek yang sama", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const state = new WorkflowState(stateFile);
    await state.load();

    try {
      await writeLock(dir, { pid: 4242, startedAt: Date.now(), heartbeatAt: Date.now(), host: "MMCH" });
      setIsAliveForTests(() => true);

      const response = await handleToolCall({
        request: {
          params: {
            name: "start_task",
            arguments: { description: "Kerjakan sesuatu", type: "feature", definitionOfDone: ["build lulus"] },
          },
        },
        normalizeRequestArgs,
        workflowState: state,
        exec: async () => ({ stdout: "" }),
        git: {},
        utils: testUtils,
      });
      const out = response?.content?.[0]?.text || "";

      assert.match(out, /sesi lain sedang mengerjakan proyek ini/);
      assert.match(out, /PID 4242/);
      assert.match(out, /MMCH/);
      assert.match(out, /force/);
      assert.equal(state.state.taskDescription, "", "task tidak boleh dimulai");
      assert.equal(state.state.currentPhase, "idle");
    } finally {
      await state.close();
    }
  });
});

test("start_task tetap boleh jalan saat pemegang penanda lain sudah mati", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const state = new WorkflowState(stateFile);
    await state.load();

    try {
      await writeLock(dir, {
        pid: 4242,
        startedAt: Date.now() - 3 * 60 * 60 * 1000,
        heartbeatAt: Date.now() - DEFAULT_LOCK_STALE_MS - 60_000,
      });
      setIsAliveForTests((pid) => pid === process.pid);

      const response = await handleToolCall({
        request: {
          params: {
            name: "start_task",
            arguments: { description: "Kerjakan sesuatu", type: "feature", definitionOfDone: ["build lulus"] },
          },
        },
        normalizeRequestArgs,
        workflowState: state,
        exec: async () => ({ stdout: "" }),
        git: {},
        utils: testUtils,
      });

      assert.match(response?.content?.[0]?.text || "", /Task Started/);
      assert.equal(state.state.currentPhase, "coding");
    } finally {
      await state.close();
    }
  });
});

test("force true melewati penolakan dan tetap mencatat task", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const state = new WorkflowState(stateFile);
    await state.load();

    try {
      await writeLock(dir, { pid: 4242, startedAt: Date.now(), heartbeatAt: Date.now() });
      setIsAliveForTests(() => true);

      const response = await handleToolCall({
        request: {
          params: {
            name: "start_task",
            arguments: {
              description: "Kerjakan sesuatu",
              type: "feature",
              definitionOfDone: ["build lulus"],
              force: true,
            },
          },
        },
        normalizeRequestArgs,
        workflowState: state,
        exec: async () => ({ stdout: "" }),
        git: {},
        utils: testUtils,
      });

      assert.match(response?.content?.[0]?.text || "", /Task Started/);
      assert.equal(state.state.currentPhase, "coding");
    } finally {
      await state.close();
    }
  });
});

test("detak jantung berjalan tanpa argumen setelah lock diambil", async () => {
  // Regresi 31 Oktober 2026: `rememberLockDir` hanya dipanggil di cabang gagal,
  // jadi pada jalur normal `refreshProcessLock()` tidak tahu direktori mana yang
  // harus disegarkan. Penanda tidak pernah diperbarui, dianggap basi setelah 10
  // menit, dan guard berhenti melindungi tanpa pesan apa pun.
  await withTempDir(async (dir) => {
    acquireProcessLock({ dir, pid: process.pid, now: 1000 });

    const touched = refreshProcessLock({ now: 2000 });
    assert.equal(touched, true, "detak harus jalan tanpa argumen setelah acquire");

    const stored = JSON.parse(await readFile(processLockPath({ dir }), "utf8"));
    assert.equal(stored.heartbeatAt, 2000);
  });
});

test("penanda yang berdetak tidak lagi dianggap basi", async () => {
  await withTempDir(async (dir) => {
    acquireProcessLock({ dir, pid: process.pid, now: 1000 });
    refreshProcessLock({ now: Date.now() });

    // Proses lain melihat penanda kita sebagai aktif, bukan basi.
    const holder = activeForeignLock({ dir, pid: 4242, now: Date.now(), isAlive: () => true });
    assert.ok(holder, "penanda yang baru berdetak harus dianggap aktif");
  });
});
