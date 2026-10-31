import { test } from "node:test";
import assert from "node:assert";

import { handleClaimFactoryTask } from "../tools/handler-modules/factory-handlers.js";
import { clearTokenCache } from "../factory-client.js";

/**
 * Claiming a Factory task must not silently discard local work.
 *
 * On 31 October 2026 `claim_factory_task` was called while a local task was in
 * the middle of its release step. The claim called `workflowState.reset()`
 * WITHOUT archiving, so the running task vanished: no history entry, no
 * warning, nothing in the reply. `start_task` has always archived the task it
 * replaces (`reset({ archive: true })`); claim simply did not.
 *
 * The work was recoverable only because it had already been committed. Had it
 * not been, it would have been lost with no record that it ever existed.
 */

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const WORKSPACE = {
  projects: [{ id: "p1", name: "programinglive/dev-workflow-mcp-server" }],
  tasks: [
    {
      id: TASK_ID,
      projectId: "p1",
      title: "Perbaiki release tanpa tipe",
      description: "",
      acceptance: "tes lulus",
      definitionOfDone: "- [ ] tes lulus",
      priority: "normal",
      status: "backlog",
      createdAt: "2026-10-31T00:00:00.000Z",
      updatedAt: "2026-10-31T00:00:00.000Z",
      work: null,
    },
  ],
  events: [],
};

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function setEnv() {
  process.env.FACTORY_URL = "https://factory.test";
  process.env.FACTORY_TOKEN = "tok";
  process.env.FACTORY_DEVICE_ID = DEVICE_ID;
  process.env.FACTORY_MACHINE_ID = "HELLOWORLD";
  clearTokenCache();
}

function clearEnv() {
  for (const key of [
    "FACTORY_URL",
    "FACTORY_TOKEN",
    "FACTORY_DEVICE_ID",
    "FACTORY_MACHINE_ID",
  ]) {
    delete process.env[key];
  }
  clearTokenCache();
}

/** Mencatat bagaimana reset dipanggil dan apa yang tersisa di history. */
function fakeWorkflowState(initial) {
  const calls = [];
  return {
    state: { ...initial },
    calls,
    reset(options = {}) {
      calls.push(options);
      const previous = this.state;
      this.state = {
        currentPhase: "idle",
        taskDescription: "",
        taskType: "",
        history: previous.history || [],
      };
      return options.archive ? { archivedTask: previous.taskDescription } : { archivedTask: null };
    },
    async save() {},
  };
}

test("claim mengarsipkan task lokal yang sedang berjalan, bukan menghapusnya", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) return json({ session: { id: "sess-1", state: "active" } });
    return json({}, 500);
  });

  const workflowState = fakeWorkflowState({
    currentPhase: "release",
    taskDescription: "Task lama yang sedang di tahap rilis",
    taskType: "bugfix",
  });

  try {
    const response = await handleClaimFactoryTask({ recordId: TASK_ID, step: "Mulai" }, { workflowState });

    assert.strictEqual(workflowState.calls.length, 1, "reset harus dipanggil sekali");

    const options = workflowState.calls[0];
    assert.strictEqual(
      options.archive,
      true,
      "reset harus mengarsipkan task yang sedang berjalan. Tanpa ini task lama hilang " +
        "tanpa jejak di history - persis yang terjadi 31 Oktober 2026."
    );

    assert.match(
      String(options.reason || ""),
      /claim_factory_task|Factory/i,
      "alasan arsip harus menyebut claim_factory_task supaya history menjelaskan sebabnya"
    );

    const text = response.content.map((part) => part.text).join("\n");
    assert.match(
      text,
      /Task lama yang sedang di tahap rilis/,
      "jawaban harus menyebut task yang diarsipkan, supaya pengguna tahu pekerjaannya diganti"
    );
    assert.match(text, /history/i, "jawaban harus menyebut bahwa task lama tersimpan di history");
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("claim tidak mengeluh saat memang tidak ada task lokal yang berjalan", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) return json({ session: { id: "sess-1", state: "active" } });
    return json({}, 500);
  });

  const workflowState = fakeWorkflowState({
    currentPhase: "idle",
    taskDescription: "",
    taskType: "",
  });

  try {
    const response = await handleClaimFactoryTask({ recordId: TASK_ID }, { workflowState });
    const text = response.content.map((part) => part.text).join("\n");

    assert.doesNotMatch(text, /diarsipkan|interrupted/i, "tidak ada yang perlu dilaporkan");
    assert.match(text, /Claimed/);
  } finally {
    stub.restore();
    clearEnv();
  }
});
