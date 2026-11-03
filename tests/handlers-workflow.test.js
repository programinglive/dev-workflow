import test from "node:test";
import assert from "node:assert/strict";
import { handleToolCall } from "../tools/handlers.js";
import { withWorkflowState, testUtils, createRequest, createGitMock } from "./test-helpers.js";
import { parseStatusEntries } from "../git-helpers.js";

test("run_tests guidance mentions core documentation types", async () => {
  await withWorkflowState(async (workflowState) => {
    workflowState.state.bugFixed = true;
    workflowState.state.testsCreated = true;
    await workflowState.save();

    const response = await handleToolCall({
      request: createRequest("run_tests", {
        passed: true,
        testCommand: "npm test",
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock(),
      utils: testUtils,
    });

    const text = response.content[0].text;
    assert.ok(
      text.includes("create or update documentation using 'create_documentation'"),
      "run_tests guidance should mention create or update documentation",
    );
    assert.ok(
      text.includes('"PRD", "README", "RELEASE_NOTES"'),
      "run_tests guidance should list core documentation types",
    );
  });
});

test("create_documentation verifies PRD file exists", async () => {
  await withWorkflowState(async (workflowState) => {
    workflowState.state.testsPassed = true;
    await workflowState.save();

    const response = await handleToolCall({
      request: createRequest("create_documentation", {
        documentationType: "PRD",
        summary: "Updated PRD for documentation workflow expectations",
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock(),
      utils: testUtils,
    });

    assert.equal(workflowState.state.documentationCreated, true);
    assert.equal(workflowState.state.documentationType, "PRD");
    assert.equal(
      workflowState.state.documentationSummary,
      "Updated PRD for documentation workflow expectations",
    );
    assert.ok(
      response.content[0].text.includes("Documentation created/updated!"),
      "create_documentation response should mention created/updated",
    );
    assert.ok(
      // Dulu baris ini berbunyi "PRD verified: docs/product/PRD.md exists", padahal
      // yang diperiksa `ensurePrdExists()` adalah docs/PRD.md milik paket MCP, bukan
      // repo proyek. Sekarang bunyinya jujur menyebut objek yang benar-benar dicek.
      response.content[0].text.includes("PRD check"),
      "create_documentation response should report the PRD check",
    );
  });
});

test("create_feature_flow records flow and guidance", async () => {
  await withWorkflowState(async (workflowState) => {
    workflowState.state.currentPhase = "coding";
    await workflowState.save();

    const response = await handleToolCall({
      request: createRequest("create_feature_flow", {
        mermaidCode: "graph TD; A-->B;",
        description: "Test flow implementation",
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock(),
      utils: testUtils,
    });

    assert.equal(workflowState.state.featureFlowCreated, true);
    assert.equal(workflowState.state.mermaidCode, "graph TD; A-->B;");
    assert.equal(workflowState.state.featureFlowDescription, "Test flow implementation");

    const text = response.content[0].text;
    assert.ok(text.includes("✅ Feature flow recorded!"), "Should confirm recording");
    assert.ok(text.includes("Description: Test flow implementation"), "Should show description");
    assert.ok(text.includes("⏳ Fix/implement the feature"), "Should show next steps");
  });
});

test("start_task mencatat berkas yang sudah kotor sebagai baseline", async () => {
  // Baseline inilah satu-satunya cara commit_and_push bisa membedakan
  // pekerjaan sesi ini dari pekerjaan sesi lain di working tree yang sama.
  await withWorkflowState(async (workflowState) => {
    const response = await handleToolCall({
      request: createRequest("start_task", {
        description: "Task dengan working tree kotor",
        type: "bugfix",
        definitionOfDone: ["baseline tercatat"],
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock({
        getStatusOutput: async () => " M knowledge/billing.yaml\n?? catatan-baru.md\n",
        parseStatusEntries,
      }),
      utils: testUtils,
    });

    assert.ok(response.content[0].text.includes("Task Started"));
    assert.deepEqual(workflowState.state.dirtyAtStart, [
      { code: "M", path: "knowledge/billing.yaml" },
      { code: "??", path: "catatan-baru.md" },
    ]);
  });
});

test("start_task suggests English project conventions and multilingual app localization", async () => {
  await withWorkflowState(async (workflowState) => {
    const response = await handleToolCall({
      request: createRequest("start_task", {
        description: "Add language conventions",
        type: "feature",
        definitionOfDone: ["guidance returned"],
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock(),
      utils: testUtils,
    });

    const text = response.content[0].text;
    assert.match(text, /English.*README/i);
    assert.match(text, /developer-facing.*code/i);
    assert.match(text, /commit messages/i);
    assert.match(text, /non-English.*user-facing/i);
    assert.match(text, /multilingual.*localization/i);
    assert.match(text, /existing.*project policy/i);
    assert.match(text, /task-specific branch/i);
    assert.match(text, /separate.*worktree/i);
    assert.match(text, /sessions may work on this repository at the same time/i);
  });
});

test("start_task tetap jalan walau git gagal membaca status", async () => {
  // Baseline hanya untuk memperingatkan saat commit. Kegagalan git di sini
  // tidak boleh menggagalkan task yang sah.
  await withWorkflowState(async (workflowState) => {
    const response = await handleToolCall({
      request: createRequest("start_task", {
        description: "Task tanpa akses git",
        type: "feature",
        definitionOfDone: ["task tetap dimulai"],
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock({
        getStatusOutput: async () => {
          throw new Error("not a git repository");
        },
        parseStatusEntries,
      }),
      utils: testUtils,
    });

    assert.ok(response.content[0].text.includes("Task Started"));
    assert.deepEqual(workflowState.state.dirtyAtStart, []);
  });
});

test("start_task menyimpan baseline kosong untuk working tree bersih", async () => {
  await withWorkflowState(async (workflowState) => {
    await handleToolCall({
      request: createRequest("start_task", {
        description: "Task bersih",
        type: "feature",
        definitionOfDone: ["baseline kosong"],
      }),
      normalizeRequestArgs: (args) => ({ args, error: null }),
      workflowState,
      exec: async () => ({ stdout: "" }),
      git: createGitMock({ getStatusOutput: async () => "", parseStatusEntries }),
      utils: testUtils,
    });

    assert.deepEqual(workflowState.state.dirtyAtStart, []);
  });
});
