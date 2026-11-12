/**
 * Milestone M5 & M6 Mobile Client Module:
 * - Secure Human-in-the-Loop (HITL) Governance Actions & Step-Up Confirmation
 * - Evidence Integrity Classifier (VERIFIED, FAILED, PENDING, STALE, UNAVAILABLE)
 * - Bounded Audit Timeline Paginator with Secret Redaction
 */

export const GOVERNANCE_ACTIONS = Object.freeze({
  approve_gate: {
    id: "approve_gate",
    label: "✓ Setujui Gate",
    riskLevel: "medium",
    requiresStepUp: false,
    riskDescription: "Menyetujui gerbang verifikasi berdasarkan bukti revisi saat ini.",
  },
  reject_gate: {
    id: "reject_gate",
    label: "✕ Tolak Gate",
    riskLevel: "medium",
    requiresStepUp: false,
    riskDescription: "Menolak gerbang dan meminta perbaikan bukti.",
  },
  request_changes: {
    id: "request_changes",
    label: "✎ Minta Perubahan",
    riskLevel: "low",
    requiresStepUp: false,
    riskDescription: "Mengirim catatan revisi ke sesi agen.",
  },
  pause_task: {
    id: "pause_task",
    label: "⏸ Jeda Task",
    riskLevel: "low",
    requiresStepUp: false,
    riskDescription: "Menjeda sementara eksekusi task.",
  },
  resume_task: {
    id: "resume_task",
    label: "▶ Lanjutkan Task",
    riskLevel: "low",
    requiresStepUp: false,
    riskDescription: "Melanjutkan kembali task yang dijeda.",
  },
  cancel_task: {
    id: "cancel_task",
    label: "⊘ Batalkan Task",
    riskLevel: "high",
    requiresStepUp: true,
    riskDescription: "Membatalkan task aktif. Membutuhkan konfirmasi dua langkah.",
  },
  emergency_stop: {
    id: "emergency_stop",
    label: "🛑 Emergency Stop",
    riskLevel: "critical",
    requiresStepUp: true,
    riskDescription: "Menghentikan darurat eksekusi agen melalui supervisor dan mem-fence worker.",
  },
  waive_gate: {
    id: "waive_gate",
    label: "⚠ Kecualikan Gate",
    riskLevel: "high",
    requiresStepUp: true,
    riskDescription: "Mengecualikan gerbang berdasarkan kebijakan dengan pencatatan audit.",
  },
});

/**
 * Builds a structured governance request payload with revision & digest bindings.
 */
export function buildGovernanceRequest({
  sessionKey,
  action,
  reason = "",
  stepUpConfirmed = false,
  contractRevision = "rev_1",
  evidenceDigest = "",
  policyDigest = "default_policy",
  idempotencyKey = "",
} = {}) {
  const key =
    idempotencyKey ||
    `idem_${sessionKey}_${action}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    sessionKey: String(sessionKey || ""),
    action: String(action || ""),
    reason: String(reason || "").trim(),
    stepUpConfirmed: Boolean(stepUpConfirmed),
    contractRevision: String(contractRevision || "rev_1"),
    evidenceDigest: String(evidenceDigest || ""),
    policyDigest: String(policyDigest || "default_policy"),
    idempotencyKey: key,
  };
}

/**
 * Submits a governance action to the DevWorkflow Monitor Server.
 */
export async function submitGovernanceAction({
  baseUrl,
  token,
  payload,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) {
    return { ok: false, status: 0, error: "Server URL is required." };
  }
  const cleanUrl = String(baseUrl).replace(/\/+$/, "");

  try {
    const res = await fetchImpl(`${cleanUrl}/api/v1/mobile/governance/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload || {}),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: body.code || null,
        error: body.error || `HTTP ${res.status}`,
      };
    }

    return {
      ok: true,
      status: res.status,
      ...body,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Classifies session evidence status on the client (Milestone M6).
 * Strictly distinguishes VERIFIED, FAILED, PENDING, STALE, and UNAVAILABLE.
 * Never treats AI boolean assertions (`testsPassed: true`) as VERIFIED without digest + revision match.
 */
export function classifyClientEvidence(session = {}) {
  if (!session || typeof session !== "object") return "UNAVAILABLE";
  const ev = session.evidence;

  if (!ev || typeof ev !== "object" || !ev.executionId || !ev.stdoutDigest || !ev.sourceRevision) {
    if (session.phase === "coding" || session.phase === "testing") {
      return "PENDING";
    }
    return "UNAVAILABLE";
  }

  if (session.currentRevision && ev.sourceRevision !== session.currentRevision) {
    return "STALE";
  }

  if (ev.exitCode !== 0 || (typeof ev.failed === "number" && ev.failed > 0)) {
    return "FAILED";
  }

  return "VERIFIED";
}

function redactClientText(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/\btok_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

/**
 * Paginates audit timeline entries so unlimited history is never loaded into Android memory.
 */
export function paginateAuditEvents(events = [], { page = 1, pageSize = 25 } = {}) {
  const safeEvents = Array.isArray(events) ? events : [];
  const safeSize = Math.max(1, Math.min(50, Number(pageSize) || 25));
  const safePage = Math.max(1, Number(page) || 1);

  const totalItems = safeEvents.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));
  const start = (safePage - 1) * safeSize;
  const slice = safeEvents.slice(start, start + safeSize).map((item) => ({
    ...item,
    reason: redactClientText(item?.reason || ""),
  }));

  return {
    items: slice,
    page: safePage,
    pageSize: safeSize,
    totalItems,
    totalPages,
    hasMore: safePage < totalPages,
  };
}
