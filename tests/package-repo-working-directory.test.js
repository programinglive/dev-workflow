import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveWorkingDirectory, PACKAGE_DIR } from "../exec.js";

// Kenapa tes ini ada:
//
// `resolveWorkingDirectory` membuang PACKAGE_DIR dari kandidat cwd tanpa syarat.
// Itu benar untuk bug 29 Oktober (server diam-diam commit ke repo paket saat
// cwd proyek gagal diresolusi), tetapi membuat `commit_and_push` mustahil
// dipakai untuk mengembangkan server MCP itu sendiri: berapa pun dalamnya cwd
// berada di dalam repo paket, kandidat itu selalu dibuang dan fungsinya
// melempar error.
//
// Aturan yang ditegakkan sekarang:
// - repo paket hanya dipakai bila cwd MEMANG berada di dalamnya (pilihan sadar);
// - bila ada repo proyek lain, repo proyek itu yang menang;
// - bila tidak ada repo sama sekali, pesannya menyebut sebab yang sebenarnya.

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "repo-resolve-"));
  await mkdir(path.join(dir, ".git"), { recursive: true });
  return dir;
}

test("repo paket dipakai bila cwd memang berada di dalamnya", async () => {
  // Simulasi cwd di subdirektori repo paket, seperti sesi OpenCode yang dibuka
  // dari dalam repo server MCP.
  const sub = path.join(PACKAGE_DIR, "tools", "handler-modules");
  const resolved = resolveWorkingDirectory({ explicit: "", env: {}, candidates: [sub] });
  assert.strictEqual(resolved, path.resolve(PACKAGE_DIR));
});

test("repo paket dipakai bila cwd tepat di akarnya", () => {
  const resolved = resolveWorkingDirectory({ explicit: "", env: {}, candidates: [PACKAGE_DIR] });
  assert.strictEqual(resolved, path.resolve(PACKAGE_DIR));
});

test("repo proyek lain tetap menang atas repo paket", async () => {
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

test("cwd di dalam repo proyek tidak pernah dialihkan ke repo paket", async () => {
  const repo = await makeRepo();
  try {
    const sub = path.join(repo, "packages", "app");
    await mkdir(sub, { recursive: true });
    const resolved = resolveWorkingDirectory({ explicit: "", env: {}, candidates: [sub] });
    assert.strictEqual(resolved, path.resolve(repo));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("tanpa repo sama sekali, pesan menyebut sebab yang sebenarnya", async () => {
  const kosong = await mkdtemp(path.join(tmpdir(), "tanpa-repo-"));
  try {
    await writeFile(path.join(kosong, "berkas.txt"), "bukan repo\n");
    assert.throws(
      () => resolveWorkingDirectory({ explicit: "", env: {}, candidates: [kosong] }),
      (error) => {
        assert.doesNotMatch(
          error.message,
          /satu-satunya kandidat adalah repo paket/i,
          "tidak boleh menyalahkan repo paket saat tidak ada repo sama sekali",
        );
        assert.match(error.message, /tidak ada repository git|bukan repo git/i, "sebut sebabnya");
        assert.match(error.message, /WORKFLOW_PROJECT_DIR/, "harus menyebut cara memperbaiki");
        return true;
      },
    );
  } finally {
    await rm(kosong, { recursive: true, force: true });
  }
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

test("subdirektori di dalam repo proyek menemukan akar repo", async () => {
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
