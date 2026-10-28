import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readFactoryConfig,
  isConfigured,
  deviceIdFor,
  deviceFromConfig,
  mapTaskRecord,
  sortTasks,
  planStatusTransition,
  buildWorkStartPayload,
  buildWorkFinishPayload,
  buildSummary,
  formatTaskList,
  listTasks,
  claimTask,
  heartbeatWork,
  updateTaskStatus,
  clearTokenCache,
  ACTIVE_STATUSES,
  VALID_STATUSES,
} from "../factory-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE = {
  projects: [
    { id: "p1", name: "programinglive/dev-workflow-mcp-server" },
    { id: "p2", name: "mahatmamahardhikach/factory" },
  ],
  tasks: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "p1",
      title: "Sambungkan MCP ke Factory",
      description: "desc",
      acceptance: "npm test hijau",
      priority: "high",
      status: "backlog",
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
      work: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      projectId: "p2",
      title: "Tulis runbook",
      description: "",
      acceptance: "runbook ada",
      priority: "normal",
      status: "queued",
      createdAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      work: null,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      projectId: "p1",
      title: "Sedang dikerjakan",
      description: "",
      acceptance: "selesai",
      priority: "high",
      status: "running",
      createdAt: "2026-10-24T00:00:00.000Z",
      updatedAt: "2026-10-24T00:00:00.000Z",
      work: {
        id: "sess-1",
        state: "active",
        activityStatus: "active",
        step: "Menulis klien",
        summary: "",
        device: { id: "d1", name: "HELLOWORLD" },
        startedAt: "2026-10-26T01:00:00.000Z",
      },
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      projectId: "p2",
      title: "Sudah selesai",
      description: "",
      acceptance: "done",
      priority: "low",
      status: "done",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      work: null,
    },
  ],
  events: [],
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Records calls and answers with a queued list of responses. */
function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const entry = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} };
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

const CONFIG = { url: "https://factory.test", token: "tok-1", pocketBaseUrl: "https://pb.test", machineId: "box", agent: "agent" };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("readFactoryConfig returns null without a URL", () => {
  assert.strictEqual(readFactoryConfig({ FACTORY_TOKEN: "t" }), null);
});

test("readFactoryConfig returns null without any credential", () => {
  assert.strictEqual(readFactoryConfig({ FACTORY_URL: "https://factory.test" }), null);
});

test("readFactoryConfig accepts a token alone", () => {
  const config = readFactoryConfig({ FACTORY_URL: "https://factory.test/", FACTORY_TOKEN: "tok" });
  assert.strictEqual(config.url, "https://factory.test");
  assert.strictEqual(config.token, "tok");
  assert.strictEqual(config.pocketBaseUrl, "https://pocketbase.programinglive.com");
});

test("readFactoryConfig accepts email and password", () => {
  const config = readFactoryConfig({
    FACTORY_URL: "https://factory.test",
    FACTORY_EMAIL: "me@example.com",
    FACTORY_PASSWORD: "secret",
    FACTORY_MACHINE_ID: "helloworld",
  });
  assert.strictEqual(config.email, "me@example.com");
  assert.strictEqual(config.machineId, "helloworld");
  assert.strictEqual(config.token, null);
});

test("isConfigured reflects whether a usable config exists", () => {
  assert.strictEqual(isConfigured({}), false);
  assert.strictEqual(isConfigured({ FACTORY_URL: "https://f.test", FACTORY_TOKEN: "t" }), true);
});

// ---------------------------------------------------------------------------
// Device identity: stable per machine, valid UUID, no state file
// ---------------------------------------------------------------------------

test("deviceIdFor is deterministic and a valid UUID", () => {
  const first = deviceIdFor("HELLOWORLD");
  const second = deviceIdFor("HELLOWORLD");
  assert.strictEqual(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("deviceIdFor gives different machines different ids", () => {
  assert.notStrictEqual(deviceIdFor("machine-a"), deviceIdFor("machine-b"));
});

test("deviceFromConfig honours an explicit device id", () => {
  const device = deviceFromConfig({ ...CONFIG, deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  assert.strictEqual(device.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.strictEqual(device.name, "box");
});

test("deviceFromConfig trims fields to the API limits", () => {
  const device = deviceFromConfig({ ...CONFIG, machineId: "x".repeat(200), agent: "y".repeat(80) });
  assert.ok(device.name.length <= 100);
  assert.ok(device.agent.length <= 40);
});

test("deviceFromConfig shares one identity with the Factory CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-device-"));
  try {
    const file = join(directory, "device.json");
    writeFileSync(file, JSON.stringify({ id: "c4d59aeb-a044-41ff-b3f6-9800bf463933" }));

    // Dua tool di satu mesin harus memakai satu identitas perangkat.
    const first = deviceFromConfig({ ...CONFIG, deviceFile: file });
    const second = deviceFromConfig({ ...CONFIG, deviceFile: file });
    assert.strictEqual(first.id, "c4d59aeb-a044-41ff-b3f6-9800bf463933");
    assert.strictEqual(second.id, first.id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deviceFromConfig creates the shared device file when it is missing", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-device-"));
  try {
    const file = join(directory, "nested", "device.json");
    const device = deviceFromConfig({ ...CONFIG, deviceFile: file });

    assert.match(device.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.strictEqual(JSON.parse(readFileSync(file, "utf8")).id, device.id, "berkas harus menyimpan id yang dipakai");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicit FACTORY_DEVICE_ID still wins over the shared file", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-device-"));
  try {
    const file = join(directory, "device.json");
    writeFileSync(file, JSON.stringify({ id: "c4d59aeb-a044-41ff-b3f6-9800bf463933" }));

    const device = deviceFromConfig({ ...CONFIG, deviceFile: file, deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    assert.strictEqual(device.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readFactoryConfig captures FACTORY_DEVICE_FILE so the shared identity is used", () => {
  const config = readFactoryConfig({
    FACTORY_URL: "https://factory.test",
    FACTORY_TOKEN: "tok",
    FACTORY_DEVICE_FILE: "/tmp/device.json",
  });
  assert.strictEqual(config.deviceFile, "/tmp/device.json");
});

// ---------------------------------------------------------------------------
// Status rules: Factory has no generic status write
// ---------------------------------------------------------------------------

test("review, blocked and paused finish the work session", () => {
  assert.deepStrictEqual(planStatusTransition("review"), { kind: "work-finish", outcome: "review" });
  assert.deepStrictEqual(planStatusTransition("blocked"), { kind: "work-finish", outcome: "blocked" });
  assert.deepStrictEqual(planStatusTransition("paused"), { kind: "work-finish", outcome: "paused" });
});

test("backlog, queued and cancelled use move_task", () => {
  for (const status of ["backlog", "queued", "cancelled"]) {
    assert.deepStrictEqual(planStatusTransition(status), { kind: "move", status });
  }
});

test("running is rejected with a pointer to claim_factory_task", () => {
  assert.throws(() => planStatusTransition("running"), /claim_factory_task/);
});

test("done moves the task, but only from review (server enforces it)", () => {
  const plan = planStatusTransition("done");
  assert.equal(plan.kind, "move");
  assert.equal(plan.status, "done");
});

test("unknown status lists what Factory accepts", () => {
  assert.throws(() => planStatusTransition("shipped"), /Unknown status.*backlog/);
});

test("every Factory status is covered by the rules", () => {
  for (const status of VALID_STATUSES) {
    if (status === "running") {
      assert.throws(() => planStatusTransition(status));
    } else {
      assert.ok(planStatusTransition(status).kind);
    }
  }
});

// ---------------------------------------------------------------------------
// Work payloads
// ---------------------------------------------------------------------------

test("buildWorkStartPayload shapes the start action", () => {
  const payload = buildWorkStartPayload({
    taskId: "t1",
    device: { id: "d1", name: "box", platform: "win32", agent: "agent" },
    step: "Menulis klien",
  });
  assert.strictEqual(payload.action, "start");
  assert.strictEqual(payload.taskId, "t1");
  assert.strictEqual(payload.step, "Menulis klien");
});

test("buildWorkStartPayload requires a task and a device", () => {
  assert.throws(() => buildWorkStartPayload({ device: { id: "d1" } }), /taskId/);
  assert.throws(() => buildWorkStartPayload({ taskId: "t1", device: {} }), /device/);
});

test("buildWorkStartPayload truncates a long step", () => {
  const payload = buildWorkStartPayload({ taskId: "t1", device: { id: "d1" }, step: "x".repeat(400) });
  assert.strictEqual(payload.step.length, 240);
});

test("buildWorkStartPayload includes the editor session when known", () => {
  const payload = buildWorkStartPayload({
    taskId: "t1",
    device: { id: "d1" },
    step: "Kerjakan",
    clientSession: { id: "ses_abc", title: "MySQL root + Portal Temuan" },
  });
  assert.deepStrictEqual(payload.clientSession, { id: "ses_abc", title: "MySQL root + Portal Temuan" });
});

test("buildWorkStartPayload omits the session when it is unknown", () => {
  const payload = buildWorkStartPayload({ taskId: "t1", device: { id: "d1" }, step: "Kerjakan" });
  assert.strictEqual("clientSession" in payload, false);
});

test("buildWorkStartPayload trims session fields to the API limits", () => {
  const payload = buildWorkStartPayload({
    taskId: "t1",
    device: { id: "d1" },
    step: "Kerjakan",
    clientSession: { id: "x".repeat(300), title: "y".repeat(400) },
  });
  assert.strictEqual(payload.clientSession.id.length, 120);
  assert.strictEqual(payload.clientSession.title.length, 200);
});

test("clientSessionFromConfig reads the environment names and tolerates absence", async () => {
  const { clientSessionFromConfig } = await import("../factory-client.js");
  assert.strictEqual(clientSessionFromConfig({}), null);
  assert.strictEqual(clientSessionFromConfig({ clientSessionId: "   " }), null);
  assert.deepStrictEqual(
    clientSessionFromConfig({ clientSessionId: "ses_1", clientSessionTitle: "Judul" }),
    { id: "ses_1", title: "Judul" },
  );
  assert.deepStrictEqual(clientSessionFromConfig({ clientSessionId: "ses_1" }), { id: "ses_1", title: "" });
});

test("readFactoryConfig picks the editor session from OPENCODE_* variables", () => {
  const config = readFactoryConfig({
    FACTORY_URL: "https://factory.example",
    FACTORY_TOKEN: "t",
    OPENCODE_SESSION_ID: "ses_env",
    OPENCODE_SESSION_TITLE: "Sesi dari env",
  });
  assert.strictEqual(config.clientSessionId, "ses_env");
  assert.strictEqual(config.clientSessionTitle, "Sesi dari env");
});

test("buildWorkFinishPayload shapes the finish action", () => {
  const payload = buildWorkFinishPayload({ sessionId: "s1", deviceId: "d1", outcome: "review", summary: "Selesai, minta review." });
  assert.deepStrictEqual(payload, {
    action: "finish",
    sessionId: "s1",
    deviceId: "d1",
    outcome: "review",
    summary: "Selesai, minta review.",
  });
});

test("buildWorkFinishPayload rejects an unknown outcome", () => {
  assert.throws(() => buildWorkFinishPayload({ sessionId: "s1", deviceId: "d1", outcome: "done", summary: "abc" }), /outcome/i);
});

test("buildWorkFinishPayload requires a real summary", () => {
  assert.throws(() => buildWorkFinishPayload({ sessionId: "s1", deviceId: "d1", outcome: "review", summary: "a" }), /summary/i);
});

test("buildWorkFinishPayload truncates to Factory's 2000 char limit", () => {
  const payload = buildWorkFinishPayload({ sessionId: "s1", deviceId: "d1", outcome: "review", summary: "x".repeat(3000) });
  assert.strictEqual(payload.summary.length, 2000);
});

test("buildSummary prefers a reason over a generic message", () => {
  assert.strictEqual(buildSummary({ reason: "Butuh akses DB" }), "Butuh akses DB");
  assert.match(buildSummary({ status: "review" }), /review/);
});

// ---------------------------------------------------------------------------
// Mapping and ordering
// ---------------------------------------------------------------------------

test("mapTaskRecord resolves the project name and keeps the work session", () => {
  const mapped = mapTaskRecord(WORKSPACE.tasks[2], WORKSPACE.projects);

  assert.strictEqual(mapped.projectName, "programinglive/dev-workflow-mcp-server");
  assert.strictEqual(mapped.taskKey, "33333333");
  assert.strictEqual(mapped.work.state, "active");
  assert.strictEqual(mapped.work.deviceName, "HELLOWORLD");
  assert.strictEqual(mapped.work.step, "Menulis klien");
});

test("mapTaskRecord tolerates a task without work or project", () => {
  const mapped = mapTaskRecord({ id: "x", title: "Minimal", status: "backlog" });
  assert.strictEqual(mapped.priority, "normal");
  assert.strictEqual(mapped.work, null);
  assert.strictEqual(mapped.projectName, null);
});

test("sortTasks puts running before queued before backlog", () => {
  const sorted = sortTasks([
    { status: "backlog", priority: "high" },
    { status: "queued", priority: "low" },
    { status: "running", priority: "low" },
  ]);
  assert.deepStrictEqual(sorted.map((t) => t.status), ["running", "queued", "backlog"]);
});

test("sortTasks orders by priority within a status", () => {
  const sorted = sortTasks([
    { status: "backlog", priority: "low" },
    { status: "backlog", priority: "high" },
    { status: "backlog", priority: "normal" },
  ]);
  assert.deepStrictEqual(sorted.map((t) => t.priority), ["high", "normal", "low"]);
});

test("sortTasks does not mutate its input", () => {
  const input = [{ status: "backlog", priority: "low" }, { status: "backlog", priority: "high" }];
  sortTasks(input);
  assert.strictEqual(input[0].priority, "low");
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("formatTaskList shows key, title, status, project and active session", () => {
  const out = formatTaskList([mapTaskRecord(WORKSPACE.tasks[2], WORKSPACE.projects)]);

  assert.match(out, /33333333/);
  assert.match(out, /Sedang dikerjakan/);
  assert.match(out, /running/);
  assert.match(out, /dev-workflow-mcp-server/);
  assert.match(out, /active session on HELLOWORLD: Menulis klien/);
});

test("formatTaskList does not pretend there is work", () => {
  assert.match(formatTaskList([]), /no tasks/i);
});

// ---------------------------------------------------------------------------
// HTTP behaviour
// ---------------------------------------------------------------------------

test("listTasks hides done and cancelled by default", async () => {
  const fetchImpl = fakeFetch([(call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : null)]);
  const tasks = await listTasks(CONFIG, {}, fetchImpl);

  assert.deepStrictEqual(tasks.map((t) => t.status).sort(), ["backlog", "queued", "running"]);
  assert.strictEqual(ACTIVE_STATUSES.includes("done"), false);
});

test("listTasks sends the token as a Bearer header", async () => {
  const fetchImpl = fakeFetch([(call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : null)]);
  await listTasks(CONFIG, {}, fetchImpl);

  assert.strictEqual(fetchImpl.calls[0].headers.Authorization, "Bearer tok-1");
});

test("listTasks filters by project name and limit", async () => {
  const fetchImpl = fakeFetch([(call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : null)]);
  const filtered = await listTasks(CONFIG, { project: "factory", limit: 1 }, fetchImpl);

  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].projectName, "mahatmamahardhikach/factory");
});

test("listTasks logs in once when only email and password are given", async () => {
  clearTokenCache();
  const fetchImpl = fakeFetch([
    (call) => (call.url.includes("auth-with-password") ? json({ token: "fresh" }) : null),
    (call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : null),
  ]);
  const config = { ...CONFIG, token: null, email: "me@example.com", password: "secret" };

  await listTasks(config, {}, fetchImpl);
  await listTasks(config, {}, fetchImpl);

  const logins = fetchImpl.calls.filter((call) => call.url.includes("auth-with-password"));
  assert.strictEqual(logins.length, 1);
  clearTokenCache();
});

test("listTasks surfaces a login failure with a useful message", async () => {
  clearTokenCache();
  const fetchImpl = fakeFetch([(call) => (call.url.includes("auth-with-password") ? json({ message: "bad" }, 401) : null)]);
  const config = { ...CONFIG, token: null, email: "me@example.com", password: "wrong" };

  await assert.rejects(() => listTasks(config, {}, fetchImpl), /FACTORY_EMAIL/);
  clearTokenCache();
});

test("heartbeatWork reports the current step and session", async () => {
  const fetchImpl = fakeFetch([
    (call) => (call.url.endsWith("/api/work") && call.method === "POST" ? json({ session: { id: "sess-9", state: "active" } }) : null),
  ]);

  await heartbeatWork(CONFIG, {
    sessionId: "sess-9",
    deviceId: "d1",
    step: "Menulis tes",
  }, fetchImpl);

  const beat = fetchImpl.calls[0].body;
  assert.strictEqual(beat.action, "heartbeat");
  assert.strictEqual(beat.sessionId, "sess-9");
  assert.strictEqual(beat.deviceId, "d1");
  assert.strictEqual(beat.step, "Menulis tes");
});

test("heartbeatWork omits an empty step instead of sending an invalid one", async () => {
  const fetchImpl = fakeFetch([
    (call) => (call.url.endsWith("/api/work") ? json({ session: { id: "sess-9", state: "active" } }) : null),
  ]);

  await heartbeatWork(CONFIG, { sessionId: "sess-9", deviceId: "d1", step: "   " }, fetchImpl);

  assert.strictEqual("step" in fetchImpl.calls[0].body, false, "langkah kosong tidak boleh dikirim");
});

test("heartbeatWork refuses without a session or device", async () => {
  await assert.rejects(() => heartbeatWork(CONFIG, { deviceId: "d1" }, fakeFetch([])), /sessionId/);
  await assert.rejects(() => heartbeatWork(CONFIG, { sessionId: "s1" }, fakeFetch([])), /deviceId/);
});

test("claimTask starts a work session", async () => {
  const fetchImpl = fakeFetch([
    (call) => (call.url.endsWith("/api/work") && call.method === "POST" ? json({ session: { id: "sess-9", state: "active" } }) : null),
  ]);

  const session = await claimTask(CONFIG, {
    recordId: "11111111-1111-4111-8111-111111111111",
    device: { id: "d1", name: "box", platform: "win32", agent: "agent" },
    step: "Mulai",
  }, fetchImpl);

  assert.strictEqual(session.id, "sess-9");
  assert.strictEqual(fetchImpl.calls[0].body.action, "start");
  assert.strictEqual(fetchImpl.calls[0].body.taskId, "11111111-1111-4111-8111-111111111111");
});

test("buildWorkStartPayload includes takeoverReason only when it is a usable reason", () => {
  const device = { id: "d1", name: "box", platform: "win32", agent: "agent" };
  const taskId = "11111111-1111-4111-8111-111111111111";

  assert.strictEqual(buildWorkStartPayload({ taskId, device }).takeoverReason, undefined);
  assert.strictEqual(buildWorkStartPayload({ taskId, device, takeoverReason: "   " }).takeoverReason, undefined);
  assert.strictEqual(buildWorkStartPayload({ taskId, device, takeoverReason: "saya lanjutkan" }).takeoverReason, "saya lanjutkan");
});

test("claimTask sends the takeover reason to Factory", async () => {
  const fetchImpl = fakeFetch([
    (call) => (call.url.endsWith("/api/work") && call.method === "POST" ? json({ session: { id: "sess-9", state: "active" }, tookOver: true }) : null),
  ]);

  await claimTask(CONFIG, {
    recordId: "11111111-1111-4111-8111-111111111111",
    device: { id: "d1", name: "box", platform: "win32", agent: "agent" },
    step: "Lanjut",
    takeoverReason: "Pemilik lama offline 3 hari, saya lanjutkan.",
  }, fetchImpl);

  assert.strictEqual(fetchImpl.calls[0].body.takeoverReason, "Pemilik lama offline 3 hari, saya lanjutkan.");
});

test("a refused request exposes the parsed body and status", async () => {
  const fetchImpl = fakeFetch([
    (call) => (call.url.endsWith("/api/work") ? json({ error: "butuh alasan", takeoverRequired: true, holder: { deviceName: "MMCH", agent: "Codex", lastSeenAt: "2026-10-28T00:00:00.000Z" } }, 409) : null),
  ]);

  await assert.rejects(
    () => claimTask(CONFIG, { recordId: "11111111-1111-4111-8111-111111111111", device: { id: "d1" } }, fetchImpl),
    (error) => {
      assert.strictEqual(error.status, 409);
      assert.strictEqual(error.body.takeoverRequired, true);
      assert.strictEqual(error.body.holder.deviceName, "MMCH");
      return true;
    },
  );
});

test("updateTaskStatus moves a task with move_task", async () => {
  const fetchImpl = fakeFetch([
    (call) => (call.url.endsWith("/api/factory") ? json({ ok: true, runId: null }) : null),
  ]);

  const result = await updateTaskStatus(CONFIG, { recordId: "t1", status: "cancelled" }, fetchImpl);

  assert.deepStrictEqual(result, { id: "t1", status: "cancelled" });
  assert.strictEqual(fetchImpl.calls[0].body.action, "move_task");
  assert.strictEqual(fetchImpl.calls[0].body.status, "cancelled");
});

test("updateTaskStatus finishes the active session for review", async () => {
  const fetchImpl = fakeFetch([
    (call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : null),
    (call) => (call.url.endsWith("/api/work") && call.method === "POST" ? json({ session: { id: "sess-1", state: "review", summary: "Selesai" } }) : null),
  ]);
  const config = { ...CONFIG, deviceId: "d1" };

  const result = await updateTaskStatus(config, {
    recordId: "33333333-3333-4333-8333-333333333333",
    status: "review",
    reason: "Selesai, minta review.",
  }, fetchImpl);

  assert.strictEqual(result.status, "review");
  const finish = fetchImpl.calls.find((call) => call.url.endsWith("/api/work"));
  assert.strictEqual(finish.body.action, "finish");
  assert.strictEqual(finish.body.sessionId, "sess-1");
  assert.strictEqual(finish.body.outcome, "review");
});

test("updateTaskStatus refuses review without an active session", async () => {
  const fetchImpl = fakeFetch([(call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : null)]);

  await assert.rejects(
    () => updateTaskStatus(CONFIG, { recordId: "11111111-1111-4111-8111-111111111111", status: "review" }, fetchImpl),
    /no active work session/i,
  );
});

test("updateTaskStatus refuses running before hitting the network", async () => {
  const fetchImpl = fakeFetch([]);
  await assert.rejects(() => updateTaskStatus(CONFIG, { recordId: "t1", status: "running" }, fetchImpl), /claim_factory_task/);
  assert.strictEqual(fetchImpl.calls.length, 0);
});
