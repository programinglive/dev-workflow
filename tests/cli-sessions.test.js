import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSession, listSessions } from "../cli/sessions.js";
import { CliError } from "../cli/args.js";

/** Builds `<root>/projects/<project>/users/<user>/workflow-state.<key>.json`. */
function makeTree(stateByUser) {
  const root = mkdtempSync(path.join(os.tmpdir(), "devwf-cli-sessions-"));
  const projectDir = path.join(root, "projects", "demo-abc123");
  for (const [user, states] of Object.entries(stateByUser)) {
    const userDir = path.join(projectDir, "users", user);
    mkdirSync(userDir, { recursive: true });
    for (const [key, state] of Object.entries(states)) {
      writeFileSync(
        path.join(userDir, `workflow-state.${key}.json`),
        JSON.stringify(state),
        "utf8"
      );
    }
  }
  return { root, projectDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("finds a session by key and returns its path and parsed state", () => {
  const tree = makeTree({
    "user-1": {
      ses_abc: { currentPhase: "coding", taskDescription: "close the stale card" },
    },
  });
  try {
    const found = findSession({ root: tree.projectDir, key: "ses_abc" });
    assert.equal(found.state.currentPhase, "coding");
    assert.equal(found.state.taskDescription, "close the stale card");
    assert.match(found.file, /workflow-state\.ses_abc\.json$/);
  } finally {
    tree.cleanup();
  }
});

test("an unknown session key is refused by name", () => {
  const tree = makeTree({ "user-1": { ses_abc: { currentPhase: "coding" } } });
  try {
    assert.throws(
      () => findSession({ root: tree.projectDir, key: "ses_nope" }),
      (error) => error instanceof CliError && /ses_nope/.test(error.message)
    );
  } finally {
    tree.cleanup();
  }
});

test("a key found under two users is refused as ambiguous, listing both", () => {
  const tree = makeTree({
    "user-1": { ses_dup: { currentPhase: "coding" } },
    "user-2": { ses_dup: { currentPhase: "release" } },
  });
  try {
    assert.throws(
      () => findSession({ root: tree.projectDir, key: "ses_dup" }),
      (error) =>
        error instanceof CliError &&
        /ambiguous/i.test(error.message) &&
        /user-1/.test(error.message) &&
        /user-2/.test(error.message)
    );
  } finally {
    tree.cleanup();
  }
});

test("a missing projects directory is refused instead of being read as empty", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "devwf-cli-empty-"));
  try {
    assert.throws(
      () => findSession({ root, key: "ses_abc" }),
      (error) => error instanceof CliError && /projects/i.test(error.message)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt state file is refused rather than half-read", () => {
  const tree = makeTree({ "user-1": {} });
  try {
    const userDir = path.join(tree.projectDir, "users", "user-1");
    writeFileSync(path.join(userDir, "workflow-state.ses_broken.json"), "{not json", "utf8");
    assert.throws(
      () => findSession({ root: tree.projectDir, key: "ses_broken" }),
      (error) => error instanceof CliError && /unreadable|corrupt/i.test(error.message)
    );
  } finally {
    tree.cleanup();
  }
});

test("listSessions reports every session with its phase and task", () => {
  const tree = makeTree({
    "user-1": {
      ses_a: { currentPhase: "coding", taskDescription: "first" },
      ses_b: { currentPhase: "release", taskDescription: "second" },
    },
  });
  try {
    const rows = listSessions({ root: tree.projectDir });
    assert.equal(rows.length, 2);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    assert.equal(byKey.ses_a.phase, "coding");
    assert.equal(byKey.ses_b.taskDescription, "second");
  } finally {
    tree.cleanup();
  }
});

test("discovery never writes to the state tree", () => {
  const tree = makeTree({ "user-1": { ses_a: { currentPhase: "coding" } } });
  try {
    const before = JSON.stringify(listSessions({ root: tree.projectDir }));
    const found = findSession({ root: tree.projectDir, key: "ses_a" });
    const after = JSON.stringify(listSessions({ root: tree.projectDir }));
    assert.equal(before, after);
    assert.equal(found.state.currentPhase, "coding");
  } finally {
    tree.cleanup();
  }
});
