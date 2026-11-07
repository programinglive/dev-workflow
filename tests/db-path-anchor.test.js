import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDbPath } from "../db/adapters/sqlite.js";

/**
 * Database state tidak boleh mendarat di akar drive.
 *
 * MASALAH NYATA (2 November 2026): `getDbPath()` berjalan naik dari `INIT_CWD`
 * mencari `package.json`. Direktori kerja sesi ini (`Documents\Default Project`)
 * tidak punya `package.json`, akar drive juga tidak, sehingga pencarian berhenti
 * di `C:\` dan database dibuat di `C:\.state\dev-workflow.db` - 2,8 MB berisi
 * seluruh state workflow.
 *
 * Akibatnya: berkas sumber kebenaran itu TIDAK ikut bila folder proyek disalin
 * atau di-backup, dan dokumentasi yang menyebut `<proyek>/.state/` menjadi bohong.
 *
 * Jangkar yang benar adalah direktori `.state` milik berkas state sesi itu
 * sendiri - tempat seluruh state lain sudah tinggal.
 */
async function withTree(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "devwf-dbpath-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("database tinggal di .state milik proyek, bukan di akar drive", async () => {
  await withTree(async (root) => {
    const repo = path.join(root, "repo");
    const stateDir = path.join(repo, ".state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "app" }));

    const resolved = resolveDbPath({
      stateFile: path.join(stateDir, "workflow-state.json"),
      env: {},
      cwd: repo,
    });

    assert.equal(resolved, path.join(stateDir, "dev-workflow.db"));
  });
});

test("direktori kerja tanpa package.json tetap memakai .state milik proyeknya", async () => {
  await withTree(async (root) => {
    // Meniru `Documents\Default Project`: tidak ada package.json di mana pun.
    const project = path.join(root, "Default Project");
    const stateDir = path.join(project, ".state");
    await mkdir(stateDir, { recursive: true });

    const resolved = resolveDbPath({
      stateFile: path.join(stateDir, "workflow-state.json"),
      env: {},
      cwd: project,
    });

    assert.equal(resolved, path.join(stateDir, "dev-workflow.db"));
    assert.equal(
      resolved.toLowerCase().startsWith(path.resolve(root).toLowerCase()),
      true,
      "tidak boleh keluar dari proyek",
    );
  });
});

test("tidak pernah mengembalikan path di akar drive", async () => {
  await withTree(async (root) => {
    const project = path.join(root, "tanpa-state");
    await mkdir(project, { recursive: true });

    const resolved = resolveDbPath({ stateFile: null, env: {}, cwd: project });
    const rootOfDrive = path.parse(path.resolve(project)).root;

    assert.notEqual(path.dirname(resolved), rootOfDrive, "jangan pernah menaruh database di akar drive");
    assert.equal(resolved, path.join(project, ".state", "dev-workflow.db"));
  });
});

test("DEV_WORKFLOW_DB_PATH tetap menang bila diisi", () => {
  const resolved = resolveDbPath({
    stateFile: "D:\\repo\\.state\\workflow-state.json",
    env: { DEV_WORKFLOW_DB_PATH: "C:\\custom\\state.db" },
    cwd: "D:\\repo",
  });
  assert.equal(resolved, "C:\\custom\\state.db");
});

test("tata letak users/<user> tetap berakar pada direktori .state", () => {
  const baseRepo = path.resolve("/repo");
  const resolved = resolveDbPath({
    stateFile: path.join(baseRepo, ".state", "users", "alice", "workflow-state.ses_x.json"),
    env: {},
    cwd: baseRepo,
  });
  assert.equal(resolved, path.join(baseRepo, ".state", "dev-workflow.db"));
});