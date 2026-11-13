import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planCleanup, applyCleanup, cleanupWorkBranches, samePath } from "../branch-cleanup.js";

/**
 * Owner request, 10 November 2026: "when bug fixing is finished, delete the
 * branch or the worktree, so it does not pile up like now."
 *
 * The danger is obvious: a wrong deletion destroys unpushed work. So every test
 * here is a safety rule, and each one runs against a real git repository rather
 * than a mocked string. A mock would happily agree with a wrong assumption
 * about `git merge-base`.
 */

function sh(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-repo-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  sh(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "chore: initial"]);
  return dir;
}

function commitOn(repo, branch, file) {
  sh(repo, ["checkout", "-q", "-b", branch]);
  fs.writeFileSync(path.join(repo, file), "x\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", `feat: ${branch}`]);
}

function decide(plan, branch) {
  return plan.branches.find((b) => b.name === branch);
}

function worktreeDecision(plan, wtPath) {
  return plan.worktrees.find((w) => samePath(w.path, wtPath));
}

test("a fully merged branch is deleted", () => {
  const repo = makeRepo();
  commitOn(repo, "fix/done", "done.txt");
  sh(repo, ["checkout", "-q", "main"]);
  sh(repo, ["merge", "-q", "--ff-only", "fix/done"]);

  const plan = planCleanup({ repoDir: repo });
  assert.equal(decide(plan, "fix/done").action, "delete");

  const result = applyCleanup(repo, plan);
  assert.deepEqual(result.deleted, ["fix/done"]);
  assert.equal(sh(repo, ["branch", "--list", "fix/done"]), "");
});

test("a branch with commits not in the default branch is kept", () => {
  const repo = makeRepo();
  commitOn(repo, "feat/unmerged", "wip.txt");
  sh(repo, ["checkout", "-q", "main"]);

  const plan = planCleanup({ repoDir: repo });
  const decision = decide(plan, "feat/unmerged");
  assert.equal(decision.action, "keep");
  assert.match(decision.reason, /belum merge|not merged/i);

  applyCleanup(repo, plan);
  assert.notEqual(sh(repo, ["branch", "--list", "feat/unmerged"]), "", "unmerged work must survive");
});

test("the current branch is never deleted, even when merged", () => {
  const repo = makeRepo();
  commitOn(repo, "fix/current", "c.txt");
  // Still on fix/current, and it is trivially an ancestor of itself.
  const plan = planCleanup({ repoDir: repo });
  const decision = decide(plan, "fix/current");
  assert.equal(decision.action, "keep");
  assert.match(decision.reason, /current|dipakai/i);
  applyCleanup(repo, plan);
  assert.notEqual(sh(repo, ["branch", "--list", "fix/current"]), "");
});

test("main and master are protected by name", () => {
  const repo = makeRepo();
  const plan = planCleanup({ repoDir: repo });
  assert.equal(decide(plan, "main").action, "keep");
});

test("a clean, merged, idle worktree is removed with its directory", () => {
  const repo = makeRepo();
  commitOn(repo, "feat/wt", "wt.txt");
  sh(repo, ["checkout", "-q", "main"]);
  sh(repo, ["merge", "-q", "--ff-only", "feat/wt"]);
  const wtPath = path.join(path.dirname(repo), path.basename(repo) + "-wt");
  sh(repo, ["worktree", "add", "-q", wtPath, "feat/wt"]);

  // Everything in the worktree is older than the idle window, including the
  // directory itself: its mtime moves when a file is created or deleted.
  const old = Date.now() - 3 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(wtPath)) {
    fs.utimesSync(path.join(wtPath, entry), old / 1000, old / 1000);
  }
  fs.utimesSync(wtPath, old / 1000, old / 1000);
  const now = Date.now();

  const canonical = fs.realpathSync.native(wtPath);
  const plan = planCleanup({ repoDir: repo, now });
  assert.equal(worktreeDecision(plan, canonical).action, "remove");

  const result = applyCleanup(repo, plan);
  assert.equal(result.removed.length, 1);
  assert.ok(samePath(result.removed[0], canonical), `removed ${result.removed[0]} instead of ${canonical}`);
  assert.equal(fs.existsSync(wtPath), false);
});

test("a worktree with uncommitted changes is kept", () => {
  const repo = makeRepo();
  commitOn(repo, "feat/dirty", "d.txt");
  sh(repo, ["checkout", "-q", "main"]);
  sh(repo, ["merge", "-q", "--ff-only", "feat/dirty"]);
  const wtPath = path.join(path.dirname(repo), path.basename(repo) + "-dirty");
  sh(repo, ["worktree", "add", "-q", wtPath, "feat/dirty"]);
  fs.writeFileSync(path.join(wtPath, "d.txt"), "changed\n");

  const plan = planCleanup({ repoDir: repo });
  const decision = worktreeDecision(plan, fs.realpathSync.native(wtPath));
  assert.equal(decision.action, "keep");
  assert.match(decision.reason, /belum di-commit|uncommitted/i);

  applyCleanup(repo, plan);
  assert.equal(fs.existsSync(wtPath), true);
});

test("a worktree modified moments ago is kept, because a session may still be in it", () => {
  const repo = makeRepo();
  commitOn(repo, "feat/busy", "b.txt");
  sh(repo, ["checkout", "-q", "main"]);
  sh(repo, ["merge", "-q", "--ff-only", "feat/busy"]);
  const wtPath = path.join(path.dirname(repo), path.basename(repo) + "-busy");
  sh(repo, ["worktree", "add", "-q", wtPath, "feat/busy"]);
  fs.writeFileSync(path.join(wtPath, "b.txt"), "fresh\n");
  sh(wtPath, ["checkout", "--", "b.txt"]); // clean again, but mtime is now

  const plan = planCleanup({ repoDir: repo, idleMs: 30 * 60 * 1000 });
  const decision = worktreeDecision(plan, fs.realpathSync.native(wtPath));
  assert.equal(decision.action, "keep");
  assert.match(decision.reason, /baru|recent/i);
});

test("a locked worktree is kept", () => {
  const repo = makeRepo();
  commitOn(repo, "feat/locked", "l.txt");
  sh(repo, ["checkout", "-q", "main"]);
  sh(repo, ["merge", "-q", "--ff-only", "feat/locked"]);
  const wtPath = path.join(path.dirname(repo), path.basename(repo) + "-locked");
  sh(repo, ["worktree", "add", "-q", wtPath, "feat/locked"]);
  sh(repo, ["worktree", "lock", wtPath]);

  const plan = planCleanup({ repoDir: repo });
  const decision = worktreeDecision(plan, fs.realpathSync.native(wtPath));
  assert.equal(decision.action, "keep");
  assert.match(decision.reason, /lock/i);
});

test("the main worktree is never removed", () => {
  const repo = makeRepo();
  const plan = planCleanup({ repoDir: repo });
  // Windows reports the same directory with different capitalisation depending
  // on who asked, so compare the way the implementation does.
  const mainEntry = plan.worktrees.find((w) => samePath(w.path, fs.realpathSync.native(repo)));
  assert.ok(mainEntry, "the main worktree must be listed");
  assert.equal(mainEntry.action, "keep");
});

test("samePath treats the short and long spellings of one directory as equal", () => {
  // The dangerous direction of this bug: git prints C:/Users/mahardhika/...
  // while a caller may hold C:\Users\MAHARD~1\... for the same place. Comparing
  // raw strings says "different directory" and the main worktree gets marked
  // removable, which would delete the checkout somebody is working in.
  const repo = makeRepo();
  const long = fs.realpathSync.native(repo);
  // On Windows the JavaScript realpath returns the 8.3 short form while the
  // native one returns the long form. Both name the same directory, which is
  // exactly the pair that used to compare unequal.
  const short = fs.realpathSync(repo);

  if (short !== long) {
    assert.equal(samePath(short, long), true, `short ${short} and long ${long} must compare equal`);
  }
  assert.equal(samePath(long, long), true);
  assert.equal(samePath(long, path.join(long, "nested")), false, "a child is not the same directory");
});

test("planning changes nothing: the dry run proves it", () => {
  const repo = makeRepo();
  commitOn(repo, "fix/dry", "dry.txt");
  sh(repo, ["checkout", "-q", "main"]);
  sh(repo, ["merge", "-q", "--ff-only", "fix/dry"]);

  const plan = planCleanup({ repoDir: repo });
  assert.equal(decide(plan, "fix/dry").action, "delete");
  assert.notEqual(sh(repo, ["branch", "--list", "fix/dry"]), "", "planning must not touch branches");

  const dry = cleanupWorkBranches({ repoDir: repo, apply: false });
  assert.equal(dry.applied, false);
  assert.notEqual(sh(repo, ["branch", "--list", "fix/dry"]), "", "apply:false must not touch branches");
});

test("cleanupWorkBranches applies the same decisions it reports", () => {
  const repo = makeRepo();
  commitOn(repo, "fix/applied", "ap.txt");
  sh(repo, ["checkout", "-q", "main"]);
  sh(repo, ["merge", "-q", "--ff-only", "fix/applied"]);

  const result = cleanupWorkBranches({ repoDir: repo, apply: true });
  assert.equal(result.applied, true);
  assert.deepEqual(result.deleted, ["fix/applied"]);
  assert.equal(sh(repo, ["branch", "--list", "fix/applied"]), "");
});

test("complete_task runs the cleanup, best effort, after a finished task", () => {
  const source = fs.readFileSync(
    new URL("../tools/handler-modules/commit-handlers.js", import.meta.url),
    "utf8"
  );
  assert.match(source, /import \{ cleanupWorkBranches \} from "\.\.\/\.\.\/branch-cleanup\.js"/);
  assert.match(source, /cleanupWorkBranches\(\{ repoDir: projectDir, apply: true \}\)/);

  // projectDir must be captured before the state is reset, otherwise the
  // cleanup silently runs against nothing.
  const capture = source.indexOf("const projectDir = workflowState.state.projectDir");
  const reset = source.indexOf("workflowState.reset();");
  assert.ok(capture > 0, "projectDir must be captured");
  assert.ok(capture < reset, "projectDir must be captured before the reset");

  // A cleanup failure must never fail the completion that already happened.
  assert.ok(source.includes("Branch cleanup skipped"), "cleanup must be wrapped in a try/catch");
});

test("a repository with no extra branches reports an empty plan instead of failing", () => {
  const repo = makeRepo();
  const plan = planCleanup({ repoDir: repo });
  assert.deepEqual(plan.branches.filter((b) => b.action === "delete"), []);
  assert.deepEqual(plan.worktrees.filter((w) => w.action === "remove"), []);
});
