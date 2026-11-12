# DevWorkflow Android Companion — Security Threat Model & STRIDE Analysis

**Document Reference:** `DEVWF-MOB-SEC-001`  
**Date:** 2026-11-12  
**Scope:** Mobile Companion Client, Pairing Flow & Governance APIs  

---

## 1. Trust Boundaries & Threat Actors

```
[Untrusted Local Wi-Fi / LAN]
          │
      Boundary 1: Network Transport (TLS / Tailscale Tunnel)
          ▼
[Android Client: Xiaomi Pad 6]
    └── Keystore / SecureStore (Hardware-Backed Isolation)
          │
      Boundary 2: Authenticated Mobile Gateway (/api/v1/mobile/*)
          ▼
[DevWorkflow Core Server (Node.js)]
          │
      Boundary 3: Process Execution & Supervisor Fencing
          ▼
[AI Coding Agent Subprocesses (Claude, Codex, OpenCode, AGY)]
```

### Threat Actors:
1. **Network Eavesdropper:** Attacker on the same Wi-Fi router intercepting cleartext HTTP traffic.
2. **Rogue Local Client:** Unauthorized device on the LAN attempting to trigger approvals or kill agents.
3. **Compromised Mobile Device:** Stolen or malware-infected tablet with physical access to the monitor app.
4. **Runaway / Hallucinating AI Agent:** Agent stuck in destructive file-system operations or ignoring governance policies.

---

## 2. STRIDE Analysis & Countermeasures

| Threat Category | Potential Attack | Risk | Architectural Countermeasure |
|---|---|---|---|
| **Spoofing** | Attacker spoofs tablet identity to send unauthorized approvals. | **CRITICAL** | Cryptographic QR pairing: tablet signs pairing nonce with hardware-backed ECDSA key; server requires interactive terminal confirmation before registering device. |
| **Tampering** | Man-in-the-Middle modifies task diffs or test evidence during transit. | **HIGH** | Strict HTTPS/TLS enforcement. Mobile approval payload includes cryptographic digest (`expectedEvidenceSha`) of test evidence. Backend verifies digest against local database before transition. |
| **Repudiation** | User claims they did not authorize a destructive commit or waiver. | **MEDIUM** | Every governance action logs an immutable audit event (`pairedDeviceId`, timestamp, signature, contract revision) to `events` table. |
| **Information Disclosure** | Sensitive source code, API keys, or task context leaked over network. | **HIGH** | Deprecate unrestricted cleartext HTTP; mobile snapshots exclude environment variables and secret tokens. Only task objectives and sanitized file summaries are transmitted. |
| **Denial of Service** | Flooding SSE endpoint or spamming emergency stop to stall developer workflow. | **HIGH** | Per-device rate limiting (max 10 actions/min), single active SSE stream per paired device, and mandatory step-up PIN/biometric confirmation for Emergency Stop. |
| **Elevation of Privilege** | Paired monitor device gains arbitrary shell execution on development host. | **CRITICAL** | **Strict Boundary Isolation:** The mobile app has NO shell execution endpoint. It can only submit predefined governance verbs (`approve_plan`, `reject_plan`, `waive_gate`, `stop_agent`). The server executes internal state machine transitions only. |

---

## 3. Emergency Stop Safety Protocol

An emergency stop command issued from a tablet must not crash host system processes arbitrarily.

### 4-Stage Supervision Protocol:
1. **`STOP_REQUESTED`:** Tablet sends signed emergency stop request with reason.
2. **`STOP_DISPATCHED`:** Server records request in audit log and signals the agent execution supervisor (via MCP task cancellation token or SIGINT to child process).
3. **`STOP_CONFIRMED`:** Supervisor confirms process termination or task suspension and marks the session state as `stopped`.
4. **`STOP_UNCONFIRMED` / `STOP_FAILED`:** If the execution host is unreachable or process does not exit within 5 seconds, server reports `STOP_UNCONFIRMED` to the tablet, prompting the developer to check host terminal directly.
