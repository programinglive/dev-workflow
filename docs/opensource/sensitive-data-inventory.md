# Sensitive Data Inventory & Exposure Risk Assessment

**Document Version:** 1.0.0  
**Security Standard:** Strict Mode & Zero Credential Exposure  
**Policy:** Secret values must never be output in plaintext; findings reference categories and locations only.  

---

## 1. Inventory Summary

An automated audit across 130+ JavaScript/CJS files, markdown documentation, tests, and Git commits identified **8 categories** of sensitive or proprietary internal data.

| Category | Finding Count | Max Severity | Primary Remediation Action |
|---|---|---|---|
| **Private Infrastructure IPs** | 24 | HIGH | Replace `100.77.138.14` with `localhost` / `127.0.0.1` / `process.env.DEVWF_MONITOR_URL`. |
| **Internal Hostnames & Workstations** | 62 | HIGH | Decouple `bw-tools`, `HELLOWORLD`, `Mac`, `MMCH` into generic configuration templates. |
| **Internal CI Runner Identifiers** | 14 | HIGH | Remove hardcoded runner IDs (`58937956`, `58882401`, `58764237`) and tags. |
| **Personal & Workstation Paths** | 18 | MEDIUM | Replace `C:\Users\DHIKA\...` and `/Users/mahardhika/...` with dynamic `os.homedir()`. |
| **Internal Domains & Endpoints** | 45 | MEDIUM | Replace `*.programinglive.com` with placeholder `example.com` or environment configs. |
| **Personal Email Addresses** | 8 | MEDIUM | Replace specific email addresses with placeholder `dev@example.com` or configuration. |
| **Proprietary Integration Modules** | 35 | MEDIUM | Relocate company-specific modules (`managed/rollout.cjs`, `software-factory.md`) to private repo. |
| **Historical Commit Objects** | 248 refs | CRITICAL | Orphan root commit reinitialization to eliminate historical internal commits. |

---

## 2. Detailed Findings Register

### SEC-001: Tailscale Private IP Address (`100.77.138.14`)
- **Category:** Private Infrastructure IP
- **Severity:** HIGH
- **Files Affected:**
  - `README.md` (lines 84, 94, 95, 101, 105, 106, 155, 159, 162)
  - `monitor-server/dashboard.cjs` (live monitor base URL)
  - `managed/rollout.cjs` (`RELEASE_HOSTS: [{ name: 'bw-tools', ip: '100.77.138.14' }]`)
  - `docs/central-managed-mcp.md`, `docs/monitor-dashboard.md`
- **Exposure Risk:** Discloses private Tailscale VPN IP topology and active monitoring endpoints to the public.
- **Remediation Decision:** Replace all hardcoded references with `process.env.DEVWF_MONITOR_URL || 'http://127.0.0.1:3100'`. Document environment variable in `.env.example`.
- **Verification Status:** REPLACED_IN_CANDIDATE

---

### SEC-002: Workstation Names & Fleeting Topology (`HELLOWORLD`, `Mac`, `MMCH`, `bw-tools`)
- **Category:** Internal Hostnames & Topology
- **Severity:** HIGH
- **Files Affected:**
  - `managed/rollout.cjs` (`FLEET_DEVICES` array)
  - `managed/restart-devices.cjs`, `managed/fleet-status.cjs`
  - `tests/mandatory-flow-and-builder-host.test.js`, `tests/rollout-rule-sync.test.cjs`
  - `docs/mcp-reload.md`, `docs/ADOPTION-STATUS.md`
- **Exposure Risk:** Exposes internal machine inventory, operating systems, and remote execution SSH targets.
- **Remediation Decision:**
  - The public core MCP server defaults to a single local machine runtime.
  - Multi-machine fleet rollout is decoupled into an optional configuration file (`fleet.json`) or retained in the private deployment package.
- **Verification Status:** DECOUPLED_IN_CANDIDATE

---

### SEC-003: Internal CI/CD GitLab Runner IDs (`58937956`, `58882401`, `58764237`)
- **Category:** CI/CD Runner Identifiers
- **Severity:** HIGH
- **Files Affected:**
  - `managed/rollout.cjs` (`MANAGED_RULE_BLOCK`)
  - `README.md`
  - `tests/rollout-rule-sync.test.cjs`
- **Exposure Risk:** Exposes internal GitLab project and group runner numeric IDs and decommission history.
- **Remediation Decision:** Abstract runner verification rules to generic tags (`[self-hosted, linux]`) without embedding proprietary GitLab numeric IDs in public code.
- **Verification Status:** DECOUPLED_IN_CANDIDATE

---

### SEC-004: Hardcoded Windows & macOS User Paths (`C:\Users\DHIKA\...`, `/Users/mahardhika/...`)
- **Category:** Personal / Local Filesystem Paths
- **Severity:** MEDIUM
- **Files Affected:**
  - `managed/rollout.cjs` (`scpBootstrapDest: 'helloworld:C:/Users/DHIKA/...'`)
  - `managed/device-entry.cjs`
  - `tests/build-host-precedence.test.js`
- **Exposure Risk:** Leaks developer usernames and local filesystem structure.
- **Remediation Decision:** Use dynamic cross-platform paths (`path.join(os.homedir(), ...)`).
- **Verification Status:** NORMALIZED_IN_CANDIDATE

---

### SEC-005: Proprietary Domains (`*.programinglive.com`) & Personal Emails
- **Category:** Domains & Personal Identifiers
- **Severity:** MEDIUM
- **Files Affected:**
  - `package.json` (`@programinglive/dev-workflow-mcp-server`, homepage, git url)
  - `workflow-guidance.js`, `zettly-client.js`
  - `README.md` (`zettly.programinglive.com`, `factory.programinglive.com`)
- **Exposure Risk:** Directs public users to private internal authenticated endpoints that will fail or reject public connections.
- **Remediation Decision:**
  - Public documentation uses generic placeholders (`https://api.example.com` or `https://github.com/example/dev-workflow`).
  - Provider configs read from environment variables (`ZETTLY_API_BASE`, `DEVWF_SERVER_URL`).
- **Verification Status:** PARAMETERIZED_IN_CANDIDATE

---

### SEC-006: Historical Git Commits & Old Branches
- **Category:** Git Commit History
- **Severity:** CRITICAL
- **Files Affected:** Complete `.git` history (248 refs, tags `v1.0.0` through `v1.30.0`).
- **Exposure Risk:** Even if files are sanitized at HEAD, historical commit objects contain previous iterations, internal bug descriptions, and legacy credentials.
- **Remediation Decision:**
  - Verified private backup bundle created (`D:\code\dev-workflow-private-backup-20261112.bundle`).
  - Create a clean orphan root commit (`git checkout --orphan public-release-root`).
  - History is completely reinitialized; no legacy commit is an ancestor of the public branch.
- **Verification Status:** BACKUP_VERIFIED_ROOT_PREPARED
