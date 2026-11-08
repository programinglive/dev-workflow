import { test } from "node:test";
import assert from "node:assert/strict";
import { cardKeyFor, buildSnapshot } from "../monitor.js";
import { assignWorkflowIdentity } from "../zettly-workflow.js";
import { normalizeTaskMetadata, renderTaskMetadata } from "../monitor-server/task-metadata.cjs";
import { buildSessionUpsert } from "../monitor-server/session-upsert.cjs";

test("cardKeyFor generates deterministic card keys based on sessionKey and topic", () => {
  const k1 = cardKeyFor("ses_abc123", "Analyze GCP services with gcloud");
  const k2 = cardKeyFor("ses_abc123", "Finish the docker-alma to bw-app migration");
  const k3 = cardKeyFor("ses_abc123", "Analyze GCP services with gcloud");

  assert.equal(k1, "ses_abc123::analyze-gcp-services-with-gcloud");
  assert.equal(k2, "ses_abc123::finish-the-docker-alma-to-bw-app-migration");
  assert.equal(k1, k3, "Same topic generates same card key");
  assert.notEqual(k1, k2, "Different topics generate distinct card keys");

  // Fallbacks
  assert.equal(cardKeyFor("", "topic"), "");
  assert.equal(cardKeyFor("ses_empty", "", "uuid-1234"), "ses_empty::uuid-1234");
  assert.equal(cardKeyFor("ses_only", ""), "ses_only");
});

test("assignWorkflowIdentity captures parentTask when task changes", () => {
  const previous = {
    workflowTaskId: "task-prev-uuid",
    taskDescription: "First topic: GCP audit",
    projectDir: "D:\\code\\clinic",
    zettly: { todoId: 101 },
  };

  const nextState = {
    taskDescription: "Second topic: Docker migration",
    projectDir: "D:\\code\\clinic",
  };

  assignWorkflowIdentity(nextState, previous, {});

  assert.ok(nextState.parentTask);
  assert.equal(nextState.parentTask.id, "task-prev-uuid");
  assert.equal(nextState.parentTask.description, "First topic: GCP audit");
  assert.equal(nextState.parentTask.todoId, 101);
});

test("buildSnapshot includes cardKey, parentCardKey, and session_chain relation", () => {
  const state = {
    workflowTaskId: "task-next-uuid",
    taskDescription: "Second topic: Docker migration",
    projectDir: "D:\\code\\clinic",
    parentTask: {
      id: "task-prev-uuid",
      description: "First topic: GCP audit",
    },
    plan: [],
    definitionOfDone: [],
  };

  const snapshot = buildSnapshot({
    state,
    sessionKey: "ses_chain_1",
    projectPath: "D:\\code\\clinic",
    env: {},
  });

  assert.equal(snapshot.sessionKey, "ses_chain_1");
  assert.equal(snapshot.cardKey, "ses_chain_1::second-topic-docker-migration");
  assert.equal(snapshot.parentCardKey, "ses_chain_1::first-topic-gcp-audit");

  const chainRelation = snapshot.taskRelations.find((r) => r.system === "session_chain");
  assert.ok(chainRelation, "session_chain relation exists in taskRelations");
  assert.equal(chainRelation.relation, "preceded_by");
  assert.equal(chainRelation.label, "First topic: GCP audit");
});

test("buildSessionUpsert uses cardKey when present", () => {
  const upsert = buildSessionUpsert({
    sessionKey: "ses_raw",
    cardKey: "ses_raw::my-new-topic",
    task: "my new topic",
  });

  assert.equal(upsert.params[0], "ses_raw::my-new-topic", "Uses cardKey as primary session_key parameter");
});

test("renderTaskMetadata renders Zettelkasten reference badge for session_chain", () => {
  const html = renderTaskMetadata({
    workflow_task_id: "wf-1",
    task_origin_json: { system: "manual" },
    task_relations_json: [
      {
        system: "session_chain",
        id: "ses_raw::parent-card",
        relation: "preceded_by",
        label: "First topic: GCP audit",
      },
    ],
  });

  assert.ok(html.includes("🔗 Lanjutan dari: First topic: GCP audit"));
  assert.ok(html.includes("session-chain-pill"));
  assert.ok(html.includes("ses_raw::parent-card"));
});

test("stale activeBuild from previous events before task started_at is ignored", () => {
  const oldBuild = {
    target: "old-project",
    status: "testing",
    startedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:05:00.000Z",
  };

  const newTaskStartedAt = "2026-11-07T09:00:00.000Z";

  let activeBuild = oldBuild;
  if (activeBuild && newTaskStartedAt) {
    const buildTime = new Date(activeBuild.updatedAt || activeBuild.startedAt).getTime();
    const taskTime = new Date(newTaskStartedAt).getTime();
    if (buildTime < taskTime) activeBuild = null;
  }

  assert.equal(activeBuild, null, "Old build before newTaskStartedAt must be cleared");
});

