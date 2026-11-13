import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chooseReleaseBranch } from "../tools/handler-modules/release-handlers.js";

/**
 * Regressions from the 10 November 2026 release.
 *
 * `perform_release` created the release commit and tag on `main`, then pushed
 * `feat/handoff-merge-main` because the workflow state remembered that branch
 * from an earlier `commit_and_push`. That branch had already been merged and
 * deleted, so the push failed with "src refspec does not match any" and v1.29.0
 * stayed on the laptop while the tool reported a failed release.
 *
 * The rollout had a second, unrelated break: it was written on Windows and read
 * `process.env.LOCALAPPDATA` directly, so running it on macOS threw
 * "The path argument must be of type string" after the release was promoted.
 */

const RELEASE_LINEAGE = readFileSync(new URL("../managed/release-lineage.cjs", import.meta.url), "utf8");

function fakeGit({ current, exists = () => true } = {}) {
  return {
    getCurrentBranch: async () => current,
    branchExists: async (name) => exists(name),
  };
}

test("an explicitly requested branch is pushed while it still exists", () => {
  // run_full_workflow takes a `branch` argument; honouring it is the point.
  return chooseReleaseBranch({ requested: "master", git: fakeGit({ current: "feature/local" }) })
    .then((branch) => assert.equal(branch, "master"));
});

test("a requested branch that was merged and deleted falls back to the current one", async () => {
  const branch = await chooseReleaseBranch({
    requested: "feat/handoff-merge-main",
    git: fakeGit({ current: "main", exists: (name) => name !== "feat/handoff-merge-main" }),
  });
  assert.equal(branch, "main", "pushing a deleted branch is what broke v1.29.0");
});

test("without a requested branch the current branch is used", async () => {
  const branch = await chooseReleaseBranch({ requested: "", git: fakeGit({ current: "main" }) });
  assert.equal(branch, "main");
});

test("a requested branch equal to the current one needs no existence probe", async () => {
  let probed = false;
  const branch = await chooseReleaseBranch({
    requested: "main",
    git: {
      getCurrentBranch: async () => "main",
      branchExists: async () => {
        probed = true;
        return true;
      },
    },
  });
  assert.equal(branch, "main");
  assert.equal(probed, false);
});

test("a failing existence probe keeps the release pushable instead of throwing", async () => {
  const branch = await chooseReleaseBranch({
    requested: "feat/x",
    git: {
      getCurrentBranch: async () => "main",
      branchExists: async () => {
        throw new Error("git unavailable");
      },
    },
  });
  assert.equal(branch, "main");
});

test("the managed lineage helper finds ManagedMCP on any platform instead of assuming Windows", () => {
  assert.match(RELEASE_LINEAGE, /function localManagedRoot\(\)/);
  const code = RELEASE_LINEAGE.split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  const unguarded = code
    .split("\n")
    .filter((line) => line.includes("path.join(process.env.LOCALAPPDATA"))
    .filter((line) => !line.includes("process.env.LOCALAPPDATA ?"));
  assert.deepEqual(unguarded, [], "LOCALAPPDATA must be guarded before path.join");
  assert.ok(code.includes("os.homedir()"), "a POSIX location must be available");
  assert.equal(/process\.env\.USERPROFILE/.test(code), false, "release-lineage must not assume a Windows home");
});
