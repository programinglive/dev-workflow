import { test } from "node:test";
import assert from "node:assert/strict";

import { finishWork, findActiveWorkSession } from "../factory-client.js";

/**
 * MEASURED BUG (10 November 2026)
 * ------------------------------
 * `sync_task_status` refused every running task with:
 *
 *     Task "..." has no active work session. Use claim_factory_task first...
 *
 * while the Factory board showed the same task as `running` with an active work
 * session. The board was right; the client was reading the wrong shape.
 *
 * `GET /api/factory` deliberately sends only a badge per task
 * (`activityStatus`, device name/agent, client session title) because the full
 * session is 191 KB across 829 tasks and no list renders it. The badge carries
 * no `id` and no `state`. `finishWork` read the session from that badge, so
 * `session.state` was always `undefined` and the guard refused every task.
 *
 * The real session lives on `GET /api/work`, which returns `id`, `state` and
 * `device.id`. These tests pin that the client reads it from there.
 */

const TASK_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const CONFIG = {
  url: "https://factory.test",
  token: "tok-1",
  pocketBaseUrl: "https://pb.test",
  machineId: "HELLOWORLD",
  agent: "opencode-deepseek",
  deviceId: DEVICE_ID,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The workspace payload as Factory really sends it: a badge, not a session. */
const WORKSPACE_WITH_BADGE_ONLY = {
  projects: [{ id: "p1", name: "programinglive/dev-workflow-mcp-server" }],
  tasks: [
    {
      id: TASK_ID,
      projectId: "p1",
      title: "Enforce strict task and project identity",
      priority: "normal",
      status: "running",
      createdAt: "2026-11-10T08:21:09.542Z",
      updatedAt: "2026-11-10T09:32:35.166Z",
      work: {
        activityStatus: "active",
        device: { name: "HELLOWORLD", agent: "opencode-deepseek" },
        clientSession: null,
      },
    },
  ],
  events: [],
};

/** The work endpoint payload: the real session, with id and state. */
const WORK_SESSIONS = {
  devices: [{ id: DEVICE_ID, name: "HELLOWORLD" }],
  sessions: [
    {
      id: SESSION_ID,
      taskId: TASK_ID,
      device: { id: DEVICE_ID, name: "HELLOWORLD", platform: "win32", agent: "opencode-deepseek" },
      state: "active",
      activityStatus: "active",
      step: "Closing the completed work",
      summary: "",
      clientSession: null,
      startedAt: "2026-11-10T08:21:09.542Z",
      lastSeenAt: "2026-11-10T09:32:35.166Z",
      endedAt: null,
    },
  ],
  staleAfterSeconds: 120,
};

function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const entry = {
      url: String(url),
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(entry);
    for (const handler of handlers) {
      const result = handler(entry);
      if (result) return result;
    }
    return json({ error: "unexpected call" }, 500);
  };
  impl.calls = calls;
  return impl;
}

function routes({ workspace = WORKSPACE_WITH_BADGE_ONLY, work = WORK_SESSIONS, finish = { session: { id: SESSION_ID, state: "review" } } } = {}) {
  return [
    (call) => (call.url.endsWith("/api/factory") ? json(workspace) : null),
    (call) => (call.url.endsWith("/api/work") && call.method === "GET" ? json(work) : null),
    (call) => (call.url.endsWith("/api/work") && call.method === "POST" ? json(finish) : null),
  ];
}

test("findActiveWorkSession reads the real session from /api/work, not the workspace badge", async () => {
  const fetchImpl = fakeFetch(routes());
  const session = await findActiveWorkSession(CONFIG, { taskId: TASK_ID, deviceId: DEVICE_ID }, fetchImpl);

  assert.ok(session, "the active session must be found");
  assert.equal(session.id, SESSION_ID);
  assert.equal(session.state, "active");
  assert.ok(
    fetchImpl.calls.some((call) => call.url.endsWith("/api/work") && call.method === "GET"),
    "the session must be read from GET /api/work",
  );
});

test("finishWork reports review for a task whose workspace badge carries no session id", async () => {
  const fetchImpl = fakeFetch(routes());
  const session = await finishWork(
    CONFIG,
    { taskId: TASK_ID, outcome: "review", summary: "Work is ready for approval." },
    fetchImpl,
  );

  assert.equal(session?.state, "review");
  const post = fetchImpl.calls.find((call) => call.url.endsWith("/api/work") && call.method === "POST");
  assert.ok(post, "the finish request must be sent");
  assert.equal(post.body.action, "finish");
  assert.equal(post.body.sessionId, SESSION_ID, "the real session id is required");
  assert.equal(post.body.deviceId, DEVICE_ID);
  assert.equal(post.body.outcome, "review");
});

test("finishWork refuses honestly when the active session belongs to another device", async () => {
  const otherDevice = {
    ...WORK_SESSIONS,
    sessions: [
      {
        ...WORK_SESSIONS.sessions[0],
        device: { ...WORK_SESSIONS.sessions[0].device, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      },
    ],
  };
  const fetchImpl = fakeFetch(routes({ work: otherDevice }));

  await assert.rejects(
    () => finishWork(CONFIG, { taskId: TASK_ID, outcome: "review", summary: "Ready." }, fetchImpl),
    /no active work session on this device/i,
  );
  const post = fetchImpl.calls.find((call) => call.url.endsWith("/api/work") && call.method === "POST");
  assert.equal(post, undefined, "nothing may be finished for another device's session");
});

test("finishWork refuses when the session exists for this device but is already closed", async () => {
  const closed = {
    ...WORK_SESSIONS,
    sessions: [{ ...WORK_SESSIONS.sessions[0], state: "review", endedAt: "2026-11-10T09:40:00.000Z" }],
  };
  const fetchImpl = fakeFetch(routes({ work: closed }));

  await assert.rejects(
    () => finishWork(CONFIG, { taskId: TASK_ID, outcome: "review", summary: "Ready." }, fetchImpl),
    /no active work session on this device/i,
  );
});

test("a review reported twice is still refused before any finish request", async () => {
  const workspace = {
    ...WORKSPACE_WITH_BADGE_ONLY,
    events: [
      {
        id: "e1",
        kind: "work.review",
        targetId: TASK_ID,
        message: "Sesi review: selesai",
        createdAt: "2026-11-10T09:35:00.000Z",
      },
    ],
  };
  const fetchImpl = fakeFetch(routes({ workspace }));

  await assert.rejects(
    () => finishWork(CONFIG, { taskId: TASK_ID, outcome: "review", summary: "Ready again." }, fetchImpl),
    /sudah pernah dilaporkan untuk review/i,
  );
  const post = fetchImpl.calls.find((call) => call.url.endsWith("/api/work") && call.method === "POST");
  assert.equal(post, undefined, "a second review must never reach the server");
});
