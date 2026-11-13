import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleToolCall } from "../tools/handlers.js";
import { resolveStateFile, WorkflowState } from "../workflow-state.js";
import { withWorkflowState, testUtils, createRequest, createGitMock, bindTaskToRepo } from "./test-helpers.js";

/**
 * Workflow harus melaporkan KEADAAN SEBENARNYA, bukan yang diharapkannya.
 *
 * Tiga kebohongan nyata pada 31 Oktober 2026:
 *
 *   1. `perform_release` menyusun `npm run release -- --release-as null` ketika
 *      tipe rilis tidak terdeteksi. Hasilnya tag `vnull` dan `package.json`
 *      berversi `null`. Perintahnya sendiri tidak pernah ditolak.
 *
 *   2. Setelah rilis, `git push --follow-tags` gagal. Commit rilis dan tag-nya
 *      tertinggal di mesin, tetapi jawabannya tidak menyebut apa yang
 *      tertinggal, sehingga tidak jelas apa yang harus dibereskan.
 *
 *   3. `commit_and_push` mencetak "Repo: ..." dari variabel global yang bisa
 *      berubah, bukan dari repo tempat git benar-benar berjalan. Sekali waktu
 *      ia melaporkan `portal-beautyworld` untuk commit yang masuk ke repo lain.
 *      Laporan seperti itu membuat agen percaya commit-nya ada di tempat yang
 *      salah.
 */

// ---------------------------------------------------------------------------
// 1. Rilis tanpa tipe yang sah
// ---------------------------------------------------------------------------

test("perform_release menolak rilis saat tipe rilis tidak bisa ditentukan", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.lastCommitMessage = "chore: tanpa tipe yang dikenali";
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      if (command === "git status --porcelain") return { stdout: "" };
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("perform_release", { command: "npm run release" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock(),
      // Tipe rilis tidak bisa disimpulkan dari commit.
      utils: { ...testUtils, determineReleaseTypeFromCommit: () => "" },
    });

    const text = response.content.map((part) => part.text).join("\n");

    assert.ok(
      !commands.some((command) => command.includes("null")),
      `Perintah rilis tidak boleh mengandung "null". Perintah yang dijalankan: ${JSON.stringify(commands)}`
    );

    assert.ok(
      !commands.some((command) => command.startsWith("npm run release")),
      "Rilis tidak boleh dijalankan tanpa tipe yang sah"
    );

    assert.match(
      text,
      /releaseType|tipe rilis/i,
      "Pesan harus meminta tipe rilis yang sah, bukan diam-diam memakai null"
    );
  });
});

test("perform_release tetap berjalan normal saat tipe rilis sah", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.readyCheckCompleted = true;
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      if (command === "git status --porcelain") return { stdout: "" };
      return { stdout: "" };
    };

    await handleToolCall({
      request: createRequest("perform_release", { command: "npm run release:patch" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock(),
      utils: testUtils,
    });

    assert.ok(commands.some((command) => command === "npm run release:patch"));
    assert.ok(!commands.some((command) => command.includes("null")));
  });
});

// ---------------------------------------------------------------------------
// 2. Push rilis gagal
// ---------------------------------------------------------------------------

test("perform_release menyebut commit dan tag yang tertinggal saat push gagal", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.lastPushBranch = "main";
    await workflowState.save();

    const oldHead = "a".repeat(40);
    const newHead = "b".repeat(40);
    let headCalls = 0;

    const execStub = async (command) => {
      if (command === "git status --porcelain") return { stdout: "" };
      if (command.startsWith("git push")) {
        const error = new Error("push ditolak");
        error.stderr = "! [rejected] main -> main (non-fast-forward)";
        throw error;
      }
      if (command === "git describe --tags --abbrev=0") return { stdout: "v1.2.3\n" };
      // Rilis membuat commit baru: HEAD berubah antara sebelum dan sesudah.
      if (command === "git rev-parse HEAD") {
        headCalls += 1;
        return { stdout: (headCalls === 1 ? oldHead : newHead) + "\n" };
      }
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("perform_release", { command: "npm run release:patch" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock(),
      utils: testUtils,
    });

    const text = response.content.map((part) => part.text).join("\n");

    assert.match(text, /v1\.2\.3/, "Pesan harus menyebut tag yang tertinggal di mesin");
    assert.match(text, /bbbbbbbb/, "Pesan harus menyebut commit rilis yang tertinggal");
    assert.match(text, /git push/i, "Pesan harus memberi perintah pemulihan");
    assert.ok(!text.includes("✅"), "Push yang gagal tidak boleh dilaporkan sebagai sukses");
  });
});

// ---------------------------------------------------------------------------
// 3. Repo yang dilaporkan harus repo yang benar-benar dipakai git
// ---------------------------------------------------------------------------

async function fakeRepo(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  await mkdir(path.join(dir, ".git"), { recursive: true });
  return dir;
}

test("commit_and_push menolak saat git berjalan di repo yang berbeda dari projectDir", async () => {
  const requested = await fakeRepo("repo-diminta-");
  const actual = await fakeRepo("repo-nyata-");

  try {
    await withWorkflowState(async (workflowState) => {
      await bindTaskToRepo(workflowState, requested);
      workflowState.state.readyToCommit = true;
      workflowState.state.readyCheckCompleted = true;
      workflowState.state.testsCreated = true;
      workflowState.state.testsPassed = true;
      workflowState.state.currentPhase = "commit";
      await workflowState.save();

      const git = createGitMock({
        getToplevel: async () => actual,
        hasWorkingChanges: async () => true,
        getStatusOutput: async () => "M tests/contoh.test.js",
      });

      const response = await handleToolCall({
        request: createRequest("commit_and_push", {
          commitMessage: "fix: contoh",
          projectDir: requested,
        }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git,
        utils: testUtils,
      });

      const text = response.content.map((part) => part.text).join("\n");

      assert.match(text, /berbeda|mismatch|bukan repo/i, "Harus menolak, bukan commit diam-diam");
      assert.ok(text.includes(actual), "Pesan harus menyebut repo yang benar-benar dipakai");
      assert.equal(workflowState.state.commitAndPushCompleted, false);
    });
  } finally {
    await rm(requested, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test("commit_and_push melaporkan repo yang sama saat git memang di sana", async () => {
  const repo = await fakeRepo("repo-sama-");

  try {
    await withWorkflowState(async (workflowState) => {
      await bindTaskToRepo(workflowState, repo);
      workflowState.state.readyToCommit = true;
      workflowState.state.readyCheckCompleted = true;
      workflowState.state.testsCreated = true;
      workflowState.state.testsPassed = true;
      workflowState.state.currentPhase = "commit";
      await workflowState.save();

      const git = createGitMock({
        getToplevel: async () => repo,
        hasWorkingChanges: async () => true,
        getStatusOutput: async () => "M tests/contoh.test.js",
      });

      const response = await handleToolCall({
        request: createRequest("commit_and_push", {
          commitMessage: "fix: contoh",
          projectDir: repo,
        }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git,
        utils: testUtils,
      });

      const text = response.content.map((part) => part.text).join("\n");

      assert.ok(text.includes(repo), "Laporan harus menyebut repo tempat git berjalan");
      assert.equal(workflowState.state.commitAndPushCompleted, true);
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. "No changes detected" tidak boleh berarti "sudah selesai"
// ---------------------------------------------------------------------------

test("commit_and_push tidak mengaku sudah commit saat tidak ada yang di-commit", async () => {
  const repo = await fakeRepo("repo-bersih-");

  try {
    await withWorkflowState(async (workflowState) => {
      await bindTaskToRepo(workflowState, repo);
      workflowState.state.readyToCommit = true;
      workflowState.state.readyCheckCompleted = true;
      workflowState.state.testsCreated = true;
      workflowState.state.testsPassed = true;
      workflowState.state.currentPhase = "commit";
      await workflowState.save();

      // Working tree bersih dan HEAD sudah ada di remote: tidak ada yang salah,
      // tetapi panggilan ini juga tidak membuat commit apa pun.
      const git = createGitMock({
        getToplevel: async () => repo,
        hasWorkingChanges: async () => false,
        getLastCommitMessage: async () => "chore(release): 2.38.47",
      });

      const response = await handleToolCall({
        request: createRequest("commit_and_push", { projectDir: repo }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git,
        utils: testUtils,
      });

      const text = response.content.map((part) => part.text).join("\n");

      assert.match(
        text,
        /tidak membuat commit|no commit was made|tidak ada commit baru/i,
        "Jawaban harus menyatakan terus terang bahwa panggilan ini tidak membuat commit. " +
          "Kata 'Assuming commit and push already completed' membuat agen percaya " +
          "pekerjaannya sudah masuk padahal tidak ada yang dikerjakan."
      );

      assert.doesNotMatch(
        text,
        /Assuming commit and push already completed/i,
        "Kalimat 'Assuming ... already completed' adalah klaim tanpa bukti"
      );
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("commit_and_push menyebut tidak ada task aktif saat state idle", async () => {
  const repo = await fakeRepo("repo-idle-");

  try {
    await withWorkflowState(async (workflowState) => {
      await bindTaskToRepo(workflowState);
      workflowState.state.readyToCommit = true;
      workflowState.state.readyCheckCompleted = true;
      workflowState.state.testsCreated = true;
      workflowState.state.testsPassed = true;
      // currentPhase dibiarkan "idle": tidak ada task yang sedang dikerjakan.
      await workflowState.save();

      const git = createGitMock({
        getToplevel: async () => repo,
        hasWorkingChanges: async () => false,
      });

      const response = await handleToolCall({
        request: createRequest("commit_and_push", { projectDir: repo }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git,
        utils: testUtils,
      });

      const text = response.content.map((part) => part.text).join("\n");

      assert.match(
        text,
        /idle|tidak ada task aktif|no active task/i,
        "Saat state idle, jawaban harus menyebut tidak ada task aktif - itu sebabnya " +
          "tidak ada yang di-commit."
      );

      assert.doesNotMatch(
        text,
        /Assuming commit and push already completed/i,
        "Tidak ada alasan untuk mengaku commit selesai saat tidak ada task aktif"
      );
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. State tes tidak boleh menyentuh state milik repo
// ---------------------------------------------------------------------------

test("state selama tes berada di direktori sementara, bukan .state milik repo", async () => {
  // Penjaga statis: kalau seseorang menghapus flag --import, isolasi hilang
  // tanpa suara dan suite kembali menghapus task yang sedang berjalan.
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(
    String(pkg.scripts?.test || ""),
    /--import\s+\.\/tests\/setup-env\.js/,
    "Skrip 'test' harus memuat --import ./tests/setup-env.js. Tanpa itu setiap " +
      "`new WorkflowState()` menulis ke .state/workflow-state.json milik repo dan " +
      "menghapus task yang sedang berjalan."
  );

  if (!process.env.DEV_WORKFLOW_TEST_STATE_DIR) {
    // Berkas ini dijalankan langsung (bukan lewat `npm test`), jadi preload
    // belum aktif. Yang diperiksa di atas sudah cukup untuk keadaan itu.
    return;
  }

  const resolved = resolveStateFile();

  assert.ok(
    path.resolve(resolved).startsWith(path.resolve(process.env.DEV_WORKFLOW_TEST_STATE_DIR)),
    `State tes harus berada di direktori sementara. Terbaca: ${resolved}`
  );
});

test("cermin kompatibilitas tidak menyentuh .state milik repo selama tes", async () => {
  // Mekanisme sebenarnya yang merusak: `ensureCompatibilityLinks()` selalu
  // menulis ke `<paket>/.state/workflow-state.json`, di mana pun state aslinya
  // berada. Jadi state repo tertimpa bahkan oleh tes yang memakai direktori
  // sementara.
  const repoState = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".state",
    "workflow-state.json"
  );

  const before = await readFile(repoState, "utf8").catch(() => null);
  const dir = await mkdtemp(path.join(tmpdir(), "compat-guard-"));
  const file = path.join(dir, "workflow-state.json");

  try {
    const state = new WorkflowState(file);
    await state.load();
    state.state.taskDescription = "task dari tes, tidak boleh bocor ke repo";
    await state.save();
    await state.ensurePrimaryFile();

    const after = await readFile(repoState, "utf8").catch(() => null);

    assert.equal(
      after,
      before,
      "State milik repo berubah selama tes. Cermin kompatibilitas harus dimatikan " +
        "lewat DEV_WORKFLOW_NO_COMPAT_LINKS=1."
    );
    assert.equal(
      process.env.DEV_WORKFLOW_NO_COMPAT_LINKS,
      "1",
      "Preload tes harus menetapkan DEV_WORKFLOW_NO_COMPAT_LINKS=1"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
