import { relasiFlow, urlThumbnail } from "./flow-relation.js";
import { isRunningBuild } from "./build-view.js";

/** Minimum touch target size in density-independent pixels (dp) for Xiaomi Pad 6 desk use. */
export const MIN_TOUCH_TARGET_DP = 48;

/** Minimum separation in dp between destructive actions and cancel/dismiss actions. */
export const MIN_DESTRUCTIVE_GAP_DP = 24;

/** Canonical Xiaomi Pad 6 Cockpit Layout Modes. */
export const COCKPIT_MODES = Object.freeze([
  {
    id: "cockpit",
    label: "Cockpit",
    icon: "⊞",
    description: "2-column active session grid & real-time event stream",
  },
  {
    id: "focus",
    label: "Focus",
    icon: "📐",
    description: "Zoomable architecture diagrams & DoD evidence canvas",
  },
  {
    id: "governance",
    label: "Governance",
    icon: "🛡️",
    description: "Human-in-the-loop approvals, stuck alerts & gate review",
  },
]);

/**
 * Computes real-time KPI summary strip metrics for the Xiaomi Pad 6 header bar.
 */
export function computeCockpitKpis({
  sessions = [],
  builds = [],
  alerts = [],
  machines = [],
} = {}) {
  const safeSessions = Array.isArray(sessions) ? sessions : [];
  const safeBuilds = Array.isArray(builds) ? builds : [];
  const safeAlerts = Array.isArray(alerts) ? alerts : [];
  const safeMachines = Array.isArray(machines) ? machines : [];

  const activeSessions = safeSessions.length;
  const liveSessions = safeSessions.filter((s) => s && s.state === "live").length;
  const runningBuilds = safeBuilds.filter(
    (b) => b && b.active_build && isRunningBuild(b.active_build.status)
  ).length;

  const attentionKeys = new Set();
  for (const s of safeSessions) {
    if (!s || !s.session_key) continue;
    if (
      s.state === "possibly_stuck" ||
      s.phase === "ready" ||
      s.phase === "commit" ||
      s.active_build?.status === "failed"
    ) {
      attentionKeys.add(s.session_key);
    }
  }
  for (const a of safeAlerts) {
    if (a && a.session_key) attentionKeys.add(a.session_key);
  }

  const onlineMachines = safeMachines.filter((m) => m && !m.stale).length;

  return {
    activeSessions,
    liveSessions,
    runningBuilds,
    governanceAttention: attentionKeys.size,
    onlineMachines,
  };
}

/**
 * Extracts active sessions with linked Zettly Draw / Mermaid flow diagrams for Focus Mode.
 */
export function selectFocusDiagrams(sessions = [], monitorUrl = "") {
  if (!Array.isArray(sessions)) return [];
  const results = [];
  for (const s of sessions) {
    const flow = relasiFlow(s);
    if (!flow) continue;
    results.push({
      sessionKey: s.session_key,
      task: s.task || s.session_title || "(tanpa task)",
      projectName: s.project_name || "proyek",
      machine: s.machine || "unknown",
      phase: s.phase || s.state || "active",
      drawId: String(flow.id),
      drawTitle: flow.title || "Architecture Flow Diagram",
      thumbnailUrl: urlThumbnail(monitorUrl, flow.id, s.started_at),
      planDone: s.plan_done || 0,
      planTotal: s.plan_total || 0,
      session: s,
    });
  }
  return results;
}

const GOVERNANCE_PRIORITY = {
  stuck: 0,
  build_failed: 1,
  ready_gate: 2,
  alert: 3,
};

/**
 * Selects and prioritizes sessions requiring Human-in-the-Loop governance attention.
 */
export function selectGovernanceItems({ sessions = [], alerts = [] } = {}) {
  if (!Array.isArray(sessions)) return [];
  const alertMap = new Map();
  if (Array.isArray(alerts)) {
    for (const a of alerts) {
      if (a && a.session_key) alertMap.set(a.session_key, a);
    }
  }

  const items = [];
  for (const s of sessions) {
    if (!s || !s.session_key) continue;
    let kind = null;
    let badgeLabel = null;
    let reason = null;

    if (s.state === "possibly_stuck") {
      kind = "stuck";
      badgeLabel = "PERLU TINDAKAN · MACET";
      reason = "Sesi belum melapor pembaruan dalam batas waktu normal.";
    } else if (s.active_build?.status === "failed") {
      kind = "build_failed";
      badgeLabel = "BUILD GAGAL";
      reason = `Build '${s.active_build.target || "target"}' gagal dan membutuhkan inspeksi.`;
    } else if (s.phase === "ready" || s.phase === "commit" || s.phase === "release") {
      kind = "ready_gate";
      badgeLabel = "SIAP REVIEW / RILIS";
      reason = `Sesi berada pada fase '${s.phase}' dan siap untuk verifikasi akhir.`;
    } else if (alertMap.has(s.session_key)) {
      kind = "alert";
      badgeLabel = "PERINGATAN";
      reason = alertMap.get(s.session_key).pesan || "Perlu perhatian.";
    }

    if (kind) {
      items.push({
        sessionKey: s.session_key,
        kind,
        priority: GOVERNANCE_PRIORITY[kind] ?? 9,
        badgeLabel,
        reason,
        task: s.task || s.session_title || "(tanpa task)",
        projectName: s.project_name || "proyek",
        machine: s.machine || "unknown",
        updatedAt: s.updated_at,
        session: s,
      });
    }
  }

  return items.sort((a, b) => a.priority - b.priority);
}

/**
 * Cycles diagram zoom scale in Focus Mode (1x -> 1.5x -> 2x -> 1x).
 */
export function nextZoomScale(current = 1) {
  if (current === 1) return 1.5;
  if (current === 1.5) return 2;
  return 1;
}
