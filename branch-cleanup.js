/**
 * Cleans up branches and worktrees that are finished.
 *
 * OWNER REQUEST (10 November 2026)
 * --------------------------------
 * "When bug fixing is finished, delete the branch or the worktree, so it does
 * not pile up like now." The repository had nine local branches, six of them
 * already merged and doing nothing but making `git branch` unreadable.
 *
 * WHY THIS IS SO CAREFUL
 * ----------------------
 * Deleting a branch that still holds unpushed commits destroys work that no
 * backup can recover. So nothing is deleted on a guess:
 *
 *   - a branch goes only when `git merge-base --is-ancestor` proves every one
 *     of its commits is already reachable from the default branch;
 *   - the current branch, `main`, `master` and `develop` are never touched;
 *   - the default branch is detected from the repository, not assumed.
 *
 * A worktree is a directory a human or another agent may be typing in, so it
 * needs more than "merged":
 *
 *   - the main worktree, a locked worktree and a detached one are kept;
 *   - a worktree with uncommitted changes is kept;
 *   - a worktree with a file modified inside the idle window is kept, because
 *     the branch being merged does not mean nobody is still in the directory.
 *
 * `planCleanup` is the dry run: it returns the same decisions and changes
 * nothing. `applyCleanup` executes a plan.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Names that must never be deleted, whatever the reachability says. */
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

/** Directories that would make the idle check expensive or meaningless. */
const WALK_SKIP = new Set([".git", "node_modules", "vendor", "dist", "build", ".next", "coverage", ".venv"]);

const DEFAULT_IDLE_MS = 30 * 60 * 1000;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * The canonical path, or the given one when it cannot be resolved.
 *
 * Git reports `/private/var/...` where the caller passed `/var/...` on macOS,
 * so comparing the two raw strings says "different directory" for the same
 * directory. That mistake marked the main worktree as removable.
 */
function realOrSame(target) {
  try {
    // `.native` matters on Windows: the JavaScript implementation returns the
    // 8.3 short form (C:\Users\MAHARD~1\...) while git prints the long form
    // (C:/Users/<username>/...). Comparing those two says "different directory"
    // for the same place, which marks the main worktree removable.
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * True when two paths name the same directory.
 *
 * Windows reports the same directory with different capitalisation depending on
 * who asked: `git worktree list` prints `C:\Windows\Temp\...` while Node's
 * `realpathSync` returns `C:\WINDOWS\TEMP\...` for the directory it created.
 * A case-sensitive comparison called the main worktree a different directory and
 * marked it removable. Paths are case-insensitive on Windows, so compare them
 * that way there and exactly everywhere else.
 *
 * Windows can also report the same directory in its 8.3 short form
 * (`C:\Users\MAHARD~1\...`) while the caller holds the long form. Comparing the
 * raw strings then says "different directory" for the same place, which is the
 * dangerous direction: the main worktree gets marked removable. Both sides are
 * resolved through realpath first, so the comparison is about the directory
 * rather than about how it was spelled.
 */
export function samePath(a, b) {
  if (!a || !b) return false;
  const normalise = (value) => realOrSame(String(value)).replace(/[\\/]+$/, "");
  if (process.platform === "win32") {
    return normalise(a).toLowerCase() === normalise(b).toLowerCase();
  }
  return normalise(a) === normalise(b);
}

/**
 * The branch this repository treats as its trunk.
 *
 * Origin's HEAD is the truth when it exists, because a clone names it there.
 * Falling back to `main` and then `master` covers a local-only repository; the
 * function never guesses a name that does not exist.
 */
export function detectDefaultBranch(repoDir) {
  const remoteHead = tryGit(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) {
    const name = remoteHead.replace(/^origin\//, "");
    if (tryGit(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  for (const candidate of ["main", "master", "trunk", "develop"]) {
    if (tryGit(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])) return candidate;
  }
  return null;
}

/** True when every commit on `branch` is already reachable from `trunk`. */
export function isMerged(repoDir, branch, trunk) {
  if (!trunk || !branch) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, trunk], {
      cwd: repoDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Newest modification time in a directory, bounded.
 *
 * The walk stops after `maxEntries` entries and `depth` levels, so a worktree
 * with a large checkout cannot turn a cleanup into a filesystem crawl. The
 * directory itself counts too: creating or deleting a file updates it.
 */
export function newestMtimeMs(dir, { maxEntries = 400, depth = 3 } = {}) {
  let newest = 0;
  let seen = 0;

  const visit = (current, level) => {
    if (seen >= maxEntries) return;
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      return;
    }
    newest = Math.max(newest, stat.mtimeMs);
    seen += 1;
    if (level >= depth || !stat.isDirectory()) return;

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) return;
      if (WALK_SKIP.has(entry.name)) continue;
      visit(path.join(current, entry.name), level + 1);
    }
  };

  visit(dir, 0);
  return newest;
}

/** Parses `git worktree list --porcelain` into records. */
function listWorktrees(repoDir) {
  const raw = tryGit(repoDir, ["worktree", "list", "--porcelain"]);
  if (!raw) return [];

  const result = [];
  let current = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) result.push(current);
      current = { path: line.slice("worktree ".length), branch: null, detached: false, locked: false, bare: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  if (current) result.push(current);

  // The first entry is the main worktree, which is the repository itself.
  return result.map((entry, index) => ({ ...entry, main: index === 0 }));
}

function isDirty(worktreePath) {
  const status = tryGit(worktreePath, ["status", "--porcelain"]);
  return status === null ? true : status.length > 0;
}

/**
 * Decides what to delete, without deleting anything.
 *
 * @param {{repoDir: string, defaultBranch?: string, idleMs?: number,
 *   now?: number, keep?: string[]}} options
 */
export function planCleanup({ repoDir, defaultBranch = null, idleMs = DEFAULT_IDLE_MS, now = Date.now(), keep = [] } = {}) {
  if (!repoDir) throw new Error("repoDir is required");
  const trunk = defaultBranch || detectDefaultBranch(repoDir);
  const current = tryGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "";
  const keepSet = new Set(keep.filter(Boolean));

  const names = (tryGit(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]) || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const branches = names.map((name) => {
    if (name === current) return { name, action: "keep", reason: "current branch, sedang dipakai" };
    if (PROTECTED_BRANCHES.has(name)) return { name, action: "keep", reason: "protected trunk name" };
    if (name === trunk) return { name, action: "keep", reason: "the default branch itself" };
    if (keepSet.has(name)) return { name, action: "keep", reason: "explicitly kept for this run" };
    if (!isMerged(repoDir, name, trunk)) return { name, action: "keep", reason: "belum merge ke default branch" };
    return { name, action: "delete", reason: "seluruh commit sudah ada di default branch" };
  });

  const worktrees = listWorktrees(repoDir).map((entry) => {
    const resolved = realOrSame(entry.path);
    const repoResolved = realOrSame(repoDir);
    const base = { path: resolved, branch: entry.branch, main: entry.main };
    if (entry.main || samePath(resolved, repoResolved)) {
      return { ...base, action: "keep", reason: "worktree utama" };
    }
    if (entry.bare) return { ...base, action: "keep", reason: "bare repository" };
    if (entry.locked) return { ...base, action: "keep", reason: "worktree terkunci (locked)" };
    if (entry.detached || !entry.branch) return { ...base, action: "keep", reason: "detached, tidak punya branch" };
    if (isDirty(resolved)) return { ...base, action: "keep", reason: "masih ada perubahan belum di-commit" };
    if (!isMerged(repoDir, entry.branch, trunk)) {
      return { ...base, action: "keep", reason: "branch belum merge ke default branch" };
    }
    const newest = newestMtimeMs(resolved);
    if (numberIsRecent(newest, now, idleMs)) {
      return { ...base, action: "keep", reason: "baru saja diubah, mungkin masih dipakai" };
    }
    return { ...base, action: "remove", reason: "bersih, sudah merge, dan menganggur" };
  });

  return {
    repoDir,
    defaultBranch: trunk,
    current,
    branches,
    worktrees,
    summary: {
      deleteBranches: branches.filter((b) => b.action === "delete").length,
      removeWorktrees: worktrees.filter((w) => w.action === "remove").length,
      keep: branches.filter((b) => b.action === "keep").length + worktrees.filter((w) => w.action === "keep").length,
    },
  };
}

function numberIsRecent(mtimeMs, now, idleMs) {
  return Number.isFinite(mtimeMs) && mtimeMs > 0 && now - mtimeMs < idleMs;
}

/**
 * Executes a plan. Worktrees go first so a branch that is checked out in one of
 * them is no longer "in use" when it is deleted.
 *
 * A failure on one item never stops the rest; it is reported instead. The
 * caller may be a completed task, and a locked directory must not fail it.
 */
export function applyCleanup(repoDir, plan) {
  const deleted = [];
  const removed = [];
  const failures = [];

  for (const worktree of plan.worktrees.filter((w) => w.action === "remove")) {
    try {
      execFileSync("git", ["worktree", "remove", worktree.path], { cwd: repoDir, stdio: "ignore" });
      removed.push(worktree.path);
    } catch (error) {
      failures.push({ target: worktree.path, error: String(error.message || error).slice(0, 200) });
    }
  }
  tryGit(repoDir, ["worktree", "prune"]);

  for (const branch of plan.branches.filter((b) => b.action === "delete")) {
    try {
      execFileSync("git", ["branch", "-D", branch.name], { cwd: repoDir, stdio: "ignore" });
      deleted.push(branch.name);
    } catch (error) {
      failures.push({ target: branch.name, error: String(error.message || error).slice(0, 200) });
    }
  }

  return { deleted, removed, failures };
}

/**
 * Plan and optionally apply. `apply: false` is the dry run: same decisions, no
 * side effects.
 */
export function cleanupWorkBranches({ repoDir, apply = false, ...options } = {}) {
  const plan = planCleanup({ repoDir, ...options });
  if (!apply) {
    return { applied: false, ...plan, deleted: [], removed: [], failures: [] };
  }
  const result = applyCleanup(repoDir, plan);
  return { applied: true, ...plan, ...result };
}
