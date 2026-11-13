import test from "node:test";
import assert from "node:assert/strict";
import { handleToolCall } from "../tools/handlers.js";
import { withWorkflowState, testUtils, createRequest, createGitMock, bindTaskToRepo } from "./test-helpers.js";

import { foreignDirtyEntries } from "../git-helpers.js";

test("commit_and_push commits changes and pushes", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.readyToCommit = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.testsSkipped = false;
    workflowState.state.testsCreated = true;
    workflowState.state.testsPassed = true;
    workflowState.state.currentPhase = "commit";
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("commit_and_push", { commitMessage: "" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStagedChanges: async () => [{ status: "M", path: "src/index.js" }],
        getStatusOutput: async () => "M tests/handlers.test.js\nM src/index.js",
        containsTestFilesInStatus: (statusOutput) => statusOutput.includes("tests/"),
      }),
      utils: testUtils,
    });

    const pushCommand = commands.find((command) => command.startsWith("git push"));
    assert.ok(pushCommand, "git push should be executed during commit");
    assert.ok(
      pushCommand.startsWith("git push origin"),
      "push command should target origin"
    );
    assert.equal(
      commands.some((command) => command.startsWith("git commit")),
      true,
      "git commit should be executed"
    );
    assert.ok(
      response.content[0].text.includes("Commit and push completed!"),
      "response should confirm commit and push"
    );
    assert.equal(workflowState.state.commitAndPushCompleted, true);
    assert.equal(workflowState.state.lastCommitMessage.length > 0, true);
    assert.equal(workflowState.state.currentPhase, "release");
  });
});

test("commit_and_push uses primary branch when no branch specified", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.readyToCommit = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.testsSkipped = false;
    workflowState.state.testsCreated = true;
    workflowState.state.testsPassed = true;
    workflowState.state.currentPhase = "commit";
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("commit_and_push", { commitMessage: "feat: test" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStagedChanges: async () => [{ status: "M", path: "src/index.js" }],
        getCurrentBranch: async () => "feature/test",
        getStatusOutput: async () => "M tests/handlers.test.js\nM src/index.js",
        containsTestFilesInStatus: (statusOutput) => statusOutput.includes("tests/"),
      }),
      utils: testUtils,
    });

    const pushCommand = commands.find((command) => command.startsWith("git push"));
    assert.ok(pushCommand, "git push should be executed");
    // 31 Okt 2026: sebelumnya test ini mengharapkan `main` padahal branch aktif
    // `feature/test`. Itu mengunci bug: tool mem-push main, git keluar 0 tanpa
    // mengirim apa pun, lalu melaporkan sukses. Branch aktif harus menang.
    assert.ok(
      /origin\s+['"]?feature\/test['"]?/.test(pushCommand),
      "push must target the active branch, not the primary branch"
    );
  });
});

test("commit_and_push falls back to master when HEAD is detached", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.readyToCommit = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.testsSkipped = false;
    workflowState.state.testsCreated = true;
    workflowState.state.testsPassed = true;
    workflowState.state.currentPhase = "commit";
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("commit_and_push", { commitMessage: "feat: test" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStagedChanges: async () => [{ status: "M", path: "src/index.js" }],
        // HEAD detached bukan branch, jadi tidak bisa di-push sebagai nama branch.
        getCurrentBranch: async () => "HEAD",
        getPrimaryBranch: async () => "master",
        getStatusOutput: async () => "M tests/handlers.test.js\nM src/index.js",
        containsTestFilesInStatus: (statusOutput) => statusOutput.includes("tests/"),
      }),
      utils: testUtils,
    });

    const pushCommand = commands.find((command) => command.startsWith("git push"));
    assert.ok(pushCommand, "git push should be executed");
    assert.ok(
      /origin\s+['"]?master['"]?/.test(pushCommand),
      "push should fall back to master when HEAD is detached"
    );
  });
});

test("commit_and_push recognizes already committed work", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.readyToCommit = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.testsSkipped = false;
    workflowState.state.testsCreated = true;
    workflowState.state.testsPassed = true;
    workflowState.state.currentPhase = "commit";
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("commit_and_push", { commitMessage: "" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => false,
        getLastCommitMessage: async () => "fix: previous work",
        getStatusOutput: async () => "",
        containsTestFilesInStatus: (statusOutput) => statusOutput.includes("tests/"),
      }),
      utils: testUtils,
    });

    assert.ok(
      response.content[0].text.includes("No changes detected"),
      "response should indicate no changes"
    );
    assert.equal(workflowState.state.commitAndPushCompleted, true);
    assert.equal(workflowState.state.currentPhase, "release");
  });
});

/**
 * Skenario yang benar-benar terjadi 31 Okt 2026: sesi lain sedang bekerja di
 * repo yang sama, lalu `git add .` menyeret pekerjaannya ke commit sesi ini.
 * Tidak ada yang bisa membedakannya setelah commit jadi.
 */
async function prepareCommitPhase(workflowState) {
  workflowState.state.readyToCommit = true;
  workflowState.state.readyCheckCompleted = true;
  workflowState.state.testsSkipped = false;
  workflowState.state.testsCreated = true;
  workflowState.state.testsPassed = true;
  workflowState.state.currentPhase = "commit";
  await workflowState.save();
}

const FOREIGN_STATUS = [
  " M knowledge/billing.yaml",
  " M tests/handlers-commit.test.js",
  " M src/index.js",
].join("\n");

/**
 * Kelas kesalahan yang sama dengan `agent_tool`: nilai baru yang KOSONG
 * tidak boleh menghapus nilai lama. Kalau `getLastCommitMessage` gagal membaca
 * (mis. riwayat git tidak ada), pesan commit yang sudah tercatat di state
 * tetap harus bertahan - bukan diganti string kosong.
 */
test("pesan commit lama tidak dihapus saat git tidak bisa membacanya", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.readyToCommit = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.testsSkipped = false;
    workflowState.state.testsCreated = true;
    workflowState.state.testsPassed = true;
    workflowState.state.currentPhase = "commit";
    workflowState.state.lastCommitMessage = "fix: pekerjaan sebelumnya";
    await workflowState.save();

    const execStub = async (command) => {
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("commit_and_push", { commitMessage: "" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => false,
        getLastCommitMessage: async () => "",
        getStatusOutput: async () => "",
        containsTestFilesInStatus: (statusOutput) => statusOutput.includes("tests/"),
      }),
      utils: testUtils,
    });

    assert.ok(
      response.content[0].text.includes("No changes detected"),
      "response harus tetap jalan tanpa mengubah pesan lama"
    );
    assert.equal(
      workflowState.state.lastCommitMessage,
      "fix: pekerjaan sebelumnya",
      "nilai lama tidak boleh terhapus oleh bacaan kosong"
    );
  });
});

/**
 * Factory board: `complete_task` menutup task-nya di Factory.
 *
 * Sebelum 2 November 2026, setiap `start_task` membuat task baru di Factory
 * tetapi tidak ada yang pernah menutupnya - 50 task menumpuk di `backlog`.
 * `complete_task` menutup state lokal saja, tidak menyentuh Factory.
 */
test("complete_task memindahkan task Factory ke done", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "commit";
    workflowState.state.taskDescription = "tugas dari papan";
    workflowState.state.dodFactoryTaskId = "rec-123";
    workflowState.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", revision: 0, evidence: "npm test → 851 pass" },
    ];
    await workflowState.save();

    const calls = [];
    const response = await handleToolCall({
      request: createRequest("complete_task", { commitMessage: "fix: selesai" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock({
        hasWorkingChanges: async () => false,
        getStatusOutput: async () => "",
      }),
      utils: testUtils,
      factoryCalls: calls,
      factory: {
        updateTaskStatus: async (recordId, status, extra = {}) => {
          calls.push({ kind: "updateTaskStatus", recordId, status, ...extra });
          return { recordId, status };
        },
      },
    });

    // updateTaskStatus dipanggil dengan status done untuk record yang benar
    const done = calls.find((c) => c.kind === "updateTaskStatus" && c.status === "done" && c.recordId === "rec-123");
    assert.ok(done, "updateTaskStatus(done) harus dipanggil untuk task Factory yang di-claim");
    assert.ok(
      response.content[0].text.toLowerCase().includes("done"),
      "respons harus menyebut bahwa task Factory ditutup",
    );
  });
});

test("complete_task tanpa dodFactoryTaskId tidak menyentuh Factory", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "commit";
    workflowState.state.taskDescription = "tugas manual";
    workflowState.state.dodFactoryTaskId = "";
    workflowState.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", revision: 0, evidence: "npm test" },
    ];
    await workflowState.save();

    const calls = [];
    await handleToolCall({
      request: createRequest("complete_task", { commitMessage: "fix: selesai" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock({
        hasWorkingChanges: async () => false,
        getStatusOutput: async () => "",
      }),
      utils: testUtils,
      factoryCalls: calls,
      factory: {
        updateTaskStatus: async (recordId, status, extra = {}) => {
          calls.push({ kind: "updateTaskStatus", recordId, status, ...extra });
          return { recordId, status };
        },
      },
    });

    assert.equal(
      calls.filter((c) => c.kind === "updateTaskStatus").length,
      0,
      "tanpa task Factory, tidak ada panggilan updateTaskStatus"
    );
  });
});

test("drop_task membatalkan task Factory dengan cancelled", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "commit";
    workflowState.state.taskDescription = "tugas dari papan";
    workflowState.state.dodFactoryTaskId = "rec-456";
    workflowState.state.definitionOfDone = [];
    await workflowState.save();

    const calls = [];
    const response = await handleToolCall({
      request: createRequest("drop_task", { reason: "diganti" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock({
        hasWorkingChanges: async () => false,
        getStatusOutput: async () => "",
      }),
      utils: testUtils,
      factoryCalls: calls,
      factory: {
        updateTaskStatus: async (recordId, status, extra = {}) => {
          calls.push({ kind: "updateTaskStatus", recordId, status, ...extra });
          return { recordId, status };
        },
      },
    });

    const cancelled = calls.find((c) => c.kind === "updateTaskStatus" && c.status === "cancelled" && c.recordId === "rec-456");
    assert.ok(cancelled, "drop_task harus membatalkan task Factory");
  });
});

test("complete_task closes Factory through its configured client without an injected adapter", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "commit";
    workflowState.state.taskDescription = "Close Factory automatically";
    workflowState.state.dodFactoryTaskId = "factory-task-1";
    workflowState.state.definitionOfDone = [{ id: "dod-1", text: "Factory closure verified", status: "done", revision: 0, evidence: "Test fixture" }];
    await workflowState.save();

    const priorUrl = process.env.FACTORY_URL;
    const priorToken = process.env.FACTORY_TOKEN;
    const priorFetch = globalThis.fetch;
    const requests = [];
    process.env.FACTORY_URL = "https://factory.test";
    process.env.FACTORY_TOKEN = "test-token";
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body || "{}") });
      return { ok: true, text: async () => JSON.stringify({ success: true }) };
    };
    try {
      const response = await handleToolCall({
        request: createRequest("complete_task", { commitMessage: "fix: close Factory automatically" }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: createGitMock({ hasWorkingChanges: async () => false, getStatusOutput: async () => "" }),
        utils: testUtils,
      });
      assert.doesNotMatch(response.content[0].text, /Factory tidak tertutup/);
      assert.ok(requests.some(({ body }) => body.action === "move_task" && body.id === "factory-task-1" && body.status === "done"), response.content[0].text);
    } finally {
      globalThis.fetch = priorFetch;
      if (priorUrl === undefined) delete process.env.FACTORY_URL; else process.env.FACTORY_URL = priorUrl;
      if (priorToken === undefined) delete process.env.FACTORY_TOKEN; else process.env.FACTORY_TOKEN = priorToken;
    }
  });
});

test("kegagalan menutup Factory tidak menggagalkan complete_task", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "commit";
    workflowState.state.taskDescription = "tugas dari papan";
    workflowState.state.dodFactoryTaskId = "rec-789";
    workflowState.state.definitionOfDone = [
      { id: "dod-1", text: "build lulus", status: "done", revision: 0, evidence: "x" },
    ];
    await workflowState.save();

    const calls = [];
    const response = await handleToolCall({
      request: createRequest("complete_task", { commitMessage: "fix: selesai" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock({
        hasWorkingChanges: async () => false,
        getStatusOutput: async () => "",
      }),
      utils: testUtils,
      factoryCalls: calls,
      factory: {
        updateTaskStatus: async () => {
          throw new Error("Factory tidak bisa dihubungi");
        },
      },
    });

    // State lokal tetap tertutup meskipun Factory gagal
    assert.equal(workflowState.state.currentPhase, "idle", "state lokal tetap reset");
    assert.ok(
      response.content[0].text.includes("Factory"),
      "respons harus menyebut bahwa task Factory tidak tertutup",
    );
  });
});

test("commit_and_push menolak men-stage berkas yang sudah kotor sebelum task", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    await prepareCommitPhase(workflowState);
    workflowState.state.dirtyAtStart = [{ code: "M", path: "knowledge/billing.yaml" }];
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("commit_and_push", { commitMessage: "feat: test" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStagedChanges: async () => [{ status: "M", path: "src/index.js" }],
        getStatusOutput: async () => FOREIGN_STATUS,
        foreignDirtyEntries,
      }),
      utils: testUtils,
    });

    const text = response.content[0].text;
    assert.match(text, /Refusing to stage/, "harus menolak, bukan lanjut commit");
    assert.match(text, /knowledge\/billing\.yaml/, "berkas asing harus disebut namanya");
    assert.equal(
      commands.some((command) => command.startsWith("git add") || command === "git add"),
      false,
      "tidak boleh ada git add"
    );
    assert.equal(
      commands.some((command) => command.startsWith("git commit")),
      false,
      "tidak boleh ada commit"
    );
    assert.notEqual(workflowState.state.commitAndPushCompleted, true);
  });
});

test("commit_and_push dengan 'paths' hanya men-stage berkas yang disebut", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    await prepareCommitPhase(workflowState);
    workflowState.state.dirtyAtStart = [{ code: "M", path: "knowledge/billing.yaml" }];
    await workflowState.save();

    const calls = [];
    const execStub = async (command, options = {}) => {
      calls.push({ command, options });
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("commit_and_push", {
        commitMessage: "feat: test",
        paths: ["src/index.js", "tests/handlers-commit.test.js"],
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStagedChanges: async () => [{ status: "M", path: "src/index.js" }],
        getStatusOutput: async () => FOREIGN_STATUS,
        foreignDirtyEntries,
      }),
      utils: testUtils,
    });

    const addCall = calls.find((call) => call.options?.arguments?.[0] === "add");
    assert.ok(addCall, "git add harus dijalankan");
    assert.deepEqual(addCall.options.arguments, [
      "add",
      "--",
      "src/index.js",
      "tests/handlers-commit.test.js",
    ]);
    assert.equal(
      calls.some((call) => call.command === "git add ."),
      false,
      "tidak boleh memakai 'git add .' saat paths diberikan"
    );
    const text = response.content[0].text;
    assert.match(text, /Commit and push completed/);
    assert.match(text, /knowledge\/billing\.yaml/, "berkas yang ditinggalkan harus disebut");
  });
});

test("commit_and_push boleh men-stage semuanya bila includeForeign: true", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    await prepareCommitPhase(workflowState);
    workflowState.state.dirtyAtStart = [{ code: "M", path: "knowledge/billing.yaml" }];
    await workflowState.save();

    const calls = [];
    const execStub = async (command, options = {}) => {
      calls.push({ command, options });
      return { stdout: "" };
    };

    await handleToolCall({
      request: createRequest("commit_and_push", {
        commitMessage: "feat: test",
        includeForeign: true,
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStagedChanges: async () => [{ status: "M", path: "src/index.js" }],
        getStatusOutput: async () => FOREIGN_STATUS,
        foreignDirtyEntries,
      }),
      utils: testUtils,
    });

    assert.ok(
      calls.some((call) => call.command === "git add ."),
      "includeForeign harus memakai perilaku lama"
    );
  });
});

test("commit_and_push tidak menyebut berkas yang baru saja di-commit lewat paths", async () => {
  // Baseline mencatat keadaan SEBELUM task. Berkas yang kita edit sendiri
  // sebelum start_task karena itu ikut tercatat sebagai "sudah kotor", dan
  // versi pertama catatan ini menyebutnya "not committed" padahal baru saja
  // di-commit - laporan yang berlawanan dengan kenyataan.
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    await prepareCommitPhase(workflowState);
    workflowState.state.dirtyAtStart = [
      { code: "M", path: "knowledge/billing.yaml" },
      { code: "M", path: "tests/handlers-commit.test.js" },
    ];
    await workflowState.save();

    const calls = [];
    const execStub = async (command, options = {}) => {
      calls.push({ command, options });
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("commit_and_push", {
        commitMessage: "feat: test",
        paths: ["tests/handlers-commit.test.js"],
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStagedChanges: async () => [{ status: "M", path: "tests/handlers-commit.test.js" }],
        getStatusOutput: async () => FOREIGN_STATUS,
        foreignDirtyEntries,
      }),
      utils: testUtils,
    });

    const text = response.content[0].text;
    const note = text.includes("Left unstaged") ? text.split("Left unstaged")[1] : "";
    assert.match(text, /billing\.yaml/, "berkas yang benar-benar tertinggal harus tetap disebut");
    assert.ok(
      !note.includes("tests/handlers-commit.test.js"),
      `berkas yang ikut di-commit tidak boleh disebut tertinggal, catatan: ${note.slice(0, 120)}`,
    );
  });
});

test("commit_and_push tidak berubah bila baseline kosong", async () => {
  // Task tanpa baseline (state lama, atau start_task tanpa git) harus tetap
  // berperilaku seperti sebelumnya - kalau tidak, setiap task jadi terblokir.
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    await prepareCommitPhase(workflowState);
    await workflowState.save();

    const calls = [];
    const execStub = async (command, options = {}) => {
      calls.push({ command, options });
      return { stdout: "" };
    };

    await handleToolCall({
      request: createRequest("commit_and_push", { commitMessage: "feat: test" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStagedChanges: async () => [{ status: "M", path: "src/index.js" }],
        getStatusOutput: async () => FOREIGN_STATUS,
        foreignDirtyEntries,
      }),
      utils: testUtils,
    });

    assert.ok(calls.some((call) => call.command === "git add ."));
  });
});
