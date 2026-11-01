import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { parseStatusEntries } from "../git-helpers.js";
import { handleReadyCheck } from "../tools/handler-modules/status-handlers.js";

const text = (response) => response.content[0].text;

/**
 * State yang SUDAH memenuhi semua langkah selain gerbang dokumentasi, supaya
 * satu-satunya yang menentukan hasil adalah gerbang itu sendiri.
 */
async function readyState() {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-ready-"));
  await writeFile(path.join(dir, "README.md"), "# proyek\n", "utf8");
  const state = new WorkflowState(path.join(dir, "state.json"));
  state.state.currentPhase = "ready";
  state.state.taskDescription = "tambah login";
  state.state.featureFlowCreated = true;
  state.state.bugFixed = true;
  state.state.testsCreated = true;
  state.state.testsPassed = true;
  state.state.documentationCreated = true;
  state.state.documentationType = "README";
  state.state.definitionOfDone = [
    { id: "dod-1", text: "build lulus", status: "done", evidence: "npm test -> 500 pass", revision: 0 },
  ];
  state.state.dodRevision = 0;
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

test("ready check menolak saat source berubah tanpa dokumentasi", async () => {
  const { state, dir } = await readyState();
  try {
    const r = await handleReadyCheck(state, ctx({ status: " M src/a.js", toplevel: dir }));
    assert.match(text(r), /NOT READY/);
    assert.match(text(r), /Documentation updated for code changes/);
    assert.match(text(r), /waive_documentation/);
    assert.equal(state.state.readyCheckCompleted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ready check lolos saat berkas dokumentasi berubah", async () => {
  const { state, dir } = await readyState();
  try {
    const r = await handleReadyCheck(state, ctx({ status: " M src/a.js\n M README.md", toplevel: dir }));
    assert.match(text(r), /ALL CHECKS PASSED/);
    assert.equal(state.state.readyCheckCompleted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ready check lolos saat waiver tercatat", async () => {
  const { state, dir } = await readyState();
  try {
    state.state.documentationWaived = true;
    state.state.documentationWaiverReason = "refactor internal";
    const r = await handleReadyCheck(state, ctx({ status: " M src/a.js", toplevel: dir }));
    assert.match(text(r), /ALL CHECKS PASSED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ready check tidak memblokir saat git tidak tersedia", async () => {
  const { state, dir } = await readyState();
  try {
    const r = await handleReadyCheck(state, {});
    assert.match(text(r), /✅ Documentation updated for code changes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ready check menyebut umur README saat menolak", async () => {
  const { state, dir } = await readyState();
  try {
    const r = await handleReadyCheck(state, ctx({ status: " M src/a.js", toplevel: dir }));
    assert.match(text(r), /README\.md — commit terakhir 14 hari lalu/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
