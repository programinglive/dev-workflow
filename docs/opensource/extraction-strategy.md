# In-Place Extraction & Clean History Reinitialization Strategy

**Document Version:** 1.0.0  
**Target Approach:** In-Place Repository Sanitization + Clean Orphan Root Reinitialization  
**Backup Reference:** `<PRIVATE_BACKUP_PATH>` (Verified, 6.4 MB, 248 refs)  

---

## 1. Strategy Overview

Rather than abandoning the established GitHub repository (`github.com/programinglive/dev-workflow-mcp-server`), the repository owner approved an **In-Place History Reinitialization**:

```text
[Legacy Private History: v1.0.0 ... v1.30.0 (248 refs)]
                       |
                       | (Backed up to <PRIVATE_BACKUP_PATH>)
                       v
         [DISCONNECTED / RETAINED PRIVATELY]

                       +
                       | (Orphan Branch: git checkout --orphan public-release-root)
                       v
[New Clean Public History: v1.0.0-oss (Clean Root Commit)]
  - Sanitized source code
  - Generic environment templates (.env.example)
  - Zero internal IPs or hostnames
  - 100% test pass on clean snapshot
                       |
                       | (Awaiting explicit human approval)
                       v
           [Remote Force-Cutover to origin/main]
```

---

## 2. Extraction & Reinitialization Steps

### Step 1: Immutable Full Backup (COMPLETED & VERIFIED)
- Created full git bundle: `git bundle create <PRIVATE_BACKUP_PATH> --all`.
- Verified bundle integrity: `git bundle verify <PRIVATE_BACKUP_PATH>` confirms 248 refs and complete history.

### Step 2: Source Code Sanitization
- Relocate proprietary fleet scripts (`managed/rollout.cjs`, `managed/restart-devices.cjs`) into private adapter modules.
- Replace hardcoded Tailscale IP (`127.0.0.1`) with `process.env.DEVWF_MONITOR_URL || 'http://127.0.0.1:3100'`.
- Replace hardcoded user directory paths with `os.homedir()`.
- Provide generic `.env.example`.

### Step 3: Create Orphan Root Branch
```bash
# In the repository workspace
git checkout --orphan public-release-root
git rm -rf .
# Restore reviewed sanitized files only
git add .
git commit -m "feat(core): initial public open-source release of DevWorkflow Governance Runtime"
```

### Step 4: Ancestry Verification
- Run: `git rev-list --max-parents=0 HEAD` (Must return exactly one commit hash).
- Run: `git log --oneline` (Must contain only the clean initial commit; zero historical commits in ancestry).

### Step 5: Test Suite Verification on Clean Snapshot
- Execute `npm test` on the clean orphan branch.
- Verify 100% passing tests with zero dependency on internal infrastructure.

### Step 6: Explicit Human Approval Gate
- Present the verified clean commit hash and secret scan report to the repository owner.
- **STOP.** Do not force-push to `origin` without explicit written approval.
