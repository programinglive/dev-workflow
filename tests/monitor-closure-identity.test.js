import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A finished task must close the row it worked on, not create a second one.
 *
 * WHAT WAS MEASURED (9 November 2026)
 * ----------------------------------
 * Three sessions kept showing as `CODING / mungkin macet` while the board
 * reported all three tasks `done`. The monitor table explained it:
 *
 *     sessions PRIMARY KEY (session_key, task_id)
 *
 * `complete_task` calls `reset()`, which empties `workflowTaskId`, and only
 * then reports. The closing snapshot therefore carried `taskId: ""` and
 * upserted a NEW row instead of closing the row that held the work. The work
 * row stayed at `coding` forever and aged into "possibly stuck".
 *
 * These tests pin the contract in the reporter so it cannot regress. They read
 * the source because the behaviour lives inside a module-level closure whose
 * only other entry point performs a network call.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(path.join(ROOT, "workflow-state.js"), "utf8");

function block(startMarker, length = 6000) {
  const at = SOURCE.indexOf(startMarker);
  assert.ok(at >= 0, `missing marker: ${startMarker}`);
  return SOURCE.slice(at, at + length);
}

test("the reporter remembers the task id after the state is reset", () => {
  assert.match(
    SOURCE,
    /let lastReportedTaskId/,
    "the reporter needs a memory that survives reset(), declared at module level",
  );

  const fn = block("export async function reportToMonitorSafe");

  assert.match(
    fn,
    /liveTaskId/,
    "it must read the live task id before falling back",
  );
  assert.match(
    fn,
    /lastReportedTaskId\s*=\s*liveTaskId/,
    "a live task id must be remembered for the closure that follows",
  );
  assert.match(
    fn,
    /workflowTaskId:\s*lastReportedTaskId/,
    "the closure report must reuse the remembered id",
  );
});

test("the closure still reports a terminal phase", () => {
  const fn = block("export async function reportToMonitorSafe");
  // The existing closure rule: phase "idle" is the proof of closure, and that
  // report is always awaited so a short-lived CLI cannot kill it.
  assert.match(fn, /const isClosure = String\(\(state && state\.currentPhase\) \|\| ""\) === "idle"/);
  assert.match(fn, /mod\.reportSnapshot\(\{ snapshot \}\)/);
});

test("the snapshot builder exposes the task id the table keys on", () => {
  const monitor = readFileSync(path.join(ROOT, "monitor.js"), "utf8");
  assert.match(monitor, /const taskId = String\(s\.workflowTaskId \|\| ""\)/);
  // Both keys must be own properties of the snapshot payload. The order is not
  // part of the contract: activeClaim was added between them on 27 Nov 2026.
  assert.match(
    monitor,
    /return \{[\s\S]*?\n\s*taskId,[\s\S]*?\n\s*parentTask,/,
    "buildSnapshot must expose both taskId and parentTask in the returned payload",
  );
});

test("the upsert keys callers must satisfy: (session_key, task_id)", () => {
  const upsert = readFileSync(path.join(ROOT, "monitor-server", "session-upsert.cjs"), "utf8");
  assert.match(
    upsert,
    /ON CONFLICT \(session_key, task_id\)/,
    "if this key changes, the reporter contract above must change with it",
  );
});
