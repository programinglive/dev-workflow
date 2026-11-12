# DevWorkflow Android Companion — Gap Analysis (As-Is vs Master Specification)

**Document Reference:** `DEVWF-MOB-GAP-001`  
**Date:** 2026-11-12  
**Scope:** Mobile Companion & Governance Backend Extension  

---

## 1. Summary Matrix

| ID | Capability Area | As-Is Status | Target Requirement | Severity |
|---|---|---|---|---|
| **GAP-M1** | Server Configuration | Hardcoded build-time IP (`100.77.138.14:3100`) | Dynamic runtime server configuration & multi-profile management | **BLOCKER (OSS)** |
| **GAP-M2** | Device Pairing | None (open read-only LAN/Tailnet access) | QR-code single-use pairing challenge with mutual device auth | **CRITICAL** |
| **GAP-M3** | Real-Time Transport | 3-second HTTP Polling | SSE primary stream + snapshot + resume cursor + polling fallback | **HIGH** |
| **GAP-M4** | Human-in-the-Loop Governance | None (only emergency session close) | Authenticated review gates (Approve Commit, Reject/Approve Plan, Waive Gate) | **CRITICAL** |
| **GAP-M5** | Emergency Stop Supervision | Basic DB phase update (`phase = 'closed'`) | Two-tier control: Cooperative Task Cancellation vs Supervisor Fencing | **HIGH** |
| **GAP-M6** | Xiaomi Pad 6 Cockpit UX | Single monolithic screen with 6 bottom tabs | 3-mode interface (Cockpit, Focus, Governance) optimized for 2880×1800 | **MEDIUM** |
| **GAP-M7** | Network & Security Model | Cleartext HTTP (`usesCleartextTraffic: true`) | Strict TLS/HTTPS over LAN/Tailscale with per-device Keystore credentials | **CRITICAL** |
| **GAP-M8** | CI/CD & Automated Release | Manual local Gradle build script | Automated GitHub Actions workflow producing signed APK release artifacts | **HIGH** |
| **GAP-M9** | Open-Source Decoupling | Coupled to internal Tailscale IP & machine fleet | 100% standalone operation with any public DevWorkflow server | **BLOCKER (OSS)** |

---

## 2. Detailed Gap Descriptions

### GAP-M1: Hardcoded Server Configuration
- **Current State:** `App.js` evaluates `MONITOR_URL` at module load time from `EXPO_PUBLIC_MONITOR_URL` or `app.json` extra field, falling back to `http://100.77.138.14:3100`.
- **Deficiency:** A user downloading a pre-built APK from GitHub cannot connect the app to their local development machine or custom server without modifying source code and rebuilding the APK.
- **Remediation:** Introduce a persistent `ServerProfileStore` using encrypted storage (Android Keystore / SecureStore) with support for adding, editing, validating, and switching server profiles at runtime.

### GAP-M2: Absence of Cryptographic Pairing
- **Current State:** Any client on the network can access `http://<ip>:3100/api/sessions`. Session closure is guarded only by an optional `X-Devwf-Share` or `X-Devwf-Close` header.
- **Deficiency:** Anyone on the local network could trigger session closures or, under future interactive governance, approve unauthorized commits or release actions.
- **Remediation:** Implement `devworkflow monitor pair` CLI command that displays an ephemeral QR code carrying a one-time cryptographic challenge. Tablet scans QR, generates a device keypair, and exchanges credentials with human confirmation in the terminal.

### GAP-M3: Polling vs Low-Latency Streaming
- **Current State:** Client performs `fetch("/api/sessions")` every 3,000 ms. If a network blip occurs, it waits for the next cycle.
- **Deficiency:** Constant polling generates unnecessary network overhead and battery drain during idle periods, while introducing up to 3 seconds of latency for critical build failures or approval requests.
- **Remediation:** Implement a coordinated `ConnectionManager` using Server-Sent Events (`/api/v1/mobile/events`) with sequence IDs, resume cursor (`Last-Event-ID`), and automatic fallback to REST snapshots when SSE is unavailable.

### GAP-M4: Interactive Governance & Review Actions
- **Current State:** Monitor is strictly read-only, except for `POST /api/session/close`.
- **Deficiency:** Developers cannot approve plans, review git diffs, or authorize commits from their tablet cockpit, requiring them to switch back to the desktop terminal.
- **Remediation:** Add dedicated governance endpoints (`/api/v1/mobile/governance/action`) that validate signed device tokens, task contract revisions, and policy compliance before advancing the workflow state machine.

### GAP-M5: Cooperative Cancellation vs Emergency Stop
- **Current State:** `POST /api/session/close` updates `sessions.phase = 'closed'`. The running agent process on the machine may continue executing until its next MCP tool call discovers the closed phase.
- **Deficiency:** If an agent enters an infinite loop, generates destructive file changes, or ignores instructions, closing the DB session does not immediately fence or terminate the worker.
- **Remediation:** Establish distinct cancellation channels:
  1. `cancel_task`: Graceful cooperative stop allowing git worktree cleanup.
  2. `emergency_stop`: Supervisor-level fence with verified lifecycle states (`STOP_REQUESTED`, `STOP_DISPATCHED`, `STOP_CONFIRMED`, `STOP_FAILED`).

### GAP-M6: Xiaomi Pad 6 Cockpit Optimization
- **Current State:** Standard React Native components (`View`, `Text`, `ScrollView`) laid out in two columns.
- **Deficiency:** Does not take full advantage of the Xiaomi Pad 6's 2880×1800 display. Lack of 3 distinct modes (Cockpit passive dashboard, Focus single-task inspector, Governance review mode). Long-running desk operation risks display burn-in or battery drain without ambient dimming.
- **Remediation:** Implement responsive density scaling, virtualized activity lists, ambient cockpit dimming mode, and 3-tier view modes tailored to 11-inch high-resolution touch interactions.

### GAP-M7: Security & Credential Hygiene
- **Current State:** Unrestricted cleartext traffic enabled in Android manifest.
- **Deficiency:** Vulnerable to eavesdropping and MITM on untrusted Wi-Fi networks when operating outside Tailscale.
- **Remediation:** Enforce TLS/HTTPS verification by default. If connecting to local HTTP development instances, enforce an explicit "Restricted Local Mode" toggle with clear visual warning badges.

### GAP-M8: Automated Build Pipeline
- **Current State:** Builds rely on local manual execution of `gradlew.bat assembleRelease`.
- **Deficiency:** Release artifacts are not reproducible across clean CI runners, and APK signing keys are kept on local developer machines.
- **Remediation:** Provide GitHub Actions workflow (`.github/workflows/mobile-release.yml`) that validates code, runs tests, bundles Hermes JS, compiles signed release APKs, and generates SHA-256 checksums for GitHub Releases.

### GAP-M9: Open-Source Independence
- **Current State:** References internal servers, machines (`bw-tools`, `HELLOWORLD`, `Mac`, `MMCH`), and internal domain routing.
- **Deficiency:** Tightly coupled to internal enterprise homelab.
- **Remediation:** Ensure all internal infrastructure references are completely decoupled into pluggable adapters, allowing the APK to connect out-of-the-box to any clean open-source DevWorkflow server.
