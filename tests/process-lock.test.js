import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireProcessLock,
  releaseProcessLock,
  readProcessLock,
  processLockPath,
  lockWarning,
} from "../process-lock.js";

// Kenapa tes ini ada:
//
// 31 Oktober 2026 dua proses dev-workflow MCP hidup bersamaan (PID 23528 dan
// 3988). Yang lebih tua memegang password Factory LAMA, yang lebih muda memegang
// yang baru, sehingga tool yang sama menjawab berbeda tergantung proses mana yang
// melayaninya. Keduanya juga menulis berkas state workflow yang sama.
//
// Yang dijaga di sini BUKAN membunuh proses lain - itu berbahaya dan sudah punya
// guard sendiri. Yang dijaga: proses kedua tahu ia bukan satu-satunya, lalu
// melaporkannya, alih-alih diam-diam bertabrakan.

function withTempDir(body) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-lock-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mendapat lock saat belum ada pemegang", () => {
  withTempDir((dir) => {
    const result = acquireProcessLock({ dir, pid: 111, now: 1000, isAlive: () => false });

    assert.equal(result.acquired, true);
    assert.equal(readProcessLock({ dir }).pid, 111);
  });
});

test("menolak lock saat pemegangnya masih hidup", () => {
  withTempDir((dir) => {
    acquireProcessLock({ dir, pid: 111, now: 1000, isAlive: () => true });

    const result = acquireProcessLock({ dir, pid: 222, now: 2000, isAlive: (pid) => pid === 111 });

    assert.equal(result.acquired, false);
    assert.equal(result.holder.pid, 111);
    assert.equal(readProcessLock({ dir }).pid, 111, "lock milik proses hidup tidak boleh ditimpa");
  });
});

test("mengambil alih lock yang pemegangnya sudah mati", () => {
  withTempDir((dir) => {
    acquireProcessLock({ dir, pid: 111, now: 1000, isAlive: () => true });

    const result = acquireProcessLock({ dir, pid: 222, now: 2000, isAlive: () => false });

    assert.equal(result.acquired, true);
    assert.equal(result.tookOverFrom, 111);
    assert.equal(readProcessLock({ dir }).pid, 222);
  });
});

test("lock yang sama tidak menghalangi dirinya sendiri", () => {
  withTempDir((dir) => {
    acquireProcessLock({ dir, pid: 111, now: 1000, isAlive: () => true });

    const result = acquireProcessLock({ dir, pid: 111, now: 2000, isAlive: () => true });

    assert.equal(result.acquired, true);
  });
});

test("berkas lock rusak tidak membuat proses gagal start", () => {
  withTempDir((dir) => {
    writeFileSync(processLockPath({ dir }), "{ rusak", "utf8");

    const result = acquireProcessLock({ dir, pid: 222, now: 2000, isAlive: () => false });

    assert.equal(result.acquired, true);
    assert.equal(readProcessLock({ dir }).pid, 222);
  });
});

test("release hanya menghapus lock milik sendiri", () => {
  withTempDir((dir) => {
    acquireProcessLock({ dir, pid: 111, now: 1000, isAlive: () => true });

    releaseProcessLock({ dir, pid: 999 });
    assert.equal(readProcessLock({ dir }).pid, 111, "lock proses lain tidak boleh dihapus");

    releaseProcessLock({ dir, pid: 111 });
    assert.equal(readProcessLock({ dir }), null);
  });
});

test("isi berkas lock memuat pid dan waktu mulai", () => {
  withTempDir((dir) => {
    acquireProcessLock({ dir, pid: 111, now: 1700000000000, isAlive: () => false });

    const lock = readProcessLock({ dir });
    assert.equal(lock.pid, 111);
    assert.equal(lock.startedAt, 1700000000000);
  });
});

test("tidak ada peringatan saat kita satu-satunya proses", () => {
  assert.equal(lockWarning({ acquired: true }), null);
  assert.equal(lockWarning(null), null);
});

test("peringatan menyebut PID proses lain dan menyarankan menutup OpenCode", () => {
  const pesan = lockWarning({
    acquired: false,
    holder: { pid: 23528, startedAt: 1700000000000 },
  });

  assert.match(pesan, /23528/);
  assert.match(pesan, /OpenCode/);
});
