import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { getLastCommitForPath, inspectCommitDiff } from "../git-helpers.js";
import { setActiveProjectDir, getActiveProjectDir } from "../exec.js";

function git(dir, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.email=a@b.c", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/**
 * Repo sementara: commit 1 menulis README.md, commit 2 menulis src/a.js yang
 * berisi satu baris TODO.
 *
 * `setActiveProjectDir` dipulihkan sesudahnya karena `exec` memakainya untuk
 * menentukan repo - kalau bocor, tes lain menjalankan git di direktori yang
 * sudah dihapus.
 */
async function withTmpRepo(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-git-"));
  const previous = getActiveProjectDir();
  try {
    git(dir, "init", "-q");
    await writeFile(path.join(dir, "README.md"), "# proyek\n", "utf8");
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "docs: readme");

    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.js"), "const a = 1;\n// TODO: rapikan\n", "utf8");
    git(dir, "add", "src/a.js");
    git(dir, "commit", "-q", "-m", "feat: a");

    setActiveProjectDir(dir);
    return await fn(dir);
  } finally {
    setActiveProjectDir(previous);
    await rm(dir, { recursive: true, force: true });
  }
}

test("getLastCommitForPath mengembalikan tanggal ISO commit yang menyentuh path", async () => {
  const iso = await withTmpRepo(async () => getLastCommitForPath("README.md"));
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T/);
});

test("getLastCommitForPath mengembalikan string kosong untuk path yang belum pernah di-commit", async () => {
  const iso = await withTmpRepo(async () => getLastCommitForPath("tidak-ada.md"));
  assert.equal(iso, "");
});

test("inspectCommitDiff mengembalikan path dan TODO yang baru masuk", async () => {
  const r = await withTmpRepo(async () => inspectCommitDiff(""));
  // `git show <ref>` adalah SATU commit: HEAD hanya menyentuh src/a.js.
  // README.md ada di commit sebelumnya dan memang bukan urusan panggilan ini.
  assert.deepEqual(r.paths, ["src/a.js"]);
  assert.equal(r.todos.length, 1);
  assert.equal(r.todos[0].path, "src/a.js");
  assert.equal(r.todos[0].line, 2);
  assert.match(r.todos[0].text, /TODO: rapikan/);
});

test("inspectCommitDiff mengabaikan TODO yang hanya dihapus", async () => {
  const r = await withTmpRepo(async (dir) => {
    await writeFile(path.join(dir, "src", "a.js"), "const a = 1;\n", "utf8");
    git(dir, "add", "src/a.js");
    git(dir, "commit", "-q", "-m", "refactor: buang todo");
    return inspectCommitDiff("");
  });
  assert.deepEqual(r.todos, []);
  assert.deepEqual(r.paths, ["src/a.js"]);
});
