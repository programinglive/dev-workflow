# Governance Authorization Model

**Document Version:** 1.0.0  
**Status:** Active Specification  

---

## 1. Principal Types & Capabilities

DevWorkflow enforces least-privilege authorization across four distinct principal types:

| Principal Type | Example | Permitted Operations | Denied Operations |
| :--- | :--- | :--- | :--- |
| **`human`** | Verified Developer | Start tasks, approve HITL gates, pair/revoke mobile devices, authorize releases. | Bypassing audit log recording. |
| **`device`** | Paired Xiaomi Pad 6 | Read live SSE stream/snapshots; submit HITL approvals if granted `governance:approve` scope. | Direct database CRUD (`pb_*`), extracting server secrets. |
| **`agent`** | Codex / OpenCode / AGY | Execute task steps, record test evidence, query allowed `pb_*` metadata. | Self-approving human gates, mutating `_superusers` or `activity_users`. |
| **`service`** | Automated Background Worker | Synchronize background telemetry and notifications. | Impersonating a human approver on governance waivers or releases. |

---

## 2. Human-in-the-Loop (HITL) Approval Verification

Sensitive governance actions (`approve_gate`, `waive_dod`, `terminate_agent`, `authorize_release`) require:
1. A verified principal with `subjectType === "human"` or an explicitly authorized `device` bound to a verified human owner.
2. Rejection of any request authenticated solely by an automated `service` credential.
3. Append-only audit recording of `actorId`, `deviceId`, `taskId`, `action`, `reason`, and `timestamp`.
