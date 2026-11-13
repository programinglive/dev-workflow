import test from "node:test";
import assert from "node:assert/strict";
import { handleToolCall } from "../tools/handlers.js";
import {
  withWorkflowState,
  testUtils,
  createRequest,
  createGitMock,
  bindTaskToRepo,
} from "./test-helpers.js";
import { exec } from "../exec.js";

test("perform_release records release idempotently without re-running npm run release when HEAD already has a release tag/commit", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "release";
    workflowState.state.commitAndPushCompleted = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.lastPushBranch = "master";
    workflowState.state.lastCommitMessage = "chore(release): 5.0.12 🚀";
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      if (command === "git status --porcelain") {
        return { stdout: "" };
      }
      return { stdout: "Everything up-to-date\n" };
    };

    const gitMock = createGitMock({
      hasWorkingChanges: async () => false,
      getCurrentBranch: async () => "master",
      getPrimaryBranch: async () => "master",
      getHeadSha: async () => "14e4567bd1111111111111111111111111111111",
      getRemoteBranchSha: async () => "14e4567bd1111111111111111111111111111111",
      getLastCommitMessage: async () => "chore(release): 5.0.12 🚀",
      getTagsAtHead: async () => ["v5.0.12"],
      isCommitOnRemoteBranch: async () => true,
    });

    const response = await handleToolCall({
      request: createRequest("perform_release", {
        version: "5.0.12",
        releaseNotes: "Release v5.0.12 for appointment cart sync",
        command: "npm run release:patch",
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: gitMock,
      utils: testUtils,
    });

    const releaseCmdCalls = commands.filter((cmd) =>
      cmd.startsWith("npm run release")
    );
    assert.equal(
      releaseCmdCalls.length,
      0,
      `Expected 0 npm run release executions when HEAD is already released, got: ${JSON.stringify(releaseCmdCalls)}`
    );

    const text = response.content[0].text;
    assert.match(text, /Release Complete|already exists|recorded/i);
    assert.equal(workflowState.state.released, true);
    assert.equal(workflowState.state.currentPhase, "ready_to_complete");
    assert.equal(workflowState.state.releaseVersion, "5.0.12");
  });
});

test("perform_release breaks deadlock when commitAndPushCompleted is false on an already-released clean HEAD", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "ready_to_commit";
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.commitAndPushCompleted = false;
    workflowState.state.released = false;
    await workflowState.save();

    const commands = [];
    const execStub = async (command) => {
      commands.push(command);
      return { stdout: "" };
    };

    const gitMock = createGitMock({
      hasWorkingChanges: async () => false,
      getCurrentBranch: async () => "master",
      getPrimaryBranch: async () => "master",
      getHeadSha: async () => "14e4567bd1111111111111111111111111111111",
      getRemoteBranchSha: async () => "14e4567bd1111111111111111111111111111111",
      getLastCommitMessage: async () => "chore(release): 5.0.7 🚀",
      getTagsAtHead: async () => ["v5.0.7"],
      isCommitOnRemoteBranch: async () => true,
    });

    const response = await handleToolCall({
      request: createRequest("perform_release", {
        version: "5.0.7",
        releaseNotes: "Appointment cart release",
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: gitMock,
      utils: testUtils,
    });

    const text = response.content[0].text;
    assert.doesNotMatch(text, /Please run 'commit_and_push'/);
    assert.equal(workflowState.state.commitAndPushCompleted, true);
    assert.equal(workflowState.state.released, true);
    assert.equal(workflowState.state.currentPhase, "ready_to_complete");
  });
});

test("exec.js resolves promptly after direct child exit even when a grandchild keeps inherited stdio pipes open", async () => {
  const startMs = Date.now();
  const cmd = `${JSON.stringify(process.execPath)} -e "const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:'inherit',detached:true}); child.unref(); console.log('direct-child-finished');"`;
  const { stdout } = await exec(cmd, { timeout: 5000 });
  const elapsedMs = Date.now() - startMs;

  assert.match(stdout, /direct-child-finished/);
  assert.ok(
    elapsedMs < 3500,
    `Expected exec() to resolve promptly after direct child exit without waiting 8s for grandchild stdio, but took ${elapsedMs}ms`
  );
});

test("commit_and_push with clean working tree pushes unpushed HEAD to remote and succeeds", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "commit";
    workflowState.state.readyToCommit = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.commitAndPushCompleted = false;
    await workflowState.save();

    let pushedToRemote = false;
    const headSha = "14e4567bd1111111111111111111111111111111";
    const oldRemoteSha = "a7fac7e1a0000000000000000000000000000000";

    const execStub = async (command) => {
      if (command.startsWith("git push")) {
        pushedToRemote = true;
        return { stdout: "To origin\n   a7fac7e1..14e4567b  master -> master\n" };
      }
      return { stdout: "" };
    };

    const gitMock = createGitMock({
      hasWorkingChanges: async () => false,
      getCurrentBranch: async () => "master",
      getPrimaryBranch: async () => "master",
      getHeadSha: async () => headSha,
      getRemoteBranchSha: async () => (pushedToRemote ? headSha : oldRemoteSha),
      isCommitOnRemoteBranch: async () => pushedToRemote,
      getLastCommitMessage: async () => "fix(cart): sync appointment items",
    });

    const response = await handleToolCall({
      request: createRequest("commit_and_push", {
        commitMessage: "fix(cart): sync appointment items",
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: execStub,
      git: gitMock,
      utils: testUtils,
    });

    const text = response.content[0].text;
    assert.doesNotMatch(text, /HEAD BELUM ada di remote/);
    assert.equal(
      pushedToRemote,
      true,
      "Expected commit_and_push to run git push when working tree is clean and remote lags behind HEAD"
    );
    assert.equal(workflowState.state.commitAndPushCompleted, true);
  });
});

test("commit_and_push succeeds when isCommitOnRemoteBranch confirms HEAD is already on remote despite stale local tracking ref", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "commit";
    workflowState.state.readyToCommit = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.commitAndPushCompleted = false;
    await workflowState.save();

    const headSha = "14e4567bd1111111111111111111111111111111";
    const staleLocalTrackingSha = "a7fac7e1a0000000000000000000000000000000";

    const gitMock = createGitMock({
      hasWorkingChanges: async () => false,
      getCurrentBranch: async () => "master",
      getPrimaryBranch: async () => "master",
      getHeadSha: async () => headSha,
      getRemoteBranchSha: async () => staleLocalTrackingSha,
      isCommitOnRemoteBranch: async () => true,
      getLastCommitMessage: async () => "fix(cart): sync appointment items",
    });

    const response = await handleToolCall({
      request: createRequest("commit_and_push", {
        commitMessage: "fix(cart): sync appointment items",
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: gitMock,
      utils: testUtils,
    });

    const text = response.content[0].text;
    assert.doesNotMatch(text, /HEAD BELUM ada di remote/);
    assert.equal(workflowState.state.commitAndPushCompleted, true);
  });
});

test("create_documentation accepts documentation files already committed during the task when working tree is clean", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.currentPhase = "documentation";
    workflowState.state.taskStartedAt = "2026-11-04T15:00:00.000Z";
    workflowState.state.testsCreated = true;
    workflowState.state.testsPassed = true;
    workflowState.state.documentationCreated = false;
    await workflowState.save();

    const gitMock = createGitMock({
      hasWorkingChanges: async () => false,
      getStatusOutput: async () => "",
      getCommittedFilesSince: async () => [
        "CHANGELOG.md",
        "docs/release-notes/RELEASE_NOTES.md",
        "README.md",
        "app/Services/AppointmentCartService.php",
      ],
      getHeadChangedFiles: async () => [
        "CHANGELOG.md",
        "docs/release-notes/RELEASE_NOTES.md",
        "README.md",
      ],
    });

    const response = await handleToolCall({
      request: createRequest("create_documentation", {
        documentationType: "RELEASE_NOTES",
        files: ["CHANGELOG.md", "docs/release-notes/RELEASE_NOTES.md", "README.md"],
        summary: "Updated release notes and changelog for v5.0.7",
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: gitMock,
      utils: testUtils,
    });

    const text = response.content[0].text;
    assert.doesNotMatch(
      text,
      /Dibatalkan: berkas ini disebut sebagai dokumentasi tetapi tidak muncul/
    );
    assert.equal(workflowState.state.documentationCreated, true);
  });
});
