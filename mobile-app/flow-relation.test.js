import test from "node:test";
import assert from "node:assert/strict";

import { relasiFlow, punyaTask, urlThumbnail } from "./flow-relation.js";

/**
 * The tablet showed no flow at all because the app never read the drawing
 * relation. These tests pin the lookup, the "task without a flow" signal, and
 * the raster URL the tablet can actually draw.
 */

test("relasiFlow finds the zettly_draw relation", () => {
  const session = {
    task_relations_json: [
      { system: "zettly", id: "504" },
      { system: "zettly_draw", id: "159", url: "https://zettly.programinglive.com/draw/159" },
    ],
  };
  const flow = relasiFlow(session);
  assert.equal(flow.id, "159");
  assert.equal(flow.url, "https://zettly.programinglive.com/draw/159");
});

test("relasiFlow ignores a drawing relation without an id", () => {
  const session = { task_relations_json: [{ system: "zettly_draw", id: "" }] };
  assert.equal(relasiFlow(session), null);
});

test("relasiFlow tolerates a session without relations", () => {
  assert.equal(relasiFlow({}), null);
  assert.equal(relasiFlow(null), null);
  assert.equal(relasiFlow({ task_relations_json: "not-an-array" }), null);
});

test("punyaTask is true only when a task or session title exists", () => {
  assert.equal(punyaTask({ task: "Fix the voucher picker" }), true);
  assert.equal(punyaTask({ session_title: "Track English implementation" }), true);
  assert.equal(punyaTask({ task: "   " }), false);
  assert.equal(punyaTask({}), false);
  assert.equal(punyaTask(null), false);
});

test("urlThumbnail points at the PNG copy, not the SVG", () => {
  assert.equal(
    urlThumbnail("http://100.77.138.14:3100", 159),
    "http://100.77.138.14:3100/api/drawings/159/thumbnail.png",
  );
  assert.equal(
    urlThumbnail("http://100.77.138.14:3100/", 159),
    "http://100.77.138.14:3100/api/drawings/159/thumbnail.png",
  );
});
