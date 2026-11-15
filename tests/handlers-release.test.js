import test from "node:test";
import assert from "node:assert/strict";
import { handleToolCall } from "../tools/handlers.js";
import { withWorkflowState, testUtils, createRequest, createGitMock, bindTaskToRepo } from "./test-helpers.js";
import { hasOnlyForeignChanges, parseStatusEntries } from "../git-helpers.js";

test("perform_release runs release command before pushing with tags", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
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
    await bindTaskToRepo(workflowState);
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
    await bindTaskToRepo(workflowState);
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

test("perform_release blocks when new changes detected", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
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
    await bindTaskToRepo(workflowState);
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
    await bindTaskToRepo(workflowState);
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
 * Regression introduced by the commit-attribution guard: after `commit_and_push`
 * deliberately LEAVES another session's work behind, the working tree really is
 * not clean. If `perform_release` still demanded a fully clean tree, a release
 * could never run - and its message would tell you to commit files that must not
 * be committed.
 */
async function releaseWithDirtyTree(workflowState, dirtyPaths, lines) {
  workflowState.state.currentPhase = "release";
  workflowState.state.commitAndPushCompleted = true;
  workflowState.state.readyCheckCompleted = true;
  workflowState.state.lastPushBranch = "main";
  workflowState.state.lastCommitMessage = "fix: something";
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

test("perform_release proceeds when only pre-task files are dirty", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    const { response, commands } = await releaseWithDirtyTree(
      workflowState,
      [" M knowledge/billing.yaml"],
      ["M knowledge/billing.yaml"],
    );

    const text = response.content[0].text;
    assert.ok(
      commands.some((command) => command.startsWith("npm run release")),
      "the release command must run",
    );
    assert.ok(
      !text.includes("Working tree not clean"),
      `the release must not be blocked, response: ${text.slice(0, 160)}`,
    );
    assert.match(text, /billing\.yaml/);
    assert.equal(workflowState.state.released, true);
  });
});

test("perform_release still refuses when a new file exists outside the baseline", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    const { response, commands } = await releaseWithDirtyTree(
      workflowState,
      [" M knowledge/billing.yaml", "?? new-feature.js"],
      ["M knowledge/billing.yaml", "?? new-feature.js"],
    );

    const text = response.content[0].text;
    // Two layers can block: resetToCommitIfWorkingChanges (earlier) or the
    // working-tree check. What matters: the release does not run.
    assert.match(text, /Detected new changes|Working tree not clean/);
    assert.match(text, /new-feature\.js/);
    assert.equal(
      commands.some((command) => command.startsWith("npm run release")),
      false,
      "the release must not run",
    );
    assert.notEqual(workflowState.state.released, true);
  });
});

test("perform_release loosens nothing when the baseline is empty", async () => {
  // Without a baseline there is no basis to call anything "not ours", so the
  // existing protection must stay intact.
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
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
        stdout: command === "git status --porcelain" ? " M whatever.js" : "",
      }),
      git: createGitMock({
        hasWorkingChanges: async () => true,
        getStatusOutput: async () => " M whatever.js",
        workingTreeSummary: () => ({ hasChanges: true, lines: ["M whatever.js"] }),
        hasOnlyForeignChanges,
      }),
      utils: testUtils,
    });

    assert.match(response.content[0].text, /Detected new changes|Working tree not clean/);
    assert.notEqual(workflowState.state.released, true);
  });
});
