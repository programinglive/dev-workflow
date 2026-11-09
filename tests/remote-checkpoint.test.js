import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMachineAlias,
  buildRemoteCheckpointCommand,
  handleFetchTask,
} from "../tools/handler-modules/remote-checkpoint.js";

test("an unknown machine name resolves to null instead of the local machine", () => {
  assert.equal(resolveMachineAlias("Nope", { mac: "mac", mmch: "mmch" }), null);
});

test("a name differing only in case resolves to its alias", () => {
  assert.equal(resolveMachineAlias("Mac", { mac: "mac" }), "mac");
  assert.equal(resolveMachineAlias("MMCH", { mmch: "mmch" }), "mmch");
});

test("the SSH command carries the explicit session key", () => {
  const { command, args } = buildRemoteCheckpointCommand({
    alias: "mac",
    sessionKey: "ses_abc",
    nodePath: "/usr/bin/node",
    scriptPath: "/opt/dev-workflow/index.js",
  });
  assert.equal(command, "ssh");
  assert.ok(args.includes("ses_abc"));
  assert.ok(args.includes("checkpoint_task"));
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("/usr/bin/node"));
});

function contextWithTask() {
  return {
    workflowState: {
      state: {
        taskDescription: "the task",
        machine: "MMCH",
        projectDir: "",
        workflowTaskId: "wf-5",
        zettly: { todoId: 447 },
        checkpoint: { checkpointedAt: null, summary: "", baseSha: null, commits: [], handover: null },
      },
      sessionId: "ses_local",
      save: async () => ({ verified: true }),
    },
    machineAliases: { mac: "mac", mmch: "mmch" },
  };
}

test("a fetch without a 'from' argument checkpoints locally", async () => {
  let localCalled = false;
  const context = {
    ...contextWithTask(),
    client: {
      async request(method, route, body) {
        return { success: true, data: { id: 447, description: "" } };
      },
    },
    runRemoteCheckpoint: async () => {
      throw new Error("remote path must not be taken");
    },
  };
  const result = await handleFetchTask({ reason: "stay local" }, context);
  assert.equal(result.ok, true);
  assert.equal(result.local, true);
});

test("a fetch from an unknown machine is refused, naming the available machines", async () => {
  const result = await handleFetchTask({ from: "Nope", reason: "why" }, contextWithTask());
  assert.equal(result.ok, false);
  assert.match(result.note, /Nope/);
  assert.match(result.note, /mac/);
  assert.match(result.note, /mmch/);
});

test("a remote fetch requires a reason", async () => {
  const result = await handleFetchTask({ from: "Mac" }, contextWithTask());
  assert.equal(result.ok, false);
  assert.match(result.note, /reason/i);
});

test("a failed remote call falls back to the Zettly checkpoint without panicking", async () => {
  const stored = JSON.stringify({
    machine: "Mac",
    checkpointedAt: "2026-11-09T09:00:00.000Z",
    summary: "remote half done",
    baseSha: "a".repeat(40),
    commits: [],
    handover: null,
  });
  const context = {
    ...contextWithTask(),
    client: {
      async request(method, route) {
        if (route === "/todos/447") {
          return {
            success: true,
            data: {
              id: 447,
              description: `<script type="application/json" data-dev-workflow-state="wf-5">${stored}</script>`,
            },
          };
        }
        return { success: true, data: { id: 447, description: "" } };
      },
    },
    runRemoteCheckpoint: async () => {
      throw new Error("ssh timeout");
    },
  };
  const result = await handleFetchTask({ from: "Mac", reason: "ssh is down" }, context);
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, false);
  assert.match(result.note, /not confirmed|readable/i);
});
