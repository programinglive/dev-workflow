import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { visibleMachines } = require("../monitor-server/machines-query.cjs");

test("a retired synthetic report does not count as a connected machine", () => {
  const rows = [
    { machine: "HELLOWORLD", last_seen: "2026-11-09T17:00:00.000Z" },
    { machine: "uji", last_seen: "2026-11-03T10:10:45.095Z" },
  ];
  assert.deepEqual(visibleMachines(rows).map((row) => row.machine), ["HELLOWORLD"]);
});

test("a later report from the same machine name remains visible", () => {
  const rows = [{ machine: "uji", last_seen: "2026-11-10T00:00:00.000Z" }];
  assert.deepEqual(visibleMachines(rows), rows);
});

test("opening another session resets the close button and binds its key", () => {
  const source = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");
  const openDetail = source.slice(source.indexOf("function bukaDetail("), source.indexOf("function tutupModal("));
  assert.match(openDetail, /closeBtn\.disabled\s*=\s*false/);
  assert.match(openDetail, /closeBtn\.textContent\s*=\s*'✕ Tutup Sesi'/);
  assert.match(openDetail, /closeBtn\.dataset\.sessionKey\s*=\s*s\.session_key/);
});

test("the API uses the same visible machines for counts and silence alerts", () => {
  const source = readFileSync(path.join(ROOT, "monitor-server", "dashboard.cjs"), "utf8");
  assert.match(source, /const machines = visibleMachines\(machineRows\.rows\)/);
  assert.match(source, /buildAlerts\(\{[\s\S]*?machines,[\s\S]*?\}\)/);
  assert.match(source, /JSON\.stringify\(\{ now: serverNow,[^\n]*machines, history, alerts/);
});
