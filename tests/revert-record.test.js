import { test } from "node:test";
import assert from "node:assert/strict";
import { planRevert } from "../tools/handler-modules/checkpoint-handlers.js";

/** A state whose checkpoint carries the given commit list. */
function withCommits(commits) {
  return {
    checkpoint: {
      baseSha: "b".repeat(40),
      commits,
      summary: "",
      handover: null,
    },
  };
}

/**
 * A fake git facade matching the interface planRevert consumes.
 * `remoteContains` lists the SHAs that are already on the remote default branch.
 */
function fakeGit({ remoteContains = [], dirty = [], authors = {}, sessionEmail = "dev@example.com" } = {}) {
  return {
    defaultBranch: async () => "main",
    remoteBranchesContaining: async (sha) =>
      remoteContains.includes(sha) ? ["main"] : [],
    authorEmail: async (sha) => authors[sha] ?? "dev@example.com",
    sessionEmail: async () => sessionEmail,
    statusPorcelain: async () => dirty,
  };
}

test("a session commit not on the remote default branch is a candidate", async () => {
  const plan = await planRevert({
    state: withCommits(["a".repeat(40)]),
    git: fakeGit({ remoteContains: ["c".repeat(40)] }),
  });
  assert.deepEqual(plan.candidates, ["a".repeat(40)]);
  assert.equal(plan.refused.length, 0);
});

test("a commit already pushed to the remote default branch is refused", async () => {
  const sha = "a".repeat(40);
  const plan = await planRevert({
    state: withCommits([sha]),
    git: fakeGit({ remoteContains: [sha] }),
  });
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.refused[0].sha, sha);
  assert.equal(plan.refused[0].why, "already on the remote default branch");
});

test("a commit whose author is not this session's identity is refused", async () => {
  const sha = "a".repeat(40);
  const plan = await planRevert({
    state: withCommits([sha]),
    git: fakeGit({
      remoteContains: [],
      authors: { [sha]: "someone-else@example.com" },
      sessionEmail: "dev@example.com",
    }),
  });
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.refused[0].sha, sha);
  assert.match(plan.refused[0].why, /not this session/i);
});

test("a dirty working tree is reported but never cleaned", async () => {
  const plan = await planRevert({
    state: withCommits([]),
    git: fakeGit({ dirty: [" M app.js", "?? stray.txt"] }),
  });
  assert.deepEqual(plan.dirty, [" M app.js", "?? stray.txt"]);
});

test("an empty checkpoint yields no candidates and no refusals", async () => {
  const plan = await planRevert({ state: withCommits([]), git: fakeGit() });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.refused, []);
  assert.deepEqual(plan.dirty, []);
});
