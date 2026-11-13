import test from "node:test";
import assert from "node:assert/strict";
import {
  COCKPIT_MODES,
  MIN_TOUCH_TARGET_DP,
  MIN_DESTRUCTIVE_GAP_DP,
  computeCockpitKpis,
  selectFocusDiagrams,
  selectGovernanceItems,
  nextZoomScale,
} from "./cockpit-mode.js";

test("mobile-app cockpit-mode domain logic (Xiaomi Pad 6 M4)", async (t) => {
  await t.test("defines the 3 canonical Xiaomi Pad 6 cockpit modes and ergonomic constants", () => {
    assert.equal(MIN_TOUCH_TARGET_DP, 48);
    assert.equal(MIN_DESTRUCTIVE_GAP_DP, 24);
    const ids = COCKPIT_MODES.map((m) => m.id);
    assert.deepEqual(ids, ["cockpit", "focus", "governance"]);
  });

  await t.test("computeCockpitKpis calculates accurate real-time tablet strip metrics", () => {
    const sessions = [
      { session_key: "s1", state: "live", phase: "coding" },
      { session_key: "s2", state: "possibly_stuck", phase: "testing" },
      { session_key: "s3", state: "live", phase: "ready" },
    ];
    const builds = [
      { session_key: "s1", active_build: { status: "building", target: "apk" } },
      { session_key: "s2", active_build: { status: "succeeded", target: "web" } },
    ];
    const alerts = [{ kind: "sesi_macet", session_key: "s2", pesan: "Macet 20m" }];
    const machines = [
      { machine: "WORKSTATION-1", stale: false },
      { machine: "WORKSTATION-2", stale: true },
    ];

    const kpis = computeCockpitKpis({ sessions, builds, alerts, machines });
    assert.equal(kpis.activeSessions, 3);
    assert.equal(kpis.liveSessions, 2);
    assert.equal(kpis.runningBuilds, 1);
    assert.equal(kpis.governanceAttention, 2); // s2 stuck + s3 ready gate
    assert.equal(kpis.onlineMachines, 1);
  });

  await t.test("selectFocusDiagrams extracts sessions with Zettly Draw flow relations", () => {
    const sessions = [
      {
        session_key: "s1",
        task: "Implement SSE",
        project_name: "dev-workflow",
        started_at: "2026-11-12T10:00:00Z",
        task_relations_json: [{ system: "zettly_draw", id: "288", title: "SSE Flow" }],
      },
      {
        session_key: "s2",
        task: "No flow session",
        task_relations_json: [],
      },
    ];

    const items = selectFocusDiagrams(sessions, "http://127.0.0.1:3100");
    assert.equal(items.length, 1);
    assert.equal(items[0].sessionKey, "s1");
    assert.equal(items[0].drawId, "288");
    assert.match(items[0].thumbnailUrl, /\/api\/drawings\/288\/thumbnail\.png/);
  });

  await t.test("selectGovernanceItems prioritizes stuck, ready, and failed-build sessions", () => {
    const sessions = [
      { session_key: "s1", task: "Normal coding", state: "live", phase: "coding" },
      { session_key: "s2", task: "Stuck session", state: "possibly_stuck", phase: "coding" },
      { session_key: "s3", task: "Ready for commit", state: "live", phase: "ready" },
      {
        session_key: "s4",
        task: "Build failed task",
        state: "live",
        phase: "testing",
        active_build: { status: "failed", target: "unit-tests" },
      },
    ];

    const gov = selectGovernanceItems({ sessions, alerts: [] });
    assert.equal(gov.length, 3);
    assert.deepEqual(
      gov.map((g) => g.sessionKey),
      ["s2", "s4", "s3"]
    );
  });

  await t.test("nextZoomScale cycles cleanly through 1x -> 1.5x -> 2x -> 1x", () => {
    assert.equal(nextZoomScale(1), 1.5);
    assert.equal(nextZoomScale(1.5), 2);
    assert.equal(nextZoomScale(2), 1);
  });
});
