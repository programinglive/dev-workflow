import { test } from "node:test";
import assert from "node:assert";

import {
  readFactoryConfig,
  isConfigured,
  buildTaskFilter,
  mapTaskRecord,
  sortTasks,
  buildClaimPatch,
  buildStatusPatch,
  formatTaskList,
} from "../factory-client.js";

// ---------------------------------------------------------------------------
// Configuration comes from the environment, never from hardcoded values
// ---------------------------------------------------------------------------

test("readFactoryConfig returns null when the URL is missing", () => {
  assert.strictEqual(readFactoryConfig({}), null);
});

test("readFactoryConfig returns null when credentials are missing", () => {
  const env = { FACTORY_PB_URL: "https://pb.example.com" };
  assert.strictEqual(readFactoryConfig(env), null);
});

test("readFactoryConfig trims trailing slashes from the URL", () => {
  const config = readFactoryConfig({
    FACTORY_PB_URL: "https://pb.example.com///",
    FACTORY_PB_IDENTITY: "me@example.com",
    FACTORY_PB_PASSWORD: "secret",
  });

  assert.strictEqual(config.url, "https://pb.example.com");
  assert.strictEqual(config.identity, "me@example.com");
  assert.strictEqual(config.password, "secret");
  assert.strictEqual(config.machineId, null);
});

test("isConfigured reflects whether a usable config exists", () => {
  assert.strictEqual(isConfigured({}), false);
  assert.strictEqual(
    isConfigured({
      FACTORY_PB_URL: "https://pb.example.com",
      FACTORY_PB_IDENTITY: "me@example.com",
      FACTORY_PB_PASSWORD: "secret",
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Filter building
// ---------------------------------------------------------------------------

test("buildTaskFilter defaults to active statuses", () => {
  const filter = buildTaskFilter({});

  assert.match(filter, /status\s*=\s*"open"/);
  assert.match(filter, /status\s*=\s*"in_progress"/);
  assert.match(filter, /status\s*=\s*"blocked"/);
  assert.doesNotMatch(filter, /"done"/);
});

test("buildTaskFilter honours an explicit status list", () => {
  const filter = buildTaskFilter({ statuses: ["done"] });

  assert.match(filter, /"done"/);
  assert.doesNotMatch(filter, /"open"/);
});

test("buildTaskFilter includes a project constraint when given", () => {
  const filter = buildTaskFilter({ project: "dev-workflow-mcp-server" });

  assert.match(filter, /project\s*=\s*"dev-workflow-mcp-server"/);
});

test("buildTaskFilter escapes double quotes in user input", () => {
  const filter = buildTaskFilter({ project: 'evil" || true' });

  assert.doesNotMatch(filter, /evil" \|\| true/);
  assert.match(filter, /\\"/);
});

// ---------------------------------------------------------------------------
// Record mapping
// ---------------------------------------------------------------------------

test("mapTaskRecord keeps the fields the agent needs and drops the rest", () => {
  const mapped = mapTaskRecord({
    id: "rec1",
    task_key: "TASK-1",
    title: "Fix the thing",
    project: "dev-workflow-mcp-server",
    status: "open",
    next_action: "Reproduce it",
    priority: "high",
    category: "Bug Fixing",
    domain: "infra",
    blocked_reason: "",
    decision_needed: true,
    effort_minutes: 30,
    rank_override: 5,
    owner: "user1",
    collectionId: "col",
    collectionName: "activity_tasks",
  });

  assert.deepStrictEqual(mapped, {
    id: "rec1",
    taskKey: "TASK-1",
    title: "Fix the thing",
    project: "dev-workflow-mcp-server",
    status: "open",
    nextAction: "Reproduce it",
    priority: "high",
    category: "Bug Fixing",
    domain: "infra",
    blockedReason: null,
    decisionNeeded: true,
    effortMinutes: 30,
    rankOverride: 5,
  });
});

test("mapTaskRecord tolerates missing optional fields", () => {
  const mapped = mapTaskRecord({ id: "rec2", task_key: "T2", title: "Minimal", project: "p", status: "open" });

  assert.strictEqual(mapped.priority, "normal");
  assert.strictEqual(mapped.decisionNeeded, false);
  assert.strictEqual(mapped.blockedReason, null);
});

// ---------------------------------------------------------------------------
// Ordering: the agent should see the most important task first
// ---------------------------------------------------------------------------

test("sortTasks puts in_progress before open before blocked", () => {
  const sorted = sortTasks([
    { status: "blocked", priority: "high", rankOverride: null },
    { status: "open", priority: "high", rankOverride: null },
    { status: "in_progress", priority: "low", rankOverride: null },
  ]);

  assert.deepStrictEqual(sorted.map((t) => t.status), ["in_progress", "open", "blocked"]);
});

test("sortTasks orders by priority within the same status", () => {
  const sorted = sortTasks([
    { status: "open", priority: "low", rankOverride: null },
    { status: "open", priority: "high", rankOverride: null },
    { status: "open", priority: "normal", rankOverride: null },
  ]);

  assert.deepStrictEqual(sorted.map((t) => t.priority), ["high", "normal", "low"]);
});

test("sortTasks lets rankOverride win over priority", () => {
  const sorted = sortTasks([
    { status: "open", priority: "high", rankOverride: null },
    { status: "open", priority: "low", rankOverride: 1 },
  ]);

  assert.strictEqual(sorted[0].priority, "low");
});

test("sortTasks does not mutate its input", () => {
  const input = [
    { status: "open", priority: "low", rankOverride: null },
    { status: "open", priority: "high", rankOverride: null },
  ];
  sortTasks(input);

  assert.strictEqual(input[0].priority, "low");
});

// ---------------------------------------------------------------------------
// Write payloads
// ---------------------------------------------------------------------------

test("buildClaimPatch marks the task in progress and stamps the session", () => {
  const patch = buildClaimPatch({ sessionId: "ses_1", machineId: "helloworld", now: "2026-10-26T00:00:00.000Z" });

  assert.strictEqual(patch.status, "in_progress");
  assert.strictEqual(patch.started_at, "2026-10-26T00:00:00.000Z");
  assert.strictEqual(patch.session_id, "ses_1");
  assert.strictEqual(patch.machine_id, "helloworld");
});

test("buildClaimPatch omits machine_id when not configured", () => {
  const patch = buildClaimPatch({ sessionId: "ses_1", machineId: null, now: "2026-10-26T00:00:00.000Z" });

  assert.ok(!("machine_id" in patch));
});

test("buildStatusPatch sets completed_at only for done", () => {
  const done = buildStatusPatch({ status: "done", now: "2026-10-26T00:00:00.000Z" });
  assert.strictEqual(done.completed_at, "2026-10-26T00:00:00.000Z");

  const blocked = buildStatusPatch({ status: "blocked", reason: "waiting on review", now: "2026-10-26T00:00:00.000Z" });
  assert.ok(!("completed_at" in blocked));
  assert.strictEqual(blocked.blocked_reason, "waiting on review");
});

test("buildStatusPatch rejects an unknown status", () => {
  assert.throws(() => buildStatusPatch({ status: "shipped" }), /status/i);
});

test("buildStatusPatch requires a reason when blocking", () => {
  assert.throws(() => buildStatusPatch({ status: "blocked" }), /reason/i);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("formatTaskList shows an actionable summary", () => {
  const out = formatTaskList([
    {
      taskKey: "TASK-1",
      title: "Fix the thing",
      status: "open",
      priority: "high",
      project: "repo",
      nextAction: "Reproduce it",
    },
  ]);

  assert.match(out, /TASK-1/);
  assert.match(out, /Fix the thing/);
  assert.match(out, /high/);
  assert.match(out, /Reproduce it/);
});

test("formatTaskList handles an empty queue without pretending there is work", () => {
  const out = formatTaskList([]);

  assert.match(out, /no (open|active|pending)? ?tasks/i);
});
