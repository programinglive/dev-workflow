import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveStateFile, resolveHistoryFile } from "../workflow-state.js";
import { projectLockDir } from "../process-lock.js";

/**
 * Isolasi state per sesi di dalam direktori proyek.
 *
 * MASALAH YANG DIKUNCI
 * --------------------
 * 1 November 2026: dua sesi OpenCode saling menghapus Definition of Done dua
 * kali dalam satu jam. Perbaikan "state per proyek" tidak menolong karena
 * (a) ia hanya memisahkan PROYEK, bukan sesi, dan (b) jalur cadangannya
 * mengembalikan satu berkas pin bersama begitu direktori kerja bukan repo -
 * yang justru keadaan normal di mesin ini (`Documents\Default Project`).
 *
 * Tes di berkas ini mengunci kedua lubang itu, plus dua regresi yang mudah
 * diperkenalkan saat tata letak berubah: lock yang kembali global, dan
 * history yang terpecah per sesi.
 */

/** Menjalankan fn dengan pin .state di direktori sementara. */
async function withPinnedState(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "dwf-iso-"));
  const pin = path.join(base, "workflow-state.json");
  const previous = process.env.DEV_WORKFLOW_STATE_FILE;
  process.env.DEV_WORKFLOW_STATE_FILE = pin;
  try {
    return await fn({ base, pin });
  } finally {
    if (previous === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = previous;
    await rm(base, { recursive: true, force: true });
  }
}

test("dua sesi pada proyek yang sama mendapat dua berkas state", async () => {
  await withPinnedState(async ({ base }) => {
    const repo = path.join(base, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });

    const previousCwd = process.cwd();
    process.chdir(repo);
    try {
      const a = resolveStateFile({ sessionId: "ses_AAA" });
      const b = resolveStateFile({ sessionId: "ses_BBB" });

      assert.notEqual(a, b, "dua sesi tidak boleh berbagi satu berkas");
      assert.match(a.replace(/\\/g, "/"), /projects\/.+\/users\/.+\/workflow-state\.ses_AAA\.json$/);
      assert.match(b.replace(/\\/g, "/"), /projects\/.+\/users\/.+\/workflow-state\.ses_BBB\.json$/);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("direktori kerja yang bukan repo tetap memisahkan sesi", async () => {
  await withPinnedState(async ({ base }) => {
    // Direktori tanpa .git maupun package.json: persis keadaan
    // `C:\Users\<username>\Documents\Default Project` di mesin pemilik.
    const nonRepo = path.join(base, "bukan-repo");
    await mkdir(nonRepo, { recursive: true });

    const previousCwd = process.cwd();
    process.chdir(nonRepo);
    try {
      const a = resolveStateFile({ sessionId: "ses_AAA" });
      const b = resolveStateFile({ sessionId: "ses_BBB" });

      assert.notEqual(a, b, "sesi tetap harus terpisah walau cwd bukan repo");
      assert.match(a.replace(/\\/g, "/"), /projects\//);
      assert.match(b.replace(/\\/g, "/"), /projects\//);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("dua direktori kerja berbeda tidak bertabrakan", async () => {
  await withPinnedState(async ({ base }) => {
    const one = path.join(base, "kerja-satu");
    const two = path.join(base, "kerja-dua");
    await mkdir(one, { recursive: true });
    await mkdir(two, { recursive: true });

    const previousCwd = process.cwd();
    try {
      process.chdir(one);
      const a = resolveStateFile({ sessionId: "ses_AAA" });
      process.chdir(two);
      const b = resolveStateFile({ sessionId: "ses_AAA" });
      assert.notEqual(a, b, "proyek berbeda tidak boleh berbagi berkas state");
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("history tetap satu berkas di akar proyek, bukan per sesi", async () => {
  await withPinnedState(async ({ base }) => {
    const repo = path.join(base, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });

    const previousCwd = process.cwd();
    process.chdir(repo);
    try {
      const a = resolveStateFile({ sessionId: "ses_AAA" });
      const b = resolveStateFile({ sessionId: "ses_BBB" });

      const ha = resolveHistoryFile(a);
      const hb = resolveHistoryFile(b);

      assert.equal(ha, hb, "history harus terbaca lintas sesi");
      assert.match(ha.replace(/\\/g, "/"), /projects\/.+\/workflow-state\.json$/);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("projectLockDir berhenti di direktori proyek pada kedalaman users/<user>", async () => {
  const stateFile = path.join(
    "D:", "code", "proj", ".state", "projects", "clinic-abc123", "users", "user-1",
    "workflow-state.ses_AAA.json",
  );
  const dir = projectLockDir(stateFile);
  assert.match(dir.replace(/\\/g, "/"), /projects\/clinic-abc123$/);
  assert.doesNotMatch(dir.replace(/\\/g, "/"), /\.state$/);
});

test("projectLockDir tetap benar untuk tata letak lama", async () => {
  const legacy = path.join("D:", "code", "proj", ".state", "users", "user-1", "workflow-state.json");
  assert.match(projectLockDir(legacy).replace(/\\/g, "/"), /\.state$/);

  const direct = path.join("D:", "code", "proj", ".state", "workflow-state.json");
  assert.match(projectLockDir(direct).replace(/\\/g, "/"), /\.state$/);
});

test("migrasi menyalin state menganggur tanpa menghapus berkas lama", async () => {
  await withPinnedState(async ({ base }) => {
    const repo = path.join(base, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });

    const previousCwd = process.cwd();
    process.chdir(repo);
    try {
      const target = resolveStateFile({ sessionId: "ses_MIGRASI" });
      const projectDir = path.dirname(path.dirname(path.dirname(target)));
      const legacy = path.join(projectDir, "workflow-state.json");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        legacy,
        JSON.stringify({ currentPhase: "idle", taskDescription: "", projectDir: repo, marker: "lama" }),
        "utf8",
      );

      // Panggilan berikutnya menjalankan migrasi.
      const again = resolveStateFile({ sessionId: "ses_MIGRASI" });
      assert.equal(again, target);

      assert.ok(existsSync(legacy), "berkas lama tidak boleh dihapus");
      const copied = JSON.parse(await readFile(target, "utf8"));
      assert.equal(copied.marker, "lama");
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("migrasi tidak memindahkan state yang punya task aktif", async () => {
  await withPinnedState(async ({ base }) => {
    const repo = path.join(base, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });

    const previousCwd = process.cwd();
    process.chdir(repo);
    try {
      const target = resolveStateFile({ sessionId: "ses_AKTIF" });
      const projectDir = path.dirname(path.dirname(path.dirname(target)));
      const legacy = path.join(projectDir, "workflow-state.json");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        legacy,
        JSON.stringify({
          currentPhase: "coding",
          taskDescription: "task yang sedang dikerjakan",
          projectDir: repo,
          marker: "aktif",
        }),
        "utf8",
      );

      resolveStateFile({ sessionId: "ses_AKTIF" });
      assert.equal(existsSync(target), false, "state bertask aktif tidak boleh disalin");
    } finally {
      process.chdir(previousCwd);
    }
  });
});
