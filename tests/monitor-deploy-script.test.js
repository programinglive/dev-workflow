import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { visibleMachines } = require("../monitor-server/machines-query.cjs");

test("the retired machine filter tolerates the driver's Date objects", () => {
  // node-postgres returns timestamptz as Date. The production row is a Date, so
  // a string-only comparison silently keeps the retired machine visible.
  const rows = [
    { machine: "uji", last_seen: new Date("2026-11-03T10:10:45.095Z") },
    { machine: "MMCH", last_seen: new Date("2026-11-09T17:54:33.120Z") },
  ];
  assert.deepEqual(visibleMachines(rows).map((row) => row.machine), ["MMCH"]);
});

test("the same timestamp in any driver representation is filtered", () => {
  const expected = "2026-11-03T10:10:45.095Z";
  const rows = [
    { machine: "uji", last_seen: new Date(expected) },
    { machine: "uji", last_seen: expected },
    { machine: "uji", last_seen: Date.parse(expected) },
    { machine: "uji", last_seen: "2026-11-03T10:10:45.095+00:00" },
  ];
  assert.deepEqual(visibleMachines(rows), []);
});
