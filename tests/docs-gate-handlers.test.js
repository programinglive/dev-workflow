import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { parseStatusEntries } from "../git-helpers.js";
import {
  handleCreateDocumentation,
  handleWaiveDocumentation,
} from "../tools/handler-modules/workflow-handlers.js";

const text = (response) => response.content[0].text;

/**
 * State siap-dokumentasi: tes sudah lulus, sehingga handler boleh berjalan.
 * Dibuat per tes supaya tidak ada tes yang mewarisi state tes lain.
 */
async function makeState() {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-doc-"));
  const state = new WorkflowState(path.join(dir, "state.json"));
  await writeFile(path.join(dir, "README.md"), "# proyek\n", "utf8");
  state.state.currentPhase = "documentation";
  state.state.taskDescription = "tambah login";
  state.state.bugFixed = true;
  state.state.testsCreated = true;
  state.state.testsPassed = true;
  return { state, dir };
}

function ctx({ status = "", toplevel = "", failToplevel = false } = {}) {
  return {
    git: {
      getStatusOutput: async () => status,
      parseStatusEntries,
      getToplevel: async () => {
        if (failToplevel) throw new Error("bukan repo");
        return toplevel;
      },
      getLastCommitForPath: async () => "2026-10-18T00:00:00Z",
    },
  };
}

test("create_documentation menolak files[] yang tidak muncul di working tree", async () => {
  const { state, dir } = await makeState();
  try {
    const r = await handleCreateDocumentation(
      { documentationType: "README", summary: "x", files: ["README.md"] },
      state,
      ctx({ status: " M src/a.js", toplevel: dir }),
    );
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /README\.md/);
    assert.match(text(r), /tidak muncul/);
    assert.equal(state.state.documentationFiles.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("create_documentation menolak files[] yang bukan dokumentasi", async () => {
  const { state, dir } = await makeState();
  try {
    const r = await handleCreateDocumentation(
      { documentationType: "README", summary: "x", files: ["src/a.js"] },
      state,
      ctx({ status: " M src/a.js", toplevel: dir }),
    );
    assert.match(text(r), /bukan berkas dokumentasi/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("create_documentation menyimpan files yang terverifikasi", async () => {
  const { state, dir } = await makeState();
  try {
    const r = await handleCreateDocumentation(
      { documentationType: "README", summary: "x", files: ["README.md"] },
      state,
      ctx({ status: " M src/a.js\n M README.md", toplevel: dir }),
    );
    assert.match(text(r), /^✅/);
    assert.deepEqual(state.state.documentationFiles, ["README.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("create_documentation tanpa files tetap berhasil tetapi menyebut gerbang belum terpenuhi", async () => {
  const { state, dir } = await makeState();
  try {
    const r = await handleCreateDocumentation(
      { documentationType: "inline-comments", summary: "x" },
      state,
      ctx({ status: " M src/a.js", toplevel: dir }),
    );
    assert.match(text(r), /^✅/);
    assert.match(text(r), /gerbang dokumentasi belum terpenuhi/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waive_documentation menolak alasan kosong atau terlalu pendek", async () => {
  const { state, dir } = await makeState();
  try {
    assert.match(text(await handleWaiveDocumentation({ reason: "" }, state)), /^⚠️/);
    assert.match(text(await handleWaiveDocumentation({ reason: "abc" }, state)), /^⚠️/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waive_documentation mencatat alasan di state", async () => {
  const { state, dir } = await makeState();
  try {
    const r = await handleWaiveDocumentation(
      { reason: "perubahan hanya refactor internal" },
      state,
    );
    assert.match(text(r), /^✅/);
    assert.equal(state.state.documentationWaived, true);
    assert.equal(state.state.documentationWaiverReason, "perubahan hanya refactor internal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waive_documentation menolak sebelum tes lulus", async () => {
  const { state, dir } = await makeState();
  try {
    state.state.testsPassed = false;
    assert.match(text(await handleWaiveDocumentation({ reason: "cukup panjang" }, state)), /^⚠️/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
