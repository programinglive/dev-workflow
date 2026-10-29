import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveWorkingDirectory, PACKAGE_DIR } from "../exec.js";

// Kenapa tes ini ada:
//
// `commit_and_push` menjawab "No changes detected ... Last commit:
// docs(release): catat rilis 1.12.3" untuk repo yang perubahannya jelas ada.
// Ternyata git dijalankan di direktori kerja server MCP, bukan repo proyek.
// Akibatnya workflow bisa melaporkan "sudah commit" padahal commit terjadi di
// repo yang salah - atau tidak terjadi sama sekali.
//
// Aturan yang ditegakkan: jangan pernah diam-diam memakai repo paket MCP.

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "repo-resolve-"));
  await mkdir(path.join(dir, ".git"), { recursive: true });
  return dir;
}

test("direktori eksplisit dipakai apa adanya", async () => {
  const repo = await makeRepo();
  try {
    const resolved = resolveWorkingDirectory({ explicit: repo, env: {}, candidates: [] });
    assert.strictEqual(resolved, path.resolve(repo));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("WORKFLOW_PROJECT_DIR dipakai bila tidak ada direktori eksplisit", async () => {
  const repo = await makeRepo();
  try {
    const resolved = resolveWorkingDirectory({
      explicit: "",
      env: { WORKFLOW_PROJECT_DIR: repo },
      candidates: [],
    });
    assert.strictEqual(resolved, path.resolve(repo));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("repo paket MCP tidak pernah dipilih sebagai direktori kerja", async () => {
  const repo = await makeRepo();
  try {
    const resolved = resolveWorkingDirectory({
      explicit: "",
      env: {},
      candidates: [PACKAGE_DIR, repo],
    });
    assert.strictEqual(resolved, path.resolve(repo));
    assert.notStrictEqual(resolved, path.resolve(PACKAGE_DIR));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("gagal dengan pesan jelas bila satu-satunya kandidat adalah repo paket", () => {
  assert.throws(
    () => resolveWorkingDirectory({ explicit: "", env: {}, candidates: [PACKAGE_DIR] }),
    (error) => {
      assert.match(error.message, /WORKFLOW_PROJECT_DIR/, "harus menyebut cara memperbaiki");
      assert.match(error.message, /repo paket|package repo|server MCP/i, "harus menjelaskan sebabnya");
      return true;
    },
  );
});

test("direktori eksplisit yang bukan repo ditolak, bukan diabaikan", async () => {
  const kosong = await mkdtemp(path.join(tmpdir(), "bukan-repo-"));
  try {
    assert.throws(
      () => resolveWorkingDirectory({ explicit: kosong, env: {}, candidates: [] }),
      /\.git|repo/i,
    );
  } finally {
    await rm(kosong, { recursive: true, force: true });
  }
});

test("subdirektori di dalam repo menemukan akar repo", async () => {
  const repo = await makeRepo();
  const sub = path.join(repo, "src", "lib");
  try {
    await mkdir(sub, { recursive: true });
    const resolved = resolveWorkingDirectory({ explicit: "", env: {}, candidates: [sub] });
    assert.strictEqual(resolved, path.resolve(repo));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
