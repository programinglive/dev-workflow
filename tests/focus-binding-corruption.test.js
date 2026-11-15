import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { claimFocusBinding, readFocusBinding, captureFocusBindingSnapshot, restoreFocusBindingSnapshot } from "../workflow-state.js";
import { readFileSync } from "node:fs";

/**
 * A damaged focus binding must never read as "unbound".
 *
 * `readFocusBindingRecord` used to swallow every error. A record that exists but
 * cannot be parsed, or cannot be read at all, was therefore indistinguishable
 * from a missing one, and `claimFocusBindingUnderLock` would happily overwrite
 * it with another project's claim. That is silent ownership loss.
 *
 * The correct tri-state is:
 *   - ENOENT            -> absent, a claim may proceed
 *   - malformed / EACCES -> unreadable, the claim must be refused
 */

async function stateBase() {
  const base = await mkdtemp(path.join(tmpdir(), "focus-e-"));
  const stateFile = path.join(base, "projects", "p", "users", "u", "workflow-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  return { base, stateFile };
}

test("a missing binding is absent, so a claim succeeds", async () => {
  const { base, stateFile } = await stateBase();
  const repo = await mkdtemp(path.join(tmpdir(), "focus-e-repo-"));
  try {
    const claimed = await claimFocusBinding({ stateFile, focusId: 501, projectDir: repo, repoKey: "repo-a" });
    assert.equal(claimed.ok, true);
    assert.ok(readFocusBinding({ stateFile, focusId: 501 }));
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("a malformed binding is unreadable, so a claim is refused", async () => {
  const { base, stateFile } = await stateBase();
  const repo = await mkdtemp(path.join(tmpdir(), "focus-e-repo-"));
  try {
    const bindings = path.join(base, "sessions", "focus-bindings");
    await mkdir(bindings, { recursive: true });
    await writeFile(path.join(bindings, "focus-502.json"), "{ this is not json", "utf8");

    const claimed = await claimFocusBinding({ stateFile, focusId: 502, projectDir: repo, repoKey: "repo-b" });
    assert.equal(claimed.ok, false, "a corrupted binding must not be overwritten");
    assert.equal(claimed.reason, "FOCUS_BINDING_UNREADABLE");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("a readable binding still blocks another project", async () => {
  const { base, stateFile } = await stateBase();
  const repoA = await mkdtemp(path.join(tmpdir(), "focus-e-a-"));
  const repoB = await mkdtemp(path.join(tmpdir(), "focus-e-b-"));
  try {
    assert.equal((await claimFocusBinding({ stateFile, focusId: 503, projectDir: repoA, repoKey: "repo-a" })).ok, true);
    const second = await claimFocusBinding({ stateFile, focusId: 503, projectDir: repoB, repoKey: "repo-b" });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "FOCUS_BOUND_TO_ANOTHER_PROJECT");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

test("a structurally invalid binding is unreadable, so a claim is refused", async () => {
  const { base, stateFile } = await stateBase();
  const repo = await mkdtemp(path.join(tmpdir(), "focus-e-repo-"));
  try {
    const bindings = path.join(base, "sessions", "focus-bindings");
    await mkdir(bindings, { recursive: true });
    // Valid JSON, but not a binding and not a session pointer. Treating this as
    // "unbound" would let a claim overwrite a damaged record.
    await writeFile(path.join(bindings, "focus-506.json"), JSON.stringify({ focusId: 506 }), "utf8");

    const claimed = await claimFocusBinding({ stateFile, focusId: 506, projectDir: repo, repoKey: "repo-c" });
    assert.equal(claimed.ok, false, "a structurally invalid binding must not be overwritten");
    assert.equal(claimed.reason, "FOCUS_BINDING_UNREADABLE");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("a non-object binding payload is unreadable", async () => {
  const { base, stateFile } = await stateBase();
  const repo = await mkdtemp(path.join(tmpdir(), "focus-e-repo-"));
  try {
    const bindings = path.join(base, "sessions", "focus-bindings");
    await mkdir(bindings, { recursive: true });
    await writeFile(path.join(bindings, "focus-507.json"), JSON.stringify(["not", "a", "binding"]), "utf8");

    const claimed = await claimFocusBinding({ stateFile, focusId: 507, projectDir: repo, repoKey: "repo-d" });
    assert.equal(claimed.ok, false);
    assert.equal(claimed.reason, "FOCUS_BINDING_UNREADABLE");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("a session pointer is still not a binding and does not block a claim", async () => {
  const { base, stateFile } = await stateBase();
  const repo = await mkdtemp(path.join(tmpdir(), "focus-e-repo-"));
  try {
    const sessions = path.join(base, "sessions");
    await mkdir(sessions, { recursive: true });
    // The legacy flat name can hold a session pointer. That is a different,
    // valid record type, not damage, so it must not be reported as unreadable.
    await writeFile(
      path.join(sessions, "focus-508.json"),
      JSON.stringify({ ownerKey: "ses_abc", projectDir: repo }),
      "utf8",
    );

    const claimed = await claimFocusBinding({ stateFile, focusId: 508, projectDir: repo, repoKey: "repo-e" });
    assert.equal(claimed.ok, true, "a session pointer must not block a focus claim");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("a damaged binding is not deleted by a snapshot rollback", async () => {
  const { base, stateFile } = await stateBase();
  try {
    const bindings = path.join(base, "sessions", "focus-bindings");
    await mkdir(bindings, { recursive: true });
    const file = path.join(bindings, "focus-509.json");
    await writeFile(file, "{ corrupted", "utf8");

    const snapshot = captureFocusBindingSnapshot({ stateFile, focusId: 509 });
    // A file that cannot be parsed is not "absent", so the snapshot must not
    // claim it can be restored by deleting it.
    const restored = await restoreFocusBindingSnapshot(snapshot);
    assert.equal(restored.ok, false);
    assert.equal(restored.error, "FOCUS_BINDING_UNREADABLE");
    assert.equal(readFileSync(file, "utf8"), "{ corrupted", "the damaged file must survive");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an unreadable binding is refused rather than treated as absent", async () => {
  const { base, stateFile } = await stateBase();
  const repo = await mkdtemp(path.join(tmpdir(), "focus-e-repo-"));
  try {
    const bindings = path.join(base, "sessions", "focus-bindings");
    await mkdir(bindings, { recursive: true });
    const file = path.join(bindings, "focus-504.json");
    await writeFile(file, JSON.stringify({ focusId: 504, projectDir: repo, repoKey: "repo-x" }), "utf8");

    // Deny read access. On Windows a chmod 000 does not block the owner, so the
    // test asserts the tri-state contract only where the OS can express it.
    await chmod(file, 0o000);
    let readable = true;
    try {
      const { readFileSync } = await import("node:fs");
      readFileSync(file, "utf8");
    } catch {
      readable = false;
    }

    if (!readable) {
      const claimed = await claimFocusBinding({ stateFile, focusId: 504, projectDir: repo, repoKey: "repo-x" });
      assert.equal(claimed.ok, false, "an unreadable binding must never be overwritten");
      assert.equal(claimed.reason, "FOCUS_BINDING_UNREADABLE");
    } else {
      // The platform cannot express the condition; the malformed-JSON test
      // above covers the same code path.
      assert.ok(true);
    }
    await chmod(file, 0o644).catch(() => {});
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
