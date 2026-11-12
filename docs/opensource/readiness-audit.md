# Open-Source Readiness Audit & Status Report

**Document Version:** 1.0.0  
**Audit Date:** 2026-11-12  
**Target Public Repository:** `github.com/programinglive/dev-workflow-mcp-server`  
**Publication Gate Status:** 🛑 **BLOCKED** (Direct publication of existing repository is strictly prohibited)  
**Approved Strategy:** In-Place Repository Sanitization + Clean Git History Reinitialization (Orphan Root Commit)  

---

## 1. Executive Summary & Gate Status

The repository `@programinglive/dev-workflow-mcp-server` currently contains battle-tested governance capabilities for AI coding agents. However, an empirical security discovery reveals extensive hardcoded internal infrastructure identifiers, private network references (Tailscale IP `100.77.138.14`), internal workstation hostnames (`HELLOWORLD`, `Mac`, `MMCH`), proprietary service URLs (`*.programinglive.com`), and 248 historical Git commit objects that include internal credentials and private commit messages.

### Current Publication Gate: **BLOCKED**
Under the **Mandatory Publication Safety Rule**, direct publication, changing repository visibility to public, pushing historical commits to public remotes, or publishing public npm packages is strictly blocked until:
1. Complete private backup is created and verified (✅ Done: `D:\code\dev-workflow-private-backup-20261112.bundle`).
2. Sensitive data inventory is recorded and sanitized.
3. Internal infrastructure coupling is refactored into pluggable adapters.
4. Clean orphan-root Git candidate is prepared and verified in an isolated workspace.
5. All 16 Release Security Gates pass and receive explicit human authorization.

---

## 2. Multi-Dimensional Readiness Assessment

| Audit Dimension | Current Internal State | Target Open-Source State | Status |
|---|---|---|---|
| **Git Commit History** | 248 refs, commits referencing internal company tasks & local paths | Single clean orphan initial root commit (`v1.0.0-oss`) | 🛑 BLOCKED (Requires Reinit) |
| **Secrets & Credentials** | `security/` scans for secrets at runtime; older commits may hold hashes | Zero credentials in history; clean secret scan | ⚠️ REVIEW_REQUIRED |
| **Internal IPs & Hostnames** | Tailscale `100.77.138.14`, `bw-tools`, `HELLOWORLD`, `MMCH` in code | Generic `localhost:3100`, environment-driven target hosts | ⚠️ REVIEW_REQUIRED |
| **Domain & Account Coupling** | Hardcoded `*.programinglive.com`, personal emails | Configurable `DEVWF_SERVER_URL`, placeholder documentation | ⚠️ REVIEW_REQUIRED |
| **Local-First Defaults** | Assumes Zettly/PocketBase presence unless waived | 100% offline local SQLite & Mermaid CLI default | 🔄 IN_PROGRESS |
| **Monitor Dashboard** | Bound to `100.77.138.14:3100` via systemd | Standalone local CLI command `devworkflow monitor` (loopback) | 🔄 IN_PROGRESS |
| **Cross-Platform Safety** | Hardcoded `C:\Users\DHIKA` paths in rollout/managed configs | Dynamic `os.homedir()`, platform-safe path normalization | ⚠️ REVIEW_REQUIRED |
| **Licenses & Legal** | `MIT` in `package.json`, but contains proprietary company scripts | Clean MIT/Apache-2.0 core with explicit IP boundaries | ⚠️ REVIEW_REQUIRED |

---

## 3. Decision on In-Place History Reinitialization

Per the **Architectural Override Approved by Repository Owner**:
- The existing GitHub repository identity (`github.com/programinglive/dev-workflow-mcp-server`), URL, issues, stars, and watchers will be preserved.
- Instead of creating a separate public fork or repository, the repository history will be reinitialized in-place using a **clean orphan root commit**.
- Previous internal commits will be completely detached from the new public branch ancestry.
- Complete private backup is verified and safely preserved offline before any git rewriting occurs.
- Remote force-push to `origin` requires explicit human authorization after the final release candidate is approved.
