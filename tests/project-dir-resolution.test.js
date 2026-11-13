import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveProjectDir, resolveWorkingDirectory, setActiveProjectDir, getActiveProjectDir } from "../exec.js";
import { handleToolCall } from "../tools/handlers.js";
import { withWorkflowState, testUtils, createRequest, createGitMock } from "./test-helpers.js";

// Kenapa tes ini ada:
//
// 30 Oktober 2026, `commit_and_push` menjalankan `git add .` di D:\code\clinic
// padahal pekerjaan ada di repo lain. Penyebabnya: WORKFLOW_PROJECT_DIR adalah
// SATU nilai global, dan ia mengalahkan direktori kerja sesi. `git status` di
// clinic menjawab "bersih", lalu workflow melaporkan "No changes detected -
// assuming commit and push already completed" seolah sudah selesai.
//
// Aturan yang ditegakkan sekarang:
//   1. projectDir eksplisit menang atas segalanya
//   2. projectDir yang di-pin oleh start_task menang atas nilai global
//   3. direktori kerja sesi menang atas WORKFLOW_PROJECT_DIR
//   4. WORKFLOW_PROJECT_DIR hanya cadangan terakhir, dan sumbernya dilaporkan

async function makeRepo(prefix = "repo-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(dir, ".git"), { recursive: true });
  return dir;
}

// Direktori yang BUKAN repo git, mensimulasikan "Documents\Default Project".
async function makeNonRepo(prefix = "no-repo-") {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

const cleanup = async (...dirs) => {
  for (const dir of dirs) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
};

test("projectDir eksplisit menang atas WORKFLOW_PROJECT_DIR", async () => {
  const target = await makeRepo();
  const global = await makeRepo();
  try {
    const resolved = resolveProjectDir({
      explicit: target,
      pinned: "",
      env: { WORKFLOW_PROJECT_DIR: global },
      candidates: [],
    });
    assert.strictEqual(resolved.dir, path.resolve(target));
    assert.strictEqual(resolved.source, "explicit");
  } finally {
    await cleanup(target, global);
  }
});

test("REGRESI: cwd yang menunjuk repo lain melaporkan konflik dengan env", async () => {
  // Inilah kondisi 30 Oktober 2026: WORKFLOW_PROJECT_DIR = D:\code\clinic,
  // sementara sesi bekerja di repo lain. Dulu tidak ada peringatan apa pun,
  // jadi `git add .` berjalan di clinic dan dilaporkan "No changes detected".
  const sessionRepo = await makeRepo("session-");
  const globalRepo = await makeRepo("global-");
  try {
    const resolved = resolveProjectDir({
      explicit: "",
      pinned: "",
      env: { WORKFLOW_PROJECT_DIR: globalRepo },
      candidates: [sessionRepo],
    });
    assert.strictEqual(resolved.dir, path.resolve(globalRepo), "env tetap setelan operator");
    assert.strictEqual(resolved.source, "env");
    assert.ok(resolved.conflict, "konflik harus dilaporkan, bukan didiamkan");
    assert.strictEqual(resolved.conflict.cwdDir, path.resolve(sessionRepo));
    assert.strictEqual(resolved.conflict.envDir, path.resolve(globalRepo));
  } finally {
    await cleanup(sessionRepo, globalRepo);
  }
});

test("tidak ada konflik bila env dan direktori sesi menunjuk repo yang sama", async () => {
  const repo = await makeRepo();
  const sub = path.join(repo, "src");
  try {
    await mkdir(sub, { recursive: true });
    const resolved = resolveProjectDir({
      explicit: "",
      pinned: "",
      env: { WORKFLOW_PROJECT_DIR: repo },
      candidates: [sub],
    });
    assert.strictEqual(resolved.dir, path.resolve(repo));
    assert.strictEqual(resolved.conflict, null, "subdirektori repo yang sama bukan konflik");
  } finally {
    await cleanup(repo);
  }
});

test("REGRESI: projectDir sesi (pinned) menang atas cwd dan nilai global", async () => {
  const pinned = await makeRepo("pinned-");
  const globalRepo = await makeRepo("global-");
  const cwdDir = await makeNonRepo("noderepo-");
  try {
    const resolved = resolveProjectDir({
      explicit: "",
      pinned,
      env: { WORKFLOW_PROJECT_DIR: globalRepo },
      candidates: [cwdDir],
    });
    assert.strictEqual(resolved.dir, path.resolve(pinned));
    assert.strictEqual(resolved.source, "pinned");
  } finally {
    await cleanup(pinned, globalRepo, cwdDir);
  }
});

test("WORKFLOW_PROJECT_DIR dipakai bila tidak ada projectDir sesi", async () => {
  // Backward compatibility: mesin yang selama ini hanya mengandalkan env
  // tidak boleh tiba-tiba gagal.
  const globalRepo = await makeRepo();
  const cwdDir = await makeNonRepo();
  try {
    const resolved = resolveProjectDir({
      explicit: "",
      pinned: "",
      env: { WORKFLOW_PROJECT_DIR: globalRepo },
      candidates: [cwdDir],
    });
    assert.strictEqual(resolved.dir, path.resolve(globalRepo));
    assert.strictEqual(resolved.source, "env");
  } finally {
    await cleanup(globalRepo, cwdDir);
  }
});

test("projectDir eksplisit yang bukan repo ditolak, bukan diabaikan", async () => {
  const bukanRepo = await makeNonRepo();
  try {
    assert.throws(
      () => resolveProjectDir({ explicit: bukanRepo }),
      /\.git|repo/i,
    );
  } finally {
    await cleanup(bukanRepo);
  }
});

test("projectDir sesi yang bukan repo memberi pesan cara memperbaikinya", async () => {
  const bukanRepo = await makeNonRepo();
  try {
    assert.throws(
      () => resolveProjectDir({ pinned: bukanRepo }),
      /start_task|projectDir/i,
    );
  } finally {
    await cleanup(bukanRepo);
  }
});

test("error tanpa repo menyebut projectDir, bukan hanya env", async () => {
  const cwdDir = await makeNonRepo();
  try {
    assert.throws(
      () => resolveProjectDir({ explicit: "", pinned: "", env: {}, candidates: [cwdDir] }),
      /projectDir/,
    );
  } finally {
    await cleanup(cwdDir);
  }
});

test("resolveWorkingDirectory tetap mengembalikan string seperti sebelumnya", async () => {
  const repo = await makeRepo();
  try {
    assert.strictEqual(
      resolveWorkingDirectory({ explicit: "", env: {}, candidates: [repo] }),
      path.resolve(repo),
      "pemanggil lama mengharapkan string, bukan objek",
    );
  } finally {
    await cleanup(repo);
  }
});

test("start_task menyimpan projectDir ke state dan mengaktifkannya", async () => {
  const repo = await makeRepo();
  try {
    await withWorkflowState(async (workflowState) => {
      const response = await handleToolCall({
        request: createRequest("start_task", {
          description: "Kerjakan sesuatu",
          type: "bugfix",
          projectDir: repo,
          definitionOfDone: ["task tercatat"],
        }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: createGitMock(),
        utils: testUtils,
      });

      const text = response.content[0].text;
      assert.strictEqual(workflowState.state.projectDir, path.resolve(repo));
      assert.strictEqual(getActiveProjectDir(), path.resolve(repo));
      assert.match(text, /Repo proyek:/, "jawaban harus menyebut repo yang dipakai");
      assert.ok(text.includes(path.resolve(repo)), "jawaban harus memuat path repo");
    });
  } finally {
    setActiveProjectDir("");
    await cleanup(repo);
  }
});

test("start_task melaporkan KONFLIK bila env dan repo sesi berbeda", async () => {
  const globalRepo = await makeRepo("global-");
  const sessionRepo = await makeRepo("session-");
  const previousEnv = process.env.WORKFLOW_PROJECT_DIR;
  const previousCwd = process.cwd();

  try {
    await withWorkflowState(async (workflowState) => {
      process.env.WORKFLOW_PROJECT_DIR = globalRepo;
      process.chdir(sessionRepo);

      const response = await handleToolCall({
        request: createRequest("start_task", {
          description: "Tanpa projectDir, sesi di repo lain",
          type: "other",
          definitionOfDone: ["task tercatat"],
        }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: createGitMock(),
        utils: testUtils,
      });

      const text = response.content[0].text;
      assert.match(text, /KONFLIK/, "harus menyebut konflik, bukan diam");
      assert.ok(text.includes(path.resolve(globalRepo)), "harus menyebut repo yang dipakai");
      assert.ok(text.includes(path.resolve(sessionRepo)), "harus menyebut repo sesi");
      assert.match(text, /projectDir/, "harus memberi cara memperbaiki");
    });
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) delete process.env.WORKFLOW_PROJECT_DIR;
    else process.env.WORKFLOW_PROJECT_DIR = previousEnv;
    setActiveProjectDir("");
    await cleanup(globalRepo, sessionRepo);
  }
});

test("start_task dengan projectDir mengalahkan env dan tidak melaporkan konflik", async () => {
  const globalRepo = await makeRepo("global-");
  const sessionRepo = await makeRepo("session-");
  const previousEnv = process.env.WORKFLOW_PROJECT_DIR;
  const previousCwd = process.cwd();

  try {
    await withWorkflowState(async (workflowState) => {
      process.env.WORKFLOW_PROJECT_DIR = globalRepo;
      process.chdir(globalRepo);

      const response = await handleToolCall({
        request: createRequest("start_task", {
          description: "Dengan projectDir",
          type: "bugfix",
          projectDir: sessionRepo,
          definitionOfDone: ["task tercatat"],
        }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: createGitMock(),
        utils: testUtils,
      });

      const text = response.content[0].text;
      assert.strictEqual(workflowState.state.projectDir, path.resolve(sessionRepo));
      assert.match(text, /dari argumen projectDir/);
      assert.doesNotMatch(text, /KONFLIK/);
    });
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) delete process.env.WORKFLOW_PROJECT_DIR;
    else process.env.WORKFLOW_PROJECT_DIR = previousEnv;
    setActiveProjectDir("");
    await cleanup(globalRepo, sessionRepo);
  }
});

test("start_task menolak memulai bila projectDir tidak bisa ditentukan (tanpa proyek tidak diizinkan)", async () => {
  const bukanRepo = await makeNonRepo("no-git-");
  const previousEnv = process.env.WORKFLOW_PROJECT_DIR;
  const previousProjectEnv = process.env.PROJECT_DIR;
  const previousInitCwd = process.env.INIT_CWD;
  const previousCwd = process.cwd();

  try {
    await withWorkflowState(async (workflowState) => {
      delete process.env.WORKFLOW_PROJECT_DIR;
      delete process.env.PROJECT_DIR;
      delete process.env.INIT_CWD;
      process.chdir(bukanRepo);

      const response = await handleToolCall({
        request: createRequest("start_task", {
          description: "Task tanpa repo tidak boleh dimulai",
          type: "bugfix",
          definitionOfDone: ["task tercatat"],
          plan: ["langkah 1"],
        }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: createGitMock(),
        utils: testUtils,
      });

      const text = response.content[0].text;
      assert.match(text, /projectDir/i);
      assert.strictEqual(workflowState.state.currentPhase, "idle", "state tidak boleh berpindah ke coding tanpa projectDir");
      assert.strictEqual(workflowState.state.taskDescription, "", "task tanpa proyek tidak boleh disimpan");
    });
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) delete process.env.WORKFLOW_PROJECT_DIR;
    else process.env.WORKFLOW_PROJECT_DIR = previousEnv;
    if (previousProjectEnv === undefined) delete process.env.PROJECT_DIR;
    else process.env.PROJECT_DIR = previousProjectEnv;
    if (previousInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = previousInitCwd;
    setActiveProjectDir("");
    await cleanup(bukanRepo);
  }
});

test("commit_and_push melaporkan repo yang dipakai saat tidak ada perubahan", async () => {
  // "No changes detected" tanpa nama repo tidak bisa dibedakan dari
  // "git berjalan di repo yang salah".
  const repo = await makeRepo();
  try {
    await withWorkflowState(async (workflowState) => {
      workflowState.state.readyToCommit = true;
      workflowState.state.readyCheckCompleted = true;
      workflowState.state.testsCreated = true;
      workflowState.state.testsPassed = true;
      workflowState.state.currentPhase = "commit";
      await workflowState.save();

      const response = await handleToolCall({
        request: createRequest("commit_and_push", { commitMessage: "", projectDir: repo }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: createGitMock({
          hasWorkingChanges: async () => false,
          getLastCommitMessage: async () => "fix: previous work",
        }),
        utils: testUtils,
      });

      const text = response.content[0].text;
      assert.match(text, /No changes detected/);
      assert.match(text, /Repo:/, "harus menyebut repo yang diperiksa");
      assert.ok(text.includes(path.resolve(repo)), "harus memuat path repo yang diperiksa");
      assert.strictEqual(workflowState.state.projectDir, path.resolve(repo));
    });
  } finally {
    setActiveProjectDir("");
    await cleanup(repo);
  }
});

test("commit_and_push menolak projectDir yang bukan repo", async () => {
  const bukanRepo = await makeNonRepo();
  try {
    await withWorkflowState(async (workflowState) => {
      workflowState.state.currentPhase = "commit";
      await workflowState.save();

      const response = await handleToolCall({
        request: createRequest("commit_and_push", { commitMessage: "x", projectDir: bukanRepo }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: createGitMock(),
        utils: testUtils,
      });

      const text = response.content[0].text;
      assert.match(text, /projectDir tidak valid/i);
      assert.strictEqual(workflowState.state.commitAndPushCompleted, false);
    });
  } finally {
    setActiveProjectDir("");
    await cleanup(bukanRepo);
  }
});
