import { test } from "node:test";
import assert from "node:assert";

import {
  createTask,
  listProjects,
  formatProjectList,
  CREATABLE_STATUSES,
  CREATABLE_PRIORITIES,
} from "../factory-client.js";

// ---------------------------------------------------------------------------
// Helpers
//
// These tests never touch the real Factory. `fetchImpl` is injected, which is
// the same seam the rest of this client uses.
// ---------------------------------------------------------------------------

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const CONFIG = {
  url: "https://factory.example.test",
  pocketBaseUrl: "https://pb.example.test",
  token: "test-token",
  email: null,
  password: null,
  device: { id: "dev-1", name: "TESTER", platform: "linux", agent: "test" },
};

/** Records every request and replies with `responder`. */
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

// ---------------------------------------------------------------------------
// createTask: payload
// ---------------------------------------------------------------------------

test("createTask posts create_task with the exact shape Factory validates", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 201, body: { id: PROJECT_ID, runId: null } }));

  await createTask(
    CONFIG,
    {
      projectId: PROJECT_ID,
      title: "Catat pekerjaan",
      description: "konteks",
      acceptance: "task muncul di board",
      priority: "high",
      status: "backlog",
    },
    impl,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://factory.example.test/api/factory");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    action: "create_task",
    task: {
      projectId: PROJECT_ID,
      title: "Catat pekerjaan",
      description: "konteks",
      acceptance: "task muncul di board",
      priority: "high",
      status: "backlog",
    },
  });
});

test("createTask defaults to backlog so recording work never starts a worker run", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 201, body: { id: PROJECT_ID } }));

  const created = await createTask(
    CONFIG,
    { projectId: PROJECT_ID, title: "Catat saja", acceptance: "tercatat" },
    impl,
  );

  assert.equal(calls[0].body.task.status, "backlog");
  assert.equal(calls[0].body.task.priority, "normal");
  assert.equal(created.status, "backlog");
  assert.equal(created.runId, null);
});

test("createTask returns the runId when Factory enqueues a run", async () => {
  const { impl } = fakeFetch(() => ({ status: 201, body: { id: PROJECT_ID, runId: "run-9" } }));

  const created = await createTask(
    CONFIG,
    { projectId: PROJECT_ID, title: "Jalankan", acceptance: "```run\nnpm test\n```", status: "queued" },
    impl,
  );

  assert.equal(created.runId, "run-9");
  assert.equal(created.status, "queued");
});

test("createTask omits an empty description rather than sending undefined", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 201, body: { id: PROJECT_ID } }));

  await createTask(CONFIG, { projectId: PROJECT_ID, title: "Tanpa deskripsi", acceptance: "selesai" }, impl);

  assert.equal(calls[0].body.task.description, "");
});

// ---------------------------------------------------------------------------
// createTask: local validation (mirrors Factory's zod schema)
// ---------------------------------------------------------------------------

test("createTask rejects a projectId that is not a UUID before calling Factory", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 201, body: {} }));

  await assert.rejects(
    () => createTask(CONFIG, { projectId: "p1", title: "Judul", acceptance: "selesai" }, impl),
    /not a UUID/,
  );
  assert.equal(calls.length, 0, "must not hit the network for an invalid projectId");
});

test("createTask requires projectId", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 201, body: {} }));

  await assert.rejects(
    () => createTask(CONFIG, { title: "Judul", acceptance: "selesai" }, impl),
    /projectId is required/,
  );
  assert.equal(calls.length, 0);
});

test("createTask enforces title length 3-140", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 201, body: {} }));

  await assert.rejects(
    () => createTask(CONFIG, { projectId: PROJECT_ID, title: "ab", acceptance: "selesai" }, impl),
    /title must be 3-140/,
  );
  await assert.rejects(
    () => createTask(CONFIG, { projectId: PROJECT_ID, title: "x".repeat(141), acceptance: "selesai" }, impl),
    /title must be 3-140/,
  );
  assert.equal(calls.length, 0);
});

test("createTask requires acceptance, because Factory rejects a task without it", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 201, body: {} }));

  await assert.rejects(
    () => createTask(CONFIG, { projectId: PROJECT_ID, title: "Judul" }, impl),
    /acceptance must be 3-3000/,
  );
  assert.equal(calls.length, 0);
});

test("createTask rejects unknown priority and status instead of forwarding them", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 201, body: {} }));

  await assert.rejects(
    () => createTask(CONFIG, { projectId: PROJECT_ID, title: "Judul", acceptance: "kriteria selesai", priority: "urgent" }, impl),
    /priority must be one of/,
  );
  await assert.rejects(
    () => createTask(CONFIG, { projectId: PROJECT_ID, title: "Judul", acceptance: "kriteria selesai", status: "running" }, impl),
    /status must be one of/,
  );
  assert.equal(calls.length, 0);
});

test("creatable statuses stay limited to what create_task accepts", () => {
  assert.deepEqual(CREATABLE_STATUSES, ["backlog", "queued"]);
  assert.deepEqual(CREATABLE_PRIORITIES, ["low", "normal", "high"]);
});

test("createTask surfaces Factory's own error message", async () => {
  const { impl } = fakeFetch(() => ({
    status: 409,
    body: { error: "Task ini belum punya perintah untuk dijalankan." },
  }));

  await assert.rejects(
    () =>
      createTask(
        CONFIG,
        { projectId: PROJECT_ID, title: "Judul", acceptance: "kriteria selesai", status: "queued" },
        impl,
      ),
    /belum punya perintah/,
  );
});

// ---------------------------------------------------------------------------
// listProjects
// ---------------------------------------------------------------------------

test("listProjects maps the workspace payload to id/name/repository", async () => {
  const { impl } = fakeFetch(() => ({
    body: {
      projects: [
        { id: PROJECT_ID, name: "erp", repository: "https://gitlab.com/x/erp.git", branch: "master", stack: "Laravel" },
      ],
      tasks: [],
      events: [],
    },
  }));

  const projects = await listProjects(CONFIG, impl);

  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, PROJECT_ID);
  assert.equal(projects[0].name, "erp");
  assert.equal(projects[0].stack, "Laravel");
});

test("formatProjectList says what to do when the workspace has no project", () => {
  assert.match(formatProjectList([]), /No projects/);
});

test("formatProjectList shows the UUID so it can be copied into create_factory_task", () => {
  const text = formatProjectList([{ id: PROJECT_ID, name: "erp", stack: "Laravel", branch: "master" }]);
  assert.match(text, new RegExp(PROJECT_ID));
  assert.match(text, /erp/);
});
