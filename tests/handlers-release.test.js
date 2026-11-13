import test from "node:test";
import assert from "node:assert/strict";
import { handleToolCall } from "../tools/handlers.js";
import { withWorkflowState, testUtils, createRequest, createGitMock } from "./test-helpers.js";
import { hasOnlyForeignChanges, parseStatusEntries } from "../git-helpers.js";

test("perform_release runs release command before pushing with tags", async () => {
  await withWorkflowState(async (workflowState) => {
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.lastPushBranch = "feature/split";
    workflowState.state.lastCommitMessage = "fix: address issue";
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      if (command === "git status --porcelain") {
        return { stdout: "" };
      }
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("perform_release", { command: "npm run release" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock(),
      utils: testUtils,
    });

    const releaseCommand = commands.find((command) => command.startsWith("npm run release"));
    assert.ok(releaseCommand, "release command should run");
    assert.ok(
      commands.some((command) => command.startsWith("git push --follow-tags")),
      "release should push tags"
    );
  });
});

test("perform_release accepts shorthand patch command", async () => {
  await withWorkflowState(async (workflowState) => {
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.lastCommitMessage = "fix: adjust labels";
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      if (command === "git status --porcelain") {
        return { stdout: "" };
      }
      return { stdout: "" };
    };

    await handleToolCall({
      request: createRequest("perform_release", { command: "patch" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock(),
      utils: testUtils,
    });

    const releaseCommand = commands.find((command) => command.startsWith("npm run release"));
    assert.ok(releaseCommand, "release command should run with patch");
  });
});

test("perform_release respects explicit releaseType option", async () => {
  await withWorkflowState(async (workflowState) => {
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.readyCheckCompleted = true;
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      if (command === "git status --porcelain") {
        return { stdout: "" };
      }
      return { stdout: "" };
    };

    await handleToolCall({
      request: createRequest("perform_release", {
        command: "npm run release",
        releaseType: "minor",
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock(),
      utils: testUtils,
    });

    const releaseCommand = commands.find((command) => command.startsWith("npm run release"));
    assert.ok(releaseCommand, "release command should run");
    assert.ok(
      releaseCommand.includes("-- --release-as minor"),
      "release command should append provided releaseType"
    );
  });
});

test("perform_release blocks when new changes detected", async () => {  await withWorkflowState(async (workflowState) => {
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.readyCheckCompleted = true;
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      if (command === "git status --porcelain") {
        return { stdout: "?? new-file.js" };
      }
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("perform_release", { command: "patch" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStatusOutput: async () => "?? new-file.js",
        containsTestFilesInStatus: (statusOutput) => statusOutput.includes("tests/"),
        workingTreeSummary: () => ({ hasChanges: true, lines: ["?? new-file.js"] }),
      }),
      utils: testUtils,
    });

    assert.ok(
      response.content[0].text.includes("run 'commit_and_push' again"),
      "response should instruct to recommit"
    );
    assert.equal(workflowState.state.currentPhase, "commit");
    assert.equal(workflowState.state.commitAndPushCompleted, false);
  });
});

test("perform_release requires commit_and_push completion when tree is clean", async () => {
  await withWorkflowState(async (workflowState) => {
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = false;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.lastPushBranch = "";
    workflowState.state.lastCommitMessage = "";
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      return { stdout: "" };
    };

    const response = await handleToolCall({
      request: createRequest("perform_release", { command: "npm run release" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: createGitMock({
        getLastCommitMessage: async () => "chore: already pushed",
        getStatusOutput: async () => "",
        containsTestFilesInStatus: (statusOutput) => statusOutput.includes("tests/"),
      }),
      utils: testUtils,
    });

    assert.ok(
      response.content[0].text.includes("commit_and_push"),
      "response should mention commit_and_push requirement"
    );
  });
});

test("skip_release records justification and advances to completion phase", async () => {
  await withWorkflowState(async (workflowState) => {
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.lastCommitMessage = "chore: docs";
    workflowState.state.releaseSkipped = false;
    workflowState.state.released = false;
    workflowState.state.releaseCommand = "";
    await workflowState.save();

    const response = await handleToolCall({
      request: createRequest("skip_release", { reason: "Python project – no npm release" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock(),
      utils: testUtils,
    });

    const text = response.content[0].text;
    assert.ok(text.includes("Release step skipped"), "response should mention release was skipped");
    assert.equal(workflowState.state.releaseSkipped, true);
    assert.equal(workflowState.state.releaseSkippedReason, "Python project – no npm release");
    assert.equal(workflowState.state.releaseCommand, "(skipped)");
    assert.equal(workflowState.state.currentPhase, "ready_to_complete");
    assert.equal(workflowState.state.released, false);
  });
});

/**
 * Regresi yang diperkenalkan guard atribusi commit: setelah `commit_and_push`
 * sengaja MENINGGALKAN pekerjaan sesi lain, working tree memang tidak bersih.
 * Kalau `perform_release` tetap menuntut tree bersih total, rilis tidak akan
 * pernah bisa dijalankan - dan pesannya menyuruh meng-commit berkas yang justru
 * tidak boleh di-commit.
 */
async function releaseWithDirtyTree(workflowState, dirtyPaths, lines) {
  workflowState.state.currentPhase = "release";
  workflowState.state.commitAndPushCompleted = true;
  workflowState.state.readyCheckCompleted = true;
  workflowState.state.lastPushBranch = "main";
  workflowState.state.lastCommitMessage = "fix: sesuatu";
  workflowState.state.dirtyAtStart = [{ code: "M", path: "knowledge/billing.yaml" }];
  await workflowState.save();

  const statusOutput = dirtyPaths.join("\n");
  const commands = [];
  const execStub = async (command) => {
    commands.push(command);
    if (command === "git status --porcelain") {
      return { stdout: statusOutput };
    }
    return { stdout: "" };
  };

  const response = await handleToolCall({
    request: createRequest("perform_release", { command: "npm run release" }),
    normalizeRequestArgs: (args) => ({ args, error: null }),
    workflowState,
    exec: execStub,
    git: createGitMock({
      hasWorkingChanges: async () => statusOutput.trim() !== "",
      getStatusOutput: async () => statusOutput,
      workingTreeSummary: () => ({
        hasChanges: statusOutput.trim() !== "",
        lines,
      }),
      hasOnlyForeignChanges,
      parseStatusEntries,
    }),
    utils: testUtils,
  });

  return { response, commands };
}

test("perform_release lanjut saat yang kotor hanya berkas dari sebelum task", async () => {
  await withWorkflowState(async (workflowState) => {
    const { response, commands } = await releaseWithDirtyTree(
      workflowState,
      [" M knowledge/billing.yaml"],
      ["M knowledge/billing.yaml"],
    );

    const text = response.content[0].text;
    assert.ok(
      commands.some((command) => command.startsWith("npm run release")),
      "perintah rilis harus dijalankan",
    );
    assert.ok(
      !text.includes("Working tree not clean"),
      `rilis tidak boleh diblokir, jawabannya: ${text.slice(0, 160)}`,
    );
    assert.match(text, /Dibiarkan tidak ter-commit/);
    assert.match(text, /billing\.yaml/);
    assert.equal(workflowState.state.released, true);
  });
});

test("perform_release tetap menolak bila ada berkas baru di luar baseline", async () => {
  await withWorkflowState(async (workflowState) => {
    const { response, commands } = await releaseWithDirtyTree(
      workflowState,
      [" M knowledge/billing.yaml", "?? fitur-baru.js"],
      ["M knowledge/billing.yaml", "?? fitur-baru.js"],
    );

    const text = response.content[0].text;
    // Dua lapisan bisa memblokir: resetToCommitIfWorkingChanges (lebih awal) atau
    // pemeriksaan working tree. Yang wajib: rilis tidak jalan.
    assert.match(text, /Detected new changes|Working tree not clean/);
    assert.match(text, /fitur-baru\.js/);
    assert.equal(
      commands.some((command) => command.startsWith("npm run release")),
      false,
      "rilis tidak boleh dijalankan",
    );
    assert.notEqual(workflowState.state.released, true);
  });
});

test("perform_release tidak melonggarkan apa pun bila baseline kosong", async () => {
  // Tanpa baseline tidak ada dasar menyebut sesuatu "bukan milik kita", jadi
  // perlindungan lama harus utuh.
  await withWorkflowState(async (workflowState) => {
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.lastCommitMessage = "fix: sesuatu";
    await workflowState.save();

    const response = await handleToolCall({
      request: createRequest("perform_release", { command: "npm run release" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async (command) => ({
        stdout: command === "git status --porcelain" ? " M apa-saja.js" : "",
      }),
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStatusOutput: async () => " M apa-saja.js",
        workingTreeSummary: () => ({ hasChanges: true, lines: ["M apa-saja.js"] }),
        hasOnlyForeignChanges,
      }),
      utils: testUtils,
    });

    assert.match(response.content[0].text, /Detected new changes|Working tree not clean/);
    assert.notEqual(workflowState.state.released, true);
  });
});
