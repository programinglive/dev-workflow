import { test } from "node:test";
import assert from "node:assert";

import { updateTaskDetails, clearTokenCache } from "../factory-client.js";

// Tool update dipakai untuk melengkapi DoD pada task yang dibuat sebelum field
// itu ada. Karena itu ia harus memakai expectedUpdatedAt dari GET /api/factory,
// bukan menebak, dan harus menolak permintaan kosong sebelum menyentuh jaringan.

const TASK_ID = "44444444-4444-4444-8444-444444444444";

const CONFIG = {
  url: "https://factory.example.test",
  pocketBaseUrl: "https://pb.example.test",
  token: "test-token",
  email: null,
  password: null,
};

const WORKSPACE = {
  projects: [{ id: "p1", name: "programminglive/dev-workflow-mcp-server" }],
  tasks: [
    {
      id: TASK_ID,
      projectId: "p1",
      title: "Task lama tanpa DoD",
      description: "",
      acceptance: "kriteria selesai",
      priority: "normal",
      status: "review",
      createdAt: "2026-10-29T00:00:00.000Z",
      updatedAt: "2026-10-29T00:00:00.000Z",
      work: null,
    },
  ],
  events: [],
};

function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    const { status = 200, body = {} } = responder(url, init) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      text: async () => JSON.stringify(body),
    };
  };
  return { impl, calls };
}

test("updateTaskDetails sends update_task with the task's current updatedAt", async () => {
  clearTokenCache();
  const { impl, calls } = fakeFetch((url, init) =>
    (init.method || "GET") === "GET"
      ? { body: WORKSPACE }
      : { body: { ok: true, id: TASK_ID, updatedAt: "2026-10-29T00:00:01.000Z" } },
  );

  const result = await updateTaskDetails(CONFIG, { recordId: TASK_ID, definitionOfDone: "- [ ] build lulus" }, impl);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://factory.example.test/api/factory");
  assert.equal(calls[1].body.action, "update_task");
  assert.equal(calls[1].body.id, TASK_ID);
  assert.equal(calls[1].body.expectedUpdatedAt, "2026-10-29T00:00:00.000Z");
  assert.deepEqual(calls[1].body.task, { definitionOfDone: "- [ ] build lulus" });
  assert.equal(result.id, TASK_ID);
  assert.equal(result.updatedAt, "2026-10-29T00:00:01.000Z");
});

test("updateTaskDetails refuses a request without any field before calling the network", async () => {
  const { impl, calls } = fakeFetch(() => ({ body: WORKSPACE }));

  await assert.rejects(() => updateTaskDetails(CONFIG, { recordId: TASK_ID }, impl), /at least one field/);
  assert.equal(calls.length, 0);
});

test("updateTaskDetails enforces the same bounds Factory validates", async () => {
  const { impl, calls } = fakeFetch(() => ({ body: WORKSPACE }));

  await assert.rejects(
    () => updateTaskDetails(CONFIG, { recordId: TASK_ID, definitionOfDone: "  x " }, impl),
    /definitionOfDone must be 3-3000/,
  );
  await assert.rejects(
    () => updateTaskDetails(CONFIG, { recordId: TASK_ID, title: "ab" }, impl),
    /title must be 3-140/,
  );
  await assert.rejects(
    () => updateTaskDetails(CONFIG, { recordId: TASK_ID, description: "x".repeat(4001) }, impl),
    /description must be at most 4000/,
  );
  assert.equal(calls.length, 0);
});

test("updateTaskDetails reports a stale task as an actionable message", async () => {
  const { impl } = fakeFetch((url, init) =>
    (init.method || "GET") === "GET"
      ? { body: WORKSPACE }
      : { status: 409, body: { error: "Task sudah berubah. Muat ulang sebelum mengedit." } },
  );

  await assert.rejects(
    () => updateTaskDetails(CONFIG, { recordId: TASK_ID, definitionOfDone: "- [ ] build lulus" }, impl),
    /sudah berubah/i,
  );
});

test("updateTaskDetails reports a task that is not visible", async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { projects: [], tasks: [], events: [] } }));

  await assert.rejects(
    () => updateTaskDetails(CONFIG, { recordId: TASK_ID, definitionOfDone: "- [ ] build lulus" }, impl),
    /No task with id/,
  );
  assert.equal(calls.length, 1, "hanya GET workspace, tidak ada tulisan");
});
