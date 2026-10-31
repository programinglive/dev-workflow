import test from "node:test";
import assert from "node:assert";

import { handleToolCall } from "../tools/handlers.js";
import { withWorkflowState, testUtils, createRequest, createGitMock } from "./test-helpers.js";

// Kenapa tes ini ada
// ------------------
// 31 Oktober 2026, `commit_and_push` menjawab:
//
//   ✅ Commit and push completed!
//   Pushed to: main
//
// Padahal tidak ada yang ter-push. Penyebabnya:
//
//   const branchForPush = requestedBranch || primaryBranch || currentBranch;
//
// `getPrimaryBranch()` selalu menjawab "main" bila `origin/main` ada, TANPA
// melihat branch aktif. Di worktree yang sedang di `feat/...`, tool menjalankan
// `git push origin main`. Karena `main` lokal sudah sama dengan `origin/main`,
// perintah itu keluar 0 tanpa memindahkan apa pun - dan tool melaporkan sukses.
//
// Dua commit nyata tidak pernah terkirim dan baru masuk setelah push manual.
// Ini kelas bug "sukses palsu" yang justru ingin dicegah tool ini.
//
// Yang dikunci sekarang:
//   1. push menargetkan branch AKTIF, bukan primary branch
//   2. exit code 0 dari `git push` bukan bukti; SHA HEAD harus ada di remote
//   3. "No changes detected" tidak boleh berarti "sudah ter-push" tanpa bukti

const HEAD = "1".repeat(40);
const REMOTE_OLD = "2".repeat(40);

function request(args = {}) {
  return createRequest("commit_and_push", { commitMessage: "fix: sesuatu", ...args });
}

async function readyState(workflowState) {
  workflowState.state.readyToCommit = true;
  workflowState.state.readyCheckCompleted = true;
  workflowState.state.testsSkipped = false;
  workflowState.state.testsCreated = true;
  workflowState.state.testsPassed = true;
  workflowState.state.currentPhase = "commit";
  await workflowState.save();
}

async function run(workflowState, { gitOverrides = {}, args = {}, commands = [] } = {}) {
  const execStub = async (command) => {
    commands.push(command);
    return { stdout: "" };
  };
  const response = await handleToolCall({
    request: request(args),
    normalizeRequestArgs: (a) => ({ args: a, error: null }),
    workflowState,
    exec: execStub,
    git: createGitMock({
      hasWorkingChanges: async () => true,
      getStagedChanges: async () => [{ status: "M", path: "src/index.js" }],
      getStatusOutput: async () => "M tests/x.test.js\nM src/index.js",
      ...gitOverrides,
    }),
    utils: testUtils,
  });
  return { text: response.content[0].text, commands };
}

test("REGRESI: push menargetkan branch aktif, bukan primary branch", async () => {
  await withWorkflowState(async (workflowState) => {
    await readyState(workflowState);
    const commands = [];

    const { text } = await run(workflowState, {
      commands,
      gitOverrides: {
        getCurrentBranch: async () => "feat/pocketbase-activity-journal",
        getPrimaryBranch: async () => "main",
        getHeadSha: async () => HEAD,
        getRemoteBranchSha: async (branch) => {
          assert.strictEqual(branch, "feat/pocketbase-activity-journal",
            "verifikasi harus memeriksa branch yang benar-benar dipush");
          return HEAD;
        },
      },
    });

    const push = commands.find((c) => c.startsWith("git push"));
    assert.ok(push, "git push harus dijalankan");
    assert.match(push, /origin\s+['"]?feat\/pocketbase-activity-journal['"]?/,
      "harus push branch aktif, bukan main");
    assert.doesNotMatch(push, /\bmain\b/, "main tidak boleh jadi target push di branch fitur");
    assert.match(text, /Commit and push completed/);
  });
});

test("REGRESI: push exit 0 tanpa mengirim apa pun harus dilaporkan GAGAL", async () => {
  // Skenario persis 31 Okt 2026: git push keluar 0, remote tidak bergerak.
  await withWorkflowState(async (workflowState) => {
    await readyState(workflowState);

    const { text } = await run(workflowState, {
      gitOverrides: {
        getCurrentBranch: async () => "feat/x",
        getHeadSha: async () => HEAD,
        getRemoteBranchSha: async () => REMOTE_OLD,
      },
    });

    assert.doesNotMatch(text, /Commit and push completed/,
      "tidak boleh melaporkan sukses bila remote tidak menerima HEAD");
    assert.match(text, /TIDAK ter-push/, "harus menyatakan dengan jelas bahwa push gagal");
    assert.match(text, /origin\/feat\/x/, "harus menyebut branch yang diperiksa");
    assert.strictEqual(workflowState.state.commitAndPushCompleted, false,
      "workflow tidak boleh maju ke tahap release");
  });
});

test("push gagal dilaporkan bila branch remote belum ada", async () => {
  await withWorkflowState(async (workflowState) => {
    await readyState(workflowState);

    const { text } = await run(workflowState, {
      gitOverrides: {
        getCurrentBranch: async () => "feat/baru",
        getRemoteBranchSha: async () => {
          throw new Error("unknown revision origin/feat/baru");
        },
      },
    });

    assert.doesNotMatch(text, /Commit and push completed/);
    assert.match(text, /tidak ditemukan di remote/);
    assert.strictEqual(workflowState.state.commitAndPushCompleted, false);
  });
});

test("sukses dilaporkan hanya setelah SHA remote cocok dengan HEAD", async () => {
  await withWorkflowState(async (workflowState) => {
    await readyState(workflowState);

    const { text } = await run(workflowState, {
      gitOverrides: {
        getCurrentBranch: async () => "feat/ok",
        getHeadSha: async () => HEAD,
        getRemoteBranchSha: async () => HEAD,
      },
    });

    assert.match(text, /Commit and push completed/);
    assert.match(text, /verified at 11111111/, "harus menyebut SHA yang terverifikasi");
    assert.strictEqual(workflowState.state.commitAndPushCompleted, true);
    assert.strictEqual(workflowState.state.lastPushBranch, "feat/ok");
  });
});

test("branch eksplisit tetap menang atas branch aktif", async () => {
  await withWorkflowState(async (workflowState) => {
    await readyState(workflowState);
    const commands = [];

    await run(workflowState, {
      commands,
      args: { branch: "release/1.0" },
      gitOverrides: {
        getCurrentBranch: async () => "feat/x",
        getRemoteBranchSha: async (branch) => {
          assert.strictEqual(branch, "release/1.0");
          return HEAD;
        },
      },
    });

    const push = commands.find((c) => c.startsWith("git push"));
    assert.match(push, /origin\s+['"]?release\/1\.0['"]?/);
  });
});

test("HEAD detached memakai primary branch", async () => {
  await withWorkflowState(async (workflowState) => {
    await readyState(workflowState);
    const commands = [];

    await run(workflowState, {
      commands,
      gitOverrides: {
        getCurrentBranch: async () => "HEAD",
        getPrimaryBranch: async () => "main",
      },
    });

    const push = commands.find((c) => c.startsWith("git push"));
    assert.match(push, /origin\s+['"]?main['"]?/);
  });
});

test("REGRESI: tanpa perubahan, HEAD yang belum ter-push tidak dianggap selesai", async () => {
  // "No changes detected" bukan bukti bahwa commit sudah terkirim.
  await withWorkflowState(async (workflowState) => {
    await readyState(workflowState);

    const { text } = await run(workflowState, {
      gitOverrides: {
        hasWorkingChanges: async () => false,
        getCurrentBranch: async () => "feat/x",
        getLastCommitMessage: async () => "fix: sebelumnya",
        getHeadSha: async () => HEAD,
        getRemoteBranchSha: async () => REMOTE_OLD,
      },
    });

    assert.doesNotMatch(text, /already completed/,
      "tidak boleh menyimpulkan selesai bila remote tertinggal");
    assert.match(text, /BELUM ada di remote/);
    assert.strictEqual(workflowState.state.commitAndPushCompleted, false);
  });
});

test("tanpa perubahan dan remote sudah sinkron: selesai dengan bukti", async () => {
  await withWorkflowState(async (workflowState) => {
    await readyState(workflowState);

    const { text } = await run(workflowState, {
      gitOverrides: {
        hasWorkingChanges: async () => false,
        getCurrentBranch: async () => "feat/x",
        getLastCommitMessage: async () => "fix: sebelumnya",
        getHeadSha: async () => HEAD,
        getRemoteBranchSha: async () => HEAD,
      },
    });

    assert.match(text, /No changes detected/);
    assert.match(text, /verified on remote/);
    assert.strictEqual(workflowState.state.commitAndPushCompleted, true);
  });
});
