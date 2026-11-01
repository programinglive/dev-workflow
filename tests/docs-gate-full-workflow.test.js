import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleToolCall } from "../tools/handlers.js";
import { withWorkflowState, testUtils, createRequest, createGitMock } from "./test-helpers.js";
import { parseStatusEntries } from "../git-helpers.js";

const text = (response) => response.content[0].text;

/** Git tiruan yang bisa menjawab working tree dan direktori repo. */
function gateGit({ status, toplevel }) {
  return createGitMock({
    getStatusOutput: async () => status,
    parseStatusEntries,
    getToplevel: async () => toplevel,
    getLastCommitForPath: async () => "2026-10-18T00:00:00Z",
    hasWorkingChanges: async () => true,
  });
}

/** State yang lolos gerbang DoD, supaya yang diuji hanya gerbang dokumentasi. */
async function primeState(workflowState) {
  workflowState.state.currentPhase = "coding";
  workflowState.state.taskDescription = "tambah login";
  workflowState.state.taskType = "feature";
  workflowState.state.definitionOfDone = [
    { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test -> 500 pass", revision: 0 },
  ];
  workflowState.state.dodRevision = 0;
  await workflowState.save();
}

const fullArgs = {
  summary: "menambah login",
  testCommand: "npm test",
  documentationType: "README",
  documentationSummary: "README diperbarui",
  commitMessage: "feat: login",
  releaseCommand: "npm run release",
  mermaidCode: "graph TD; A-->B;",
  featureFlowDescription: "alur login",
};

test("run_full_workflow menolak sebelum langkah pertama saat dokumentasi kurang", async () => {
  await withWorkflowState(async (workflowState) => {
    const dir = await mkdtemp(path.join(tmpdir(), "dwf-full-"));
    try {
      await writeFile(path.join(dir, "README.md"), "# proyek\n", "utf8");
      await primeState(workflowState);

      const response = await handleToolCall({
        request: createRequest("run_full_workflow", { ...fullArgs }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: gateGit({ status: " M src/a.js", toplevel: dir }),
        utils: testUtils,
      });

      assert.match(text(response), /Dibatalkan sebelum satu langkah pun berjalan/);
      assert.match(text(response), /src\/a\.js/);
      assert.equal(workflowState.state.bugFixed, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("run_full_workflow menerima documentationWaiverReason", async () => {
  await withWorkflowState(async (workflowState) => {
    const dir = await mkdtemp(path.join(tmpdir(), "dwf-full-"));
    try {
      await writeFile(path.join(dir, "README.md"), "# proyek\n", "utf8");
      await primeState(workflowState);

      const response = await handleToolCall({
        request: createRequest("run_full_workflow", {
          ...fullArgs,
          documentationWaiverReason: "perubahan hanya refactor internal",
        }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: gateGit({ status: " M src/a.js", toplevel: dir }),
        utils: testUtils,
      });

      assert.doesNotMatch(text(response), /Dibatalkan sebelum satu langkah pun berjalan/);
      assert.equal(workflowState.state.documentationWaived, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("run_full_workflow tidak menolak saat dokumentasi ikut berubah", async () => {
  await withWorkflowState(async (workflowState) => {
    const dir = await mkdtemp(path.join(tmpdir(), "dwf-full-"));
    try {
      await writeFile(path.join(dir, "README.md"), "# proyek\n", "utf8");
      await primeState(workflowState);

      const response = await handleToolCall({
        request: createRequest("run_full_workflow", {
          ...fullArgs,
          documentationFiles: ["README.md"],
        }),
        normalizeRequestArgs: (args) => ({ args, error: null }),
        workflowState,
        exec: async () => ({ stdout: "" }),
        git: gateGit({ status: " M src/a.js\n M README.md", toplevel: dir }),
        utils: testUtils,
      });

      assert.doesNotMatch(text(response), /Dibatalkan sebelum satu langkah pun berjalan/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
