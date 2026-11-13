import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { testUtils } from "./test-helpers.js";

/**
 * The deployment gate.
 *
 * Production ended up running files that no tag contained, because a file was
 * copied straight onto a server. The MCP had no record of it: `released` only
 * ever meant "a release command ran". These tests pin the replacement contract:
 * a deployable project cannot be closed until the tag that actually shipped is
 * recorded, and the tag must exist and contain HEAD.
 */

async function withState(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "record-deployment-"));
  const stateFile = path.join(dir, "state.json");
  const state = new WorkflowState(stateFile);
  await state.load();

  try {
    await callback(state, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function call(name, args, workflowState, overrides = {}) {
  return handleToolCall({
    request: { params: { name, arguments: args } },
    normalizeRequestArgs,
    workflowState,
    exec: async () => ({ stdout: "" }),
    git: {
      hasWorkingChanges: async () => false,
      hasStagedChanges: async () => false,
      getCurrentBranch: async () => "main",
      getPrimaryBranch: async () => "main",
      getHeadSha: async () => "a".repeat(40),
      getRemoteBranchSha: async () => "a".repeat(40),
      getLastCommitMessage: async () => "",
      getStatusOutput: async () => "",
    },
    utils: testUtils,
    ...overrides,
  });
}

function provenDod() {
  return [
    {
      id: "dod-1",
      text: "perubahan terbukti",
      status: "done",
      evidence: "dijalankan dan lulus",
      waivedReason: "",
      revision: 1,
      updatedAt: "",
    },
  ];
}

async function deployableProject() {
  const dir = await mkdtemp(path.join(tmpdir(), "deployable-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "clinic", version: "5.1.2", scripts: { release: "node scripts/release.cjs" } }, null, 2),
  );
  await mkdir(path.join(dir, "scripts", "ops"), { recursive: true });
  await writeFile(
    path.join(dir, "scripts", "ops", "clinic-gitlab-release.cjs"),
    "// clinic release runner marker\n",
  );
  return dir;
}

test("record_deployment menolak tag yang tidak ada di repo", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "release";
    const response = await call(
      "record_deployment",
      { tag: "v5.1.3", pipelineId: "12345", sites: ["timelessbintaro"], evidence: "health receipt 200" },
      state,
      {
        exec: async (command, options = {}) => {
          const joined = [command, ...(options.arguments || [])].join(" ");
          if (joined.includes("rev-parse")) throw new Error("unknown revision");
          return { stdout: "" };
        },
      },
    );

    const text = response.content[0].text;
    assert.match(text, /tidak ada di repo/i);
    assert.equal(state.state.deployment, null);
  });
});

test("record_deployment menolak tag yang tidak memuat HEAD", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "release";
    const response = await call(
      "record_deployment",
      { tag: "v5.1.2", pipelineId: "12345", sites: ["timelessbintaro"], evidence: "health receipt 200" },
      state,
      {
        exec: async (command, options = {}) => {
          const joined = [command, ...(options.arguments || [])].join(" ");
          if (joined.includes("rev-parse")) return { stdout: "b".repeat(40) };
          if (joined.includes("merge-base")) throw new Error("not an ancestor");
          return { stdout: "" };
        },
      },
    );

    const text = response.content[0].text;
    assert.match(text, /bukan bagian dari tag/i);
    assert.match(text, /TIDAK ikut terrilis/i);
    assert.equal(state.state.deployment, null);
  });
});

test("record_deployment menyimpan tag, pipeline, site, dan bukti", async () => {
  await withState(async (state) => {
    state.state.currentPhase = "release";
    const response = await call(
      "record_deployment",
      {
        tag: "v5.1.3",
        pipelineId: "https://gitlab.com/-/pipelines/999",
        sites: ["timelessbintaro", "pos"],
        evidence: "GET / returns v5.1.3",
      },
      state,
      {
        exec: async (command, options = {}) => {
          const joined = [command, ...(options.arguments || [])].join(" ");
          if (joined.includes("rev-parse")) return { stdout: "b".repeat(40) };
          if (joined.includes("merge-base")) return { stdout: "" };
          return { stdout: "" };
        },
      },
    );

    assert.match(response.content[0].text, /Deployment recorded: v5\.1\.3/);
    assert.equal(state.state.deployment.tag, "v5.1.3");
    assert.equal(state.state.deployment.pipelineId, "https://gitlab.com/-/pipelines/999");
    assert.deepEqual(state.state.deployment.sites, ["timelessbintaro", "pos"]);
    assert.ok(state.state.deployment.recordedAt);
  });
});

test("complete_task menolak proyek deployable tanpa rekaman deployment", async () => {
  const projectDir = await deployableProject();
  try {
    await withState(async (state) => {
      state.state.currentPhase = "ready_to_complete";
      state.state.projectDir = projectDir;
      state.state.definitionOfDone = provenDod();
      state.state.dodRevision = 1;
      state.state.releaseSkipped = false;
      state.state.deployment = null;

      const response = await call("complete_task", { commitMessage: "fix: x" }, state);
      const text = response.content[0].text;

      assert.match(text, /dirilis lewat CI\/CD/i);
      assert.match(text, /record_deployment/i);
      assert.equal(state.state.currentPhase, "ready_to_complete", "task must stay open");
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("complete_task menerima proyek deployable yang sudah mencatat deployment", async () => {
  const projectDir = await deployableProject();
  try {
    await withState(async (state) => {
      state.state.currentPhase = "ready_to_complete";
      state.state.projectDir = projectDir;
      state.state.definitionOfDone = provenDod();
      state.state.dodRevision = 1;
      state.state.releaseSkipped = false;
      state.state.deployment = {
        tag: "v5.1.3",
        tagSha: "b".repeat(40),
        headSha: "a".repeat(40),
        pipelineId: "12345",
        sites: ["timelessbintaro"],
        evidence: "health receipt 200",
        recordedAt: new Date().toISOString(),
      };

      const response = await call("complete_task", { commitMessage: "fix: x" }, state);
      const text = response.content[0].text;

      assert.doesNotMatch(text, /belum ada deployment yang dicatat/i);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("skip_release dengan alasan membuka gerbang deployment", async () => {
  const projectDir = await deployableProject();
  try {
    await withState(async (state) => {
      state.state.currentPhase = "ready_to_complete";
      state.state.projectDir = projectDir;
      state.state.definitionOfDone = provenDod();
      state.state.dodRevision = 1;
      state.state.releaseSkipped = true;
      state.state.releaseSkippedReason = "dokumentasi saja, tidak menyentuh produksi";
      state.state.deployment = null;

      const response = await call("complete_task", { commitMessage: "docs: x" }, state);
      const text = response.content[0].text;

      assert.doesNotMatch(text, /belum ada deployment yang dicatat/i);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
