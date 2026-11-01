import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowState } from "../workflow-state.js";

test("state segar punya field gerbang dokumentasi dengan default", () => {
  const s = new WorkflowState(path.join(tmpdir(), "unused-state.json"));
  assert.deepEqual(s.state.documentationFiles, []);
  assert.equal(s.state.documentationWaived, false);
  assert.equal(s.state.documentationWaiverReason, "");
  assert.equal(s.state.lastCommitSha, "");
});

test("reset mengosongkan field gerbang dokumentasi", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-"));
  try {
    const s = new WorkflowState(path.join(dir, "state.json"));
    s.state.documentationFiles = ["README.md"];
    s.state.documentationWaived = true;
    s.state.documentationWaiverReason = "tidak relevan";
    s.state.lastCommitSha = "abc123";
    s.reset();
    assert.deepEqual(s.state.documentationFiles, []);
    assert.equal(s.state.documentationWaived, false);
    assert.equal(s.state.documentationWaiverReason, "");
    assert.equal(s.state.lastCommitSha, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load menormalkan berkas state lama tanpa field baru", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-"));
  try {
    const file = path.join(dir, "state.json");
    await writeFile(
      file,
      JSON.stringify({
        currentPhase: "coding",
        taskDescription: "lama",
        documentationFiles: "bukan-array",
        documentationWaived: "ya",
        lastCommitSha: 42,
      }),
      "utf8",
    );
    const s = new WorkflowState(file);
    await s.load();
    assert.deepEqual(s.state.documentationFiles, []);
    assert.equal(s.state.documentationWaived, false);
    assert.equal(s.state.documentationWaiverReason, "");
    assert.equal(s.state.lastCommitSha, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load membuang entri documentationFiles yang bukan string atau kosong", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-"));
  try {
    const file = path.join(dir, "state.json");
    await writeFile(
      file,
      JSON.stringify({
        currentPhase: "coding",
        taskDescription: "x",
        documentationFiles: ["README.md", "", 7, null, "docs/a.md"],
      }),
      "utf8",
    );
    const s = new WorkflowState(file);
    await s.load();
    assert.deepEqual(s.state.documentationFiles, ["README.md", "docs/a.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
