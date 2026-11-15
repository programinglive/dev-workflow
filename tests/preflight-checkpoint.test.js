import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { withWorkflowState } from "./test-helpers.js";
import { runPreflight } from "../preflight.js";

test("preflight persistence preserves checkpoint, history and Todo linkage", async () => {
  await withWorkflowState(async (state) => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "preflight-checkpoint-"));
    try {
      await writeFile(path.join(projectDir, "README.md"), "# Project\n");

      state.state.currentPhase = "coding";
      state.state.taskDescription = "Existing task";
      state.state.checkpoint = { baseSha: "abc123", summary: "old checkpoint", commits: ["c1"] };
      state.state.history = [{ task: "previous task", commit: "old" }];
      state.state.zettly = { externalLinks: { todo: { id: 791 }, drawing: { id: 455 } } };
      await state.save();

      const record = runPreflight({ projectDir, taskId: "task-1", taskDescription: "Existing task" });
      state.state.preflight = record;
      await state.save();

      await state.load();

      assert.equal(state.state.checkpoint.baseSha, "abc123");
      assert.equal(state.state.checkpoint.summary, "old checkpoint");
      assert.deepEqual(state.state.checkpoint.commits, ["c1"]);
      assert.equal(state.state.history.length, 1);
      assert.equal(state.state.history[0].task, "previous task");
      assert.equal(state.state.zettly.externalLinks.todo.id, 791);
      assert.equal(state.state.zettly.externalLinks.drawing.id, 455);
      assert.equal(state.state.preflight.ok, true);
      assert.equal(state.state.preflight.projectRoot, path.resolve(projectDir));
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

test("a preflight record does not replace the task description or DoD", async () => {
  await withWorkflowState(async (state) => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "preflight-checkpoint-"));
    try {
      await writeFile(path.join(projectDir, "README.md"), "# Project\n");
      state.state.currentPhase = "coding";
      state.state.taskDescription = "Keep this task";
      state.state.definitionOfDone = [{ id: "dod-1", text: "keep this item", status: "open" }];
      await state.save();

      state.state.preflight = runPreflight({ projectDir, taskId: "task-2" });
      await state.save();
      await state.load();

      assert.equal(state.state.taskDescription, "Keep this task");
      assert.equal(state.state.definitionOfDone.length, 1);
      assert.equal(state.state.definitionOfDone[0].text, "keep this item");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
