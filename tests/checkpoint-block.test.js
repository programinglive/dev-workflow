import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCheckpointElement, parseCheckpointElement } from "../tools/handler-modules/checkpoint-block.js";

test("a rendered checkpoint element round-trips", () => {
  const payload = {
    machine: "Mac",
    checkpointedAt: "2026-11-09T10:00:00.000Z",
    summary: "closed the runner work",
    baseSha: "a".repeat(40),
    commits: ["b".repeat(40)],
    handover: null,
  };
  const html = renderCheckpointElement("wf-1", payload);
  assert.deepEqual(parseCheckpointElement(`<p>before</p>${html}<p>after</p>`), payload);
});

test("a description without the element yields null", () => {
  assert.equal(parseCheckpointElement("<p>plain</p>"), null);
});
