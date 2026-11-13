import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";
import { parseStatusEntries } from "../git-helpers.js";
import { handleCompleteTask } from "../tools/handler-modules/commit-handlers.js";
import { handleNextSteps } from "../tools/handler-modules/next-steps-handlers.js";

const text = (response) => response.content[0].text;

/** State yang sudah lolos gerbang DoD, sehingga complete_task boleh menutupnya. */
async function closableState() {
  const dir = await mkdtemp(path.join(tmpdir(), "dwf-next-"));
  const state = new WorkflowState(path.join(dir, "state.json"));
  state.state.currentPhase = "ready_to_complete";
  state.state.taskDescription = "tambah login";
  state.state.taskType = "feature";
  state.state.bugFixed = true;
  state.state.testsCreated = true;
  state.state.testsPassed = true;
  state.state.documentationCreated = true;
  state.state.documentationType = "README";
  state.state.commitAndPushCompleted = true;
  state.state.released = true;
  state.state.lastCommitSha = "a".repeat(40);
  state.state.definitionOfDone = [
    {
      id: "dod-1",
      text: "halaman login terverifikasi",
      status: "waived",
      waivedReason: "butuh akun staging",
      revision: 0,
    },
  ];
  state.state.dodRevision = 0;
  return { state, dir };
}

function ctx({ status = "", todos = [], paths = [] } = {}) {
  return {
    git: {
      getStatusOutput: async () => status,
      parseStatusEntries,
      inspectCommitDiff: async () => ({ paths, todos }),
      getToplevel: async () => "",
    },
  };
}

test("complete_task menolak nextSteps yang tidak valid", async () => {
  const { state, dir } = await closableState();
  try {
    const r = await handleCompleteTask(
      { commitMessage: "feat: x", nextSteps: ["pendek"] },
      state,
      ctx(),
    );
    assert.match(text(r), /^⚠️/);
    assert.match(text(r), /10/);
    assert.equal(state.state.currentPhase, "ready_to_complete");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("complete_task menampilkan blok rekomendasi dan menyimpannya", async () => {
  const { state, dir } = await closableState();
  try {
    const r = await handleCompleteTask(
      { commitMessage: "feat: x", nextSteps: ["perbaiki refreshToken"] },
      state,
      ctx({ todos: [{ path: "src/auth.js", line: 12, text: "// TODO: rapikan" }] }),
    );
    assert.match(text(r), /Saran pekerjaan selanjutnya/);
    assert.match(text(r), /butuh akun staging/);
    assert.match(text(r), /perbaiki refreshToken/);

    const entry = state.state.history.at(-1);
    assert.equal(entry.aiSuggestions.length, 1);
    assert.ok(entry.recommendations.some((item) => item.source === "ai"));
    assert.ok(entry.recommendations.some((item) => item.source === "signal"));
    assert.equal(entry.documentation.type, "README");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("complete_task tanpa nextSteps tetap menutup task dan meminta saran", async () => {
  const { state, dir } = await closableState();
  try {
    const r = await handleCompleteTask({ commitMessage: "feat: x" }, state, ctx());
    assert.match(text(r), /^✅/);
    assert.match(text(r), /Kirim 'nextSteps'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("next_steps menampilkan rekomendasi tersimpan", async () => {
  const { state, dir } = await closableState();
  try {
    await handleCompleteTask(
      { commitMessage: "feat: x", nextSteps: ["perbaiki refreshToken"] },
      state,
      ctx(),
    );
    const r = await handleNextSteps({}, state);
    assert.match(text(r), /Saran pekerjaan selanjutnya/);
    assert.match(text(r), /perbaiki refreshToken/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("next_steps tanpa history tidak crash", async () => {
  const { state, dir } = await closableState();
  try {
    const r = await handleNextSteps({}, state);
    assert.match(text(r), /Belum ada rekomendasi tersimpan/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("next_steps mengabaikan entri history lama tanpa recommendations", async () => {
  const { state, dir } = await closableState();
  try {
    state.state.history = [{ taskDescription: "lama", taskType: "other", commitMessage: "x" }];
    const r = await handleNextSteps({}, state);
    assert.match(text(r), /Belum ada rekomendasi tersimpan/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
