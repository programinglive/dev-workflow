import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState, resolveStateFile, pinSessionProject, writeFocusBinding, readFocusBinding, retireFocusBinding } from "../workflow-state.js";
import { handleStartTask } from "../tools/handler-modules/workflow-handlers.js";
import { setIsAliveForTests } from "../process-lock.js";
import {
  normalizeRepoPath,
  parseRemoteIdentity,
  sameRepository,
  compareIdentity,
  captureRepositoryIdentity,
  evaluateProjectSwitch,
  assertTaskRepository,
  buildIdentityContract,
} from "../repository-identity.js";

/**
 * Repository identity guard.
 *
 * On 13 November 2026 a session pinned to DBPinball accepted a Clinic task and
 * replaced its own active task. The working directory never changed and no
 * cross-project commit was made, so the defect was not in git: `start_task`
 * simply never compared the requested repository against the repository the
 * session had already established. These tests pin that comparison down.
 */

const text = (response) => response.content[0].text;

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function makeRepo(base, name, { remote = "", branch = "main" } = {}) {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(path.join(dir, "README.md"), `# ${name}\n`, "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  if (remote) git(dir, "remote", "add", "origin", remote);
  return dir;
}

async function withWorkspace(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "dwf-identity-"));
  const previousState = process.env.DEV_WORKFLOW_STATE_FILE;
  const previousCwd = process.cwd();
  try {
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(base, "state", "workflow-state.json");
    return await fn(base);
  } finally {
    process.chdir(previousCwd);
    if (previousState === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = previousState;
    await rm(base, { recursive: true, force: true });
  }
}

async function sessionState(sessionId) {
  const stateFile = resolveStateFile({ sessionId });
  const state = new WorkflowState(stateFile);
  await state.load();
  return state;
}

const taskArgs = (projectDir, extra = {}) => ({
  description: "repository identity guard task",
  type: "feature",
  projectDir,
  definitionOfDone: ["the guard is proven"],
  plan: ["write the failing test", "implement the guard"],
  ...extra,
});

// 1. Correct repository and focus accepted.
test("accepts a task in the session's established repository", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const state = await sessionState("ses_ID1");

    const first = await handleStartTask(taskArgs(repo), state, null);
    assert.doesNotMatch(text(first), /Dibatalkan|Refused|different repository/i);

    const second = await handleStartTask(taskArgs(repo), state, null);
    assert.doesNotMatch(text(second), /different repository/i);
    assert.equal(state.state.projectDir, repo);
  });
});

// 2. Wrong repository rejected.
test("rejects a task in a different repository without authorization", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const beta = await makeRepo(base, "beta", { remote: "https://github.com/example/beta.git" });
    const state = await sessionState("ses_ID2");

    await handleStartTask(taskArgs(alpha), state, null);
    const refused = await handleStartTask(taskArgs(beta), state, null);

    assert.match(text(refused), /different repository/i);
    assert.match(text(refused), /allowProjectSwitch/);
    assert.equal(state.state.projectDir, alpha, "the established project must be preserved");
  });
});

// 3. Wrong focus rejected.
test("rejects a focus already bound to another project", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const beta = await makeRepo(base, "beta", { remote: "https://github.com/example/beta.git" });
    const state = await sessionState("ses_ID3");

    await handleStartTask(taskArgs(alpha), state, null);
    writeFocusBinding({
      stateFile: state.stateFile,
      focusId: 73,
      projectDir: alpha,
      repoKey: "github.com/example/alpha",
    });

    const refused = await handleStartTask(
      taskArgs(beta, { allowProjectSwitch: true, projectSwitchReason: "explicitly moving to beta", focusId: 73 }),
      state,
      null,
    );

    assert.match(text(refused), /focus/i);
    assert.match(text(refused), /another project/i);
    assert.equal(state.state.projectDir, alpha);
  });
});

// 4. Missing focus rejected on a project switch.
test("requires an explicit focus when switching project", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const beta = await makeRepo(base, "beta", { remote: "https://github.com/example/beta.git" });
    const state = await sessionState("ses_ID4");

    await handleStartTask(taskArgs(alpha), state, null);
    const refused = await handleStartTask(
      taskArgs(beta, { allowProjectSwitch: true, projectSwitchReason: "explicitly moving to beta" }),
      state,
      null,
    );

    assert.match(text(refused), /focusId/i);
    assert.equal(state.state.projectDir, alpha);
  });
});

// 5. A different task must not replace the active task on refusal.
test("preserves the active task when the switch is refused", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const beta = await makeRepo(base, "beta", { remote: "https://github.com/example/beta.git" });
    const state = await sessionState("ses_ID5");

    await handleStartTask(taskArgs(alpha), state, null);
    const before = state.state.taskDescription;
    const beforeDod = state.state.definitionOfDone.map((item) => item.text);

    await handleStartTask(taskArgs(beta), state, null);

    assert.equal(state.state.taskDescription, before);
    assert.deepEqual(state.state.definitionOfDone.map((item) => item.text), beforeDod);
  });
});

// 6. Repo directory rename keeps the same identity through the remote.
test("accepts a renamed directory when the remote identity matches", async () => {
  await withWorkspace(async (base) => {
    const original = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const state = await sessionState("ses_ID6");
    await handleStartTask(taskArgs(original), state, null);

    const renamed = path.join(base, "alpha-renamed");
    await rename(original, renamed);

    const accepted = await handleStartTask(taskArgs(renamed), state, null);
    assert.doesNotMatch(text(accepted), /different repository/i);
    assert.equal(state.state.projectDir, renamed);
  });
});

// 6b. A second clone of the same remote is NOT the same workspace.
test("refuses a second clone of the same remote without authorization", async () => {
  await withWorkspace(async (base) => {
    const first = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const second = await makeRepo(base, "alpha-clone", { remote: "https://github.com/example/alpha.git" });
    const state = await sessionState("ses_ID6B");

    await handleStartTask(taskArgs(first), state, null);
    const refused = await handleStartTask(taskArgs(second), state, null);

    assert.match(text(refused), /independently writable clones/i);
    assert.match(text(refused), /WORKSPACE_SWITCH_REQUIRES_AUTHORIZATION|allowProjectSwitch/);
    assert.equal(state.state.projectDir, first);
  });
});

// 6c. A linked worktree of the same checkout is legitimate continuity.
test("accepts a linked worktree of the established checkout", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const worktree = path.join(base, "alpha-wt");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);

    const state = await sessionState("ses_ID6C");
    await handleStartTask(taskArgs(repo), state, null);
    const accepted = await handleStartTask(taskArgs(worktree), state, null);

    assert.doesNotMatch(text(accepted), /Refused/i);
    assert.equal(state.state.projectDir, worktree);
  });
});

// 6d. Same workspace, changed branch, is still the same task context.
test("accepts the same workspace after a branch change", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const state = await sessionState("ses_ID6D");
    await handleStartTask(taskArgs(repo), state, null);

    git(repo, "checkout", "-q", "-b", "feat/next");
    const accepted = await handleStartTask(taskArgs(repo), state, null);

    assert.doesNotMatch(text(accepted), /Refused/i);
    const identity = await captureRepositoryIdentity({ dir: repo });
    assert.equal(identity.branch, "feat/next");
  });
});

// 6e. Same workspace, remote URL change, still the same checkout.
test("accepts the same workspace after a remote URL change", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const state = await sessionState("ses_ID6E");
    await handleStartTask(taskArgs(repo), state, null);

    git(repo, "remote", "set-url", "origin", "https://github.com/example/alpha-renamed.git");
    const accepted = await handleStartTask(taskArgs(repo), state, null);

    assert.doesNotMatch(text(accepted), /Refused/i);
  });
});

// 6f. A fork is a different repository, not an upstream continuation.
test("refuses a fork of the same upstream", async () => {
  const upstream = {
    root: "/repo/alpha",
    remote: "https://github.com/owner/alpha.git",
    workspaceKey: "/repo/alpha",
    commonDirKey: "/repo/alpha/.git",
  };
  const fork = {
    root: "/repo/alpha-fork",
    remote: "https://github.com/contributor/alpha.git",
    workspaceKey: "/repo/alpha-fork",
    commonDirKey: "/repo/alpha-fork/.git",
  };

  const comparison = compareIdentity(fork, upstream);
  assert.equal(comparison.match, "DIFFERENT_REPOSITORY");
  assert.equal(sameRepository(fork, upstream), false);

  const refused = evaluateProjectSwitch({ requested: fork, session: upstream });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "PROJECT_SWITCH_REQUIRES_AUTHORIZATION");
});

// 6g. Upstream and origin on one clone: origin is the identity.
test("treats origin and upstream remotes on one clone as one repository", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "alpha", { remote: "https://github.com/contributor/alpha.git" });
    git(repo, "remote", "add", "upstream", "https://github.com/owner/alpha.git");

    const identity = await captureRepositoryIdentity({ dir: repo });
    assert.equal(identity.remote, "https://github.com/contributor/alpha.git");
    assert.equal(identity.remotes.length, 2);
    assert.equal(compareIdentity(identity, identity).match, "SAME_WORKSPACE");
  });
});

// 6h. A repository with no remote keeps a local identity.
test("handles a repository with no remote", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "local-only");
    const identity = await captureRepositoryIdentity({ dir: repo });

    assert.equal(identity.isGitRepo, true);
    assert.equal(identity.remote, "");
    assert.equal(sameRepository(identity, identity), true);
    assert.equal(compareIdentity(identity, identity).match, "SAME_WORKSPACE");
  });
});

// Identity comparison is a pure function: prove the three matchers directly.
test("compareIdentity separates workspace, checkout family and repository", () => {
  const main = { root: "/repo/a", remote: "https://h/o/a.git", workspaceKey: "/repo/a", commonDirKey: "/repo/a/.git" };
  const worktree = { root: "/repo/a-wt", remote: "https://h/o/a.git", workspaceKey: "/repo/a-wt", commonDirKey: "/repo/a/.git" };
  const clone = { root: "/repo/a2", remote: "https://h/o/a.git", workspaceKey: "/repo/a2", commonDirKey: "/repo/a2/.git" };

  assert.equal(compareIdentity(main, main).match, "SAME_WORKSPACE");
  assert.equal(compareIdentity(worktree, main).match, "SAME_CHECKOUT_FAMILY");
  assert.equal(compareIdentity(clone, main).match, "SAME_REPOSITORY_DIFFERENT_CLONE");
  assert.equal(sameRepository(clone, main), true, "remote identity is equal");
  assert.equal(evaluateProjectSwitch({ requested: clone, session: main }).ok, false, "but a clone is not continuity");
  assert.equal(evaluateProjectSwitch({ requested: worktree, session: main }).ok, true, "a worktree is continuity");
});

// A task is bound to the checkout it started in, for mutations too.
test("assertTaskRepository refuses a mutation in another checkout", () => {
  const contract = buildIdentityContract({
    identity: { root: "/repo/a", remote: "https://h/o/a.git", workspaceKey: "/repo/a", commonDirKey: "/repo/a/.git", branch: "main" },
  });
  const elsewhere = { root: "/repo/a2", remote: "https://h/o/a.git", workspaceKey: "/repo/a2", commonDirKey: "/repo/a2/.git" };

  const refused = assertTaskRepository({ contract, actual: elsewhere, operation: "commit_and_push" });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /different workspace/i);

  const same = assertTaskRepository({ contract, actual: { root: "/repo/a", workspaceKey: "/repo/a", commonDirKey: "/repo/a/.git" } });
  assert.equal(same.ok, true);

  assert.equal(assertTaskRepository({ contract: null, actual: elsewhere }).legacy, true);
});

// 7. Multiple remotes: origin is the identity, not the first remote.
test("identifies a repository with multiple remotes by origin", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "multi", { remote: "https://github.com/example/multi.git" });
    git(repo, "remote", "add", "upstream", "https://github.com/other/multi.git");

    const identity = await captureRepositoryIdentity({ dir: repo });
    assert.equal(identity.remote, "https://github.com/example/multi.git");
    assert.equal(identity.remotes.length, 2);
    assert.equal(identity.remotes.find((entry) => entry.name === "origin").key, "github.com/example/multi");
  });
});

// 8. A worktree is the same repository as its main checkout.
test("treats a git worktree as the same repository", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const worktree = path.join(base, "alpha-wt");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);

    const main = await captureRepositoryIdentity({ dir: repo });
    const linked = await captureRepositoryIdentity({ dir: worktree });

    assert.equal(linked.isGitRepo, true);
    assert.equal(linked.worktree, true);
    assert.equal(sameRepository(main, linked), true);
  });
});

// 9. Detached HEAD is recorded without inventing a branch.
test("records a detached HEAD without inventing a branch", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "--detach", head);

    const identity = await captureRepositoryIdentity({ dir: repo });
    assert.equal(identity.detached, true);
    assert.equal(identity.branch, null);
    assert.equal(identity.head, head);
  });
});

// 10. The identity guard must not weaken the single-writer lock.
test("keeps the single-writer lock in force", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const state = await sessionState("ses_ID10");
    await handleStartTask(taskArgs(repo), state, null);

    // Simulate another live MCP process holding the same project.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { projectLockDir, LOCK_FILENAME } = await import("../process-lock.js");
    const lockDir = projectLockDir(state.stateFile);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, LOCK_FILENAME),
      JSON.stringify({ pid: 999999, host: "other-host", updatedAt: Date.now(), startedAt: Date.now() }),
      "utf8",
    );

    setIsAliveForTests(() => true);
    try {
      const refused = await handleStartTask(taskArgs(repo), state, null);
      assert.match(text(refused), /sesi lain|another session/i);
    } finally {
      setIsAliveForTests(null);
    }
  });
});

// 11. A stale pointer for a removed project must not block a new project.
test("ignores a stale session pointer for a removed project", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const beta = await makeRepo(base, "beta", { remote: "https://github.com/example/beta.git" });
    const state = await sessionState("ses_ID11");

    await handleStartTask(taskArgs(alpha), state, null);
    await rm(alpha, { recursive: true, force: true });

    const accepted = await handleStartTask(taskArgs(beta), state, null);
    assert.doesNotMatch(text(accepted), /different repository/i);
    assert.equal(state.state.projectDir, beta);
  });
});

// 12. A refused authorization must not mutate state or files.
test("does not mutate state or files when authorization fails", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const beta = await makeRepo(base, "beta", { remote: "https://github.com/example/beta.git" });
    const state = await sessionState("ses_ID12");

    await handleStartTask(taskArgs(alpha), state, null);
    const stateBefore = await readFile(state.stateFile, "utf8");
    const betaStatusBefore = git(beta, "status", "--porcelain");

    await handleStartTask(taskArgs(beta), state, null);

    const stateAfter = await readFile(state.stateFile, "utf8");
    assert.equal(stateAfter, stateBefore, "the state file must be byte-identical after a refusal");
    assert.equal(git(beta, "status", "--porcelain"), betaStatusBefore);
    assert.equal(existsSync(path.join(beta, ".git")), true);
  });
});

// Focus binding lifecycle: persistence, retirement, stale recovery, concurrency.
test("focus binding survives session restoration and retires explicitly", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const state = await sessionState("ses_FB1");

    const bound = writeFocusBinding({
      stateFile: state.stateFile,
      focusId: 73,
      projectDir: alpha,
      repoKey: "github.com/example/alpha",
    });
    assert.equal(bound.ok, true);

    // A fresh state instance (a restored session) reads the same binding.
    const restored = await sessionState("ses_FB1");
    const read = readFocusBinding({ stateFile: restored.stateFile, focusId: 73 });
    assert.equal(read.repoKey, "github.com/example/alpha");

    const retired = retireFocusBinding({ stateFile: restored.stateFile, focusId: 73, reason: "focus completed" });
    assert.equal(retired.retired, true);
    assert.equal(readFocusBinding({ stateFile: restored.stateFile, focusId: 73 }), null);
  });
});

test("a stale focus binding does not block project recovery", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const beta = await makeRepo(base, "beta", { remote: "https://github.com/example/beta.git" });
    const state = await sessionState("ses_FB2");

    writeFocusBinding({ stateFile: state.stateFile, focusId: 73, projectDir: alpha, repoKey: "github.com/example/alpha" });
    await rm(alpha, { recursive: true, force: true });

    const rebound = writeFocusBinding({
      stateFile: state.stateFile,
      focusId: 73,
      projectDir: beta,
      repoKey: "github.com/example/beta",
    });
    assert.equal(rebound.ok, true);
    assert.equal(rebound.reason, "REBOUND_STALE");
  });
});

test("two concurrent task starts cannot both claim one focus", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const beta = await makeRepo(base, "beta", { remote: "https://github.com/example/beta.git" });
    const stateA = await sessionState("ses_FB3A");
    const stateB = await sessionState("ses_FB3B");

    const first = writeFocusBinding({
      stateFile: stateA.stateFile,
      focusId: 73,
      projectDir: alpha,
      repoKey: "github.com/example/alpha",
    });
    const second = writeFocusBinding({
      stateFile: stateB.stateFile,
      focusId: 73,
      projectDir: beta,
      repoKey: "github.com/example/beta",
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "FOCUS_BOUND_TO_ANOTHER_PROJECT");
    assert.equal(readFocusBinding({ stateFile: stateB.stateFile, focusId: 73 }).repoKey, "github.com/example/alpha");
  });
});

// The CLI must not mutate anything while inspecting identity.
test("devwf identity is read-only", async () => {
  await withWorkspace(async (base) => {
    const repo = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const cli = path.join(process.cwd(), "bin", "cli.js");
    const before = git(repo, "status", "--porcelain");
    const headBefore = git(repo, "rev-parse", "HEAD");

    execFileSync(process.execPath, [cli, "identity", "--dir", repo, "--json"], { encoding: "utf8" });

    assert.equal(git(repo, "status", "--porcelain"), before);
    assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
  });
});

// CLI contract: stable JSON shape and documented exit codes.
test("devwf identity emits a stable JSON contract", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const beta = await makeRepo(base, "beta", { remote: "https://github.com/example/beta.git" });
    const cli = path.join(process.cwd(), "bin", "cli.js");

    const payload = JSON.parse(
      execFileSync(process.execPath, [cli, "identity", "--dir", alpha, "--json"], { encoding: "utf8" }),
    );
    for (const key of ["schemaVersion", "root", "remote", "repoKey", "workspaceKey", "commonDirKey", "branch", "head", "detached", "worktree", "remotes"]) {
      assert.ok(Object.hasOwn(payload, key), `missing ${key}`);
    }
    assert.equal(payload.schemaVersion, 1);

    let refused = null;
    try {
      execFileSync(process.execPath, [cli, "identity", "--dir", beta, "--against", alpha, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      refused = error;
    }
    assert.equal(refused.status, 1);
    const decision = JSON.parse(refused.stdout).decision;
    assert.equal(decision.ok, false);
    assert.equal(decision.code, "PROJECT_SWITCH_REQUIRES_AUTHORIZATION");
  });
});

// A usage error is a refusal, not a crash.
test("devwf identity without --dir exits non-zero with a message", async () => {
  const cli = path.join(process.cwd(), "bin", "cli.js");
  let failed = null;
  try {
    execFileSync(process.execPath, [cli, "identity"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    failed = error;
  }
  assert.equal(failed.status, 1);
  assert.match(String(failed.stderr), /--dir/);
});

test("normalizes paths and remote URLs across platforms", () => {
  const base = process.cwd();
  assert.equal(normalizeRepoPath(base + path.sep), normalizeRepoPath(base));
  assert.equal(normalizeRepoPath(base + "\\"), normalizeRepoPath(base));
  if (process.platform === "win32") {
    assert.equal(normalizeRepoPath("D:\\Code\\Alpha\\"), normalizeRepoPath("d:/code/alpha"));
  }
  assert.equal(parseRemoteIdentity("git@github.com:Example/Alpha.git").key, "github.com/example/alpha");
  assert.equal(parseRemoteIdentity("https://github.com/example/alpha").key, "github.com/example/alpha");
  assert.equal(parseRemoteIdentity("ssh://git@gitlab.com/group/project.git").key, "gitlab.com/group/project");
  assert.equal(parseRemoteIdentity(""), null);
});

test("evaluateProjectSwitch is pure and reports the refusal code", () => {
  const session = { projectDir: "/repo/alpha", repoKey: "github.com/example/alpha" };
  const requested = { root: "/repo/beta", remote: "https://github.com/example/beta.git" };

  const refused = evaluateProjectSwitch({ requested, session });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "PROJECT_SWITCH_REQUIRES_AUTHORIZATION");

  const allowed = evaluateProjectSwitch({
    requested,
    session,
    allowProjectSwitch: true,
    projectSwitchReason: "explicitly moving to beta",
    focusId: 73,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.switched, true);
});

// CLI-first surface: the guard must be verifiable without an MCP session.
test("devwf identity reports the contract and refuses a cross-project start", async () => {
  await withWorkspace(async (base) => {
    const alpha = await makeRepo(base, "alpha", { remote: "https://github.com/example/alpha.git" });
    const beta = await makeRepo(base, "beta", { remote: "https://github.com/example/beta.git" });
    const cli = path.join(process.cwd(), "bin", "cli.js");

    const identity = JSON.parse(
      execFileSync(process.execPath, [cli, "identity", "--dir", alpha, "--json"], { encoding: "utf8" }),
    );
    assert.equal(identity.repoKey, "github.com/example/alpha");
    assert.equal(identity.detached, false);

    let refused = null;
    try {
      execFileSync(process.execPath, [cli, "identity", "--dir", beta, "--against", alpha, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      refused = error;
    }
    assert.ok(refused, "a cross-project start must exit non-zero");
    assert.equal(refused.status, 1);
    const payload = JSON.parse(refused.stdout);
    assert.equal(payload.decision.ok, false);
    assert.equal(payload.decision.code, "PROJECT_SWITCH_REQUIRES_AUTHORIZATION");
  });
});
