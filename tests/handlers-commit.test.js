import test from "node:test";
import assert from "node:assert/strict";
import { handleToolCall } from "../tools/handlers.js";
import { withWorkflowState, testUtils, createRequest, createGitMock } from "./test-helpers.js";
import { foreignDirtyEntries } from "../git-helpers.js";

test("commit_and_push commits changes and pushes", async () => {
  await withWorkflowState(async (workflowState) => {
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

test("commit_and_push menolak men-stage berkas yang sudah kotor sebelum task", async () => {
  await withWorkflowState(async (workflowState) => {
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
