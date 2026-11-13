import test from "node:test";
import assert from "node:assert/strict";

import { handleToolCall } from "../tools/handlers.js";
import { hasWorkingChanges, getStatusOutput } from "../git-helpers.js";
import { withWorkflowState, testUtils, createRequest, createGitMock, bindTaskToRepo } from "./test-helpers.js";

const GIT_UNAVAILABLE =
  "Tidak bisa menentukan repo proyek: satu-satunya kandidat adalah repo paket server MCP. " +
  "Set WORKFLOW_PROJECT_DIR ke direktori proyek, atau jalankan server MCP dari direktori proyek.";

/**
 * Menjalankan `body` dengan WORKFLOW_PROJECT_DIR diarahkan ke direktori yang
 * bukan repo git, sehingga `exec("git ...")` gagal persis seperti saat server
 * MCP dijalankan dari direktori sesi yang bukan repo.
 */
async function withoutRepository(body) {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "no-repo-"));
  const previous = process.env.WORKFLOW_PROJECT_DIR;
  process.env.WORKFLOW_PROJECT_DIR = dir;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_PROJECT_DIR;
    else process.env.WORKFLOW_PROJECT_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("git helpers report an unusable repository instead of returning a benign value", async (t) => {
  // Only meaningful when the current directory really is not a repository.
  let status;
  const previous = process.env.WORKFLOW_PROJECT_DIR;
  process.env.WORKFLOW_PROJECT_DIR = "";
  try {
    status = await getStatusOutput();
  } catch {
    status = null; // already throws, which is the behaviour under test
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_PROJECT_DIR;
    else process.env.WORKFLOW_PROJECT_DIR = previous;
  }

  if (status !== null && status !== "") {
    t.skip("current directory is a git repository; cannot simulate a missing repo");
    return;
  }

  await t.test("hasWorkingChanges throws instead of answering false", async () => {
    await assert.rejects(
      () => withoutRepository(() => hasWorkingChanges()),
      /repo proyek|not a git repository|bukan repo git/i,
    );
  });
});

test("git helpers still answer correctly inside a real repository", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-helpers-"));
  const previous = process.env.WORKFLOW_PROJECT_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.WORKFLOW_PROJECT_DIR;
    else process.env.WORKFLOW_PROJECT_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });

  try {
    await run("git", ["init", "-q"], { cwd: dir });
  } catch {
    t.skip("git is not available");
    return;
  }

  process.env.WORKFLOW_PROJECT_DIR = dir;

  await t.test("reports no changes on a clean tree", async () => {
    assert.equal(await hasWorkingChanges(), false);
    assert.equal(await getStatusOutput(), "");
  });

  await t.test("reports changes once a file is added", async () => {
    await fs.writeFile(path.join(dir, "added.txt"), "hello\n");
    assert.equal(await hasWorkingChanges(), true);
    assert.match(await getStatusOutput(), /added\.txt/);
  });
});

test("commit_and_push refuses to claim success when git cannot be inspected", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.readyToCommit = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.testsSkipped = false;
    workflowState.state.testsCreated = true;
    workflowState.state.testsPassed = true;
    workflowState.state.currentPhase = "commit";
    await workflowState.save();

    const response = await handleToolCall({
      request: createRequest("commit_and_push", { commitMessage: "fix: something" }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock({
        hasWorkingChanges: async () => {
          throw new Error(GIT_UNAVAILABLE);
        },
      }),
      utils: testUtils,
    });

    const text = response.content[0].text;

    assert.equal(
      text.includes("No changes detected"),
      false,
      "must not report 'No changes detected' when git could not run",
    );
    assert.equal(
      text.includes("Commit and push completed"),
      false,
      "must not report success when git could not run",
    );
    assert.match(text, /repo|repository/i, "must explain that the repository could not be inspected");
    assert.match(text, /WORKFLOW_PROJECT_DIR|direktori proyek/i, "must say how to fix it");

    assert.equal(
      workflowState.state.commitAndPushCompleted,
      false,
      "workflow must not advance past commit",
    );
  });
});

test("commit_and_push still reports a clean tree as already committed", async () => {
  await withWorkflowState(async (workflowState) => {
    await bindTaskToRepo(workflowState);
    workflowState.state.readyToCommit = true;
    workflowState.state.readyCheckCompleted = true;
    workflowState.state.testsSkipped = false;
    workflowState.state.testsCreated = true;
    workflowState.state.testsPassed = true;
    workflowState.state.currentPhase = "commit";
    await workflowState.save();

    const response = await handleToolCall({
      request: createRequest("commit_and_push", { commitMessage: "" }),
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
    assert.equal(workflowState.state.commitAndPushCompleted, true);
  });
});
