# MCP Ecosystem — Final Release Gate & Coordinated Migration Report

> **Release Gate Verdict:** `BLOCKED_BY_ACTIVE_SESSIONS`  
> **Secondary Technical Block:** PR #2 merge conflict against upstream `programinglive/central-mcp-gateway:main` (`8ab4cb7`)  
> **Governance:** DevWorkflow Canonical Task `63821490-bbb3-4c75-981d-39cfc48b6b08` · Zettly Todo #741 · Zettly Focus #81  
> **Production Boundary Policy:** Strictly enforced. Zero automated merges, zero production mutations, zero restarts of live services on `bw-tools` or `bw-app`. Stopped at the owner approval boundary.

---

## A. Verified PR & Commit Matrix

All three GitHub pull requests were independently inspected via authenticated GitHub CLI (`gh pr view`) on 2026-11-14:

| Pull Request | Repository | Head SHA | Base Ref & SHA | Mergeability Status | CI / Status Checks | Scope Compliance |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **[PR #11](https://github.com/programinglive/infra-knowledge-mcp-server/pull/11)** | `programinglive/infra-knowledge-mcp-server` | `29dc97b8e1bced0df0686c3f248fe4275f98d156` | `main`<br/>`48e381b327256edcd6d6fbf0bc7a5f0b8a59ab8b` | `MERGEABLE`<br/>(Status: `CLEAN`) | 0 checks configured (36/36 passed locally) | **100% Compliant:** Unregisters `ssh_vm` from `tools/definitions.js` & `tools/handlers.js`; adds 2 negative tests in `tests/handlers.test.js`. Zero unrelated mutations (+14 / -29 lines). |
| **[PR #2](https://github.com/programinglive/central-mcp-gateway/pull/2)** | `programinglive/central-mcp-gateway` | `d1a79aea607b440eb7a464406a1f783e3147383d` | `main`<br/>`8ab4cb7590692173b3792081a31615801830cb9d` | **`CONFLICTING`**<br/>(Status: `DIRTY`) | 0 checks configured (14/14 passed locally) | **Scope Compliant, Rebase Required:** Purged `factory.js` and consolidated 9 knowledge tools + `pb_get_collection`. Conflicted with upstream PR #1 (`8ab4cb7`), which had independently dropped `factory.js` and hardcoded `infra.js`. |
| **[PR #98](https://github.com/programinglive/dev-workflow-mcp-server/pull/98)** | `programinglive/dev-workflow-mcp-server` | `90fdde1e6cd467701076aad5f7e60e31bd9e6c4c` | `main`<br/>`a85fe4b67a2f4944393bc34817197a69d6f106e9` | `MERGEABLE`<br/>(Status: `CLEAN`) | **2 SUCCESS / 1 SKIPPED:**<br/>- `ci / Test, lint and build` (SUCCESS)<br/>- `ci / Web build and audit` (SUCCESS)<br/>- `deploy-monitor` (SKIPPED) | **100% Compliant:** Adds all 13 architecture & security audit markdown documents (+1,716 / -0 lines). Tailscale private IPs sanitized to pass OSS public surface tests. Zero runtime code touched. |

---

## B. Security Gate Evidence

All 7 security gates were audited against the actual source code:

1. **`ssh_vm` Absence from Secured MCP Catalog:**
   - `infra-knowledge-mcp-server`: Completely removed from `getToolList()` in `tools/definitions.js` and `handleToolCall()` in `tools/handlers.js`. Verified with negative tests in `tests/handlers.test.js`.
   - `central-mcp-gateway`: Tool list dynamically created without `ssh_vm`; calls return `Gateway Error: Tool "ssh_vm" is not registered on Central MCP Gateway`.
2. **Fleet Probe Abuse Resistance:**
   - `fleet_health` in `tools/fleet_health.js`: Uses schema `NO_ARGS` (`{ type: 'object', properties: {} }`). Command strings are hardcoded constants (`GENERIC_PROBE` and static JSON health check). No user-supplied parameters are interpolated.
   - `release_drift` in `tools/release_drift.js`: `domain` argument is strictly sanitized with regex `replace(/[^a-zA-Z0-9._-]/g, '')`, stripping all shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`, `(`, `)`, `<`, `>`, newlines). `tag` argument is evaluated purely in Node.js client logic without passing to SSH.
3. **Absence of Retired `factory_*` Tools:**
   - Deleted `src/modules/factory.js` (purging `factory_create_task`, `factory_list_tasks`, `factory_list_projects`). Negative unit test in `tests/gateway.test.js` confirms rejection.
4. **Documented Factory Credential Invalidation Path:**
   - Upstream bearer token `fwt_...` accepted by the legacy Factory service endpoint (`http://100.x.x.86:8080/api` on `bw-app`) is documented for invalidation: stop `factory.service` on `bw-app` via systemd, remove the token from `/etc/factory/config.json`, and verify HTTP 401.
5. **PocketBase Schema Mutation Guard:**
   - `pb_create_collection` is strictly omitted from Central Gateway. Only read-only `pb_get_collection` is exposed. Verified in `tests/gateway.test.js`.
6. **PocketBase Authorization & Transport Boundaries:**
   - Standalone PocketBase stdio MCP (which read raw `.env` on local laptops) is eliminated from client configurations. PocketBase queries are routed through Central Gateway over Tailscale private network (`100.x.x.14:3200`) using centralized credentials on `bw-tools`.
7. **Knowledge Retrieval Traversal & YAML Execution Safety:**
   - `src/knowledge/loader.js` validates `name` against a strict 9-element allowlist array (`KNOWLEDGE_FILES`). Path traversal (`../`) throws an immediate error.
   - `src/knowledge/search.js` only indexes static directories defined in `src/config/sources.yaml`, filtering strictly for `.md` files without accepting caller paths.
   - Official `yaml` package (v2.9.1) parses data safely as plain objects without executing arbitrary code.

---

## C. Corrected Rollback Plan (Zero Reliance on `git checkout main`)

All previous references to `git checkout main` are revoked. Rolling back to `main` on `infra-knowledge-mcp-server` would re-expose `ssh_vm`.

### Immutable Recovery Baselines

1. **Central Gateway on `bw-tools`:**
   - Exact safe deployed revision: `8ab4cb7590692173b3792081a31615801830cb9d`
   - Command:
     ```bash
     cd /opt/central-mcp-gateway
     git checkout 8ab4cb7590692173b3792081a31615801830cb9d
     npm install --production
     sudo systemctl restart central-mcp-gateway
     curl -s http://127.0.0.1:3200/health
     ```
2. **Infra Knowledge:**
   - Unpatched `main` (`48e381b`) is insecure.
   - Safe patched baseline revision: `29dc97b8e1bced0df0686c3f248fe4275f98d156` (commit on `security/contain-ssh-vm`).
   - Command:
     ```bash
     git checkout 29dc97b8e1bced0df0686c3f248fe4275f98d156
     ```
3. **Client Configuration Rollback:**
   - Restores protected local backups:
     - Antigravity: `C:\Users\mahardhika\.gemini\antigravity\mcp_config.json.bak-pre-consolidation`
     - Codex: `C:\Users\mahardhika\.codex\config.toml.bak-pre-consolidation`
     - OpenCode: `C:\Users\mahardhika\.config\opencode\opencode.json.bak-pre-consolidation`

---

## D. Production Baseline Revisions & Fingerprints

Verified on live hosts on 2026-11-14:

| Host / Component | Location | Active Revision / Fingerprint | Status & Tools Count |
| :--- | :--- | :--- | :--- |
| **`bw-tools`** Central Gateway | `100.x.x.14:3200` | Git HEAD: `8ab4cb7590692173b3792081a31615801830cb9d`<br/>Service: `central-mcp-gateway.service` | **HEALTHY** (`toolsCount: 11`). `pb_*` (7 tools) and `notify_*` (4 tools). Factory already removed. |
| **`bw-tools`** Infra Knowledge | `100.x.x.14:3300` | Port 3300 active (SSE transport) | **ACTIVE** (To be replaced by consolidated Central Gateway). |
| **`bw-app`** Legacy Factory | `100.x.x.86:8080` | Port 8080 | **STANDALONE** (0 callers in codebase; scheduled for shutdown). |

---

## E. Exact Deployment Sequence (12 Steps)

This sequence is **PLANNED** for execution during an authorized maintenance window:

1. **Reconcile Central Gateway PR #2:**
   - Rebase branch `refactor/purge-legacy-factory` onto upstream `main` (`8ab4cb7`) to resolve the Git merge conflict resulting from PR #1.
2. **Approve and Merge PR #11:**
   - Merge `programinglive/infra-knowledge-mcp-server` PR #11 into `main` (`security/contain-ssh-vm`).
3. **Verify Secured Infra-Knowledge Runtime:**
   - Pull `main` on `bw-tools` port 3300 and verify `ssh_vm` is absent from SSE `tools/list`.
4. **Approve and Merge PR #2:**
   - Merge reconciled `programinglive/central-mcp-gateway` PR #2 into `main`.
5. **Deploy Gateway to `bw-tools`:**
   - Pull pinned merge commit on `bw-tools`, run `npm install --production`, and restart `central-mcp-gateway`.
6. **Verify Consolidated Gateway Endpoint:**
   - Query `http://100.x.x.14:3200/health`: verify `toolsCount: 20` (7 PocketBase + 9 Infra + 4 Notify).
   - Test `pb_get_collection` and `find_domain` over SSE / HTTP POST.
7. **Invalidate Factory Credential on `bw-app`:**
   - Stop legacy `factory.service` on `bw-app` (`100.x.x.86`) and revoke fallback token.
8. **Approve and Merge PR #98:**
   - Merge `programinglive/dev-workflow-mcp-server` PR #98 (architecture documentation).
9. **Confirm Fleet Session Idle State:**
   - Check DevWorkflow monitor (`list_active_sessions`): ensure all sessions on `HELLOWORLD` and `Mac` are idle.
10. **Create Protected Client Configuration Backups:**
    - Execute backup script creating `.bak-pre-consolidation` on `MMCH`, `HELLOWORLD`, and `Mac`.
11. **Roll Out Client Configuration Diffs Device-by-Device:**
    - Step 11a: Apply diff on `MMCH` (test Antigravity, OpenCode, Codex).
    - Step 11b: Apply diff on `HELLOWORLD`.
    - Step 11c: Apply diff on `Mac`.
12. **Final Fleet Acceptance & Regression Test:**
    - Run full negative security test proving `ssh_vm` and `factory_*` are unreachable across all 3 devices.

---

## F. Fleet / Session Coordination Plan

### Fresh Active Session Audit (2026-11-14T13:17:09+07:00)

- `[MMCH] dev-workflow-mcp-server` [antigravity] (Current audit & coordination session)
- `[HELLOWORLD] dbpinball` [opencode] — **ACTIVE CODING** (DoD 7/7, Slice 1 verification)
- `[HELLOWORLD] bw-server-grooming` [antigravity] — **ACTIVE CODING** (DoD 4/5, P1 change coordination)
- `[HELLOWORLD] dbpinball` [opencode] — Stalled session
- `[HELLOWORLD] bw-server-grooming` [opencode] — Stalled session

### Exclusive Change Ownership Protocol
- **Exclusive Change Coordinator:** `MMCH` (Agent session under owner `mahar`, Task `63821490-bbb3-4c75-981d-39cfc48b6b08`, Focus #81).
- **Rule:** No background restarts (`opencode service restart`, `node managed/restart-devices.cjs`) may be executed while `HELLOWORLD` sessions are actively coding.
- **Rollout Window Prerequisite:** Both `dbpinball` and `bw-server-grooming` on `HELLOWORLD` must reach completed phase and disconnect before client configuration reload is initiated.

---

## G. Required Approvals

Before proceeding with Phase 5 execution, explicit written approval is required for:
1. Rebase and merge of [PR #2 (central-mcp-gateway)](https://github.com/programinglive/central-mcp-gateway/pull/2).
2. Merge of [PR #11 (infra-knowledge-mcp-server)](https://github.com/programinglive/infra-knowledge-mcp-server/pull/11).
3. Merge of [PR #98 (dev-workflow-mcp-server)](https://github.com/programinglive/dev-workflow-mcp-server/pull/98).
4. Systemd service restart on `bw-tools` (`100.x.x.14`).
5. Maintenance window scheduling for `HELLOWORLD` client reload.

---

## H. GO / NO-GO Matrix

| Check Item | Requirement | Observed Status | Verdict |
| :--- | :--- | :--- | :--- |
| **Security Containment** | `ssh_vm` completely removed from catalog | PR #11 removes definition & handler; 36/36 tests pass | **GO** |
| **Probe Hardening** | Probes immune to shell injection | Hardcoded commands & strict regex sanitization | **GO** |
| **Factory Purge** | Dead tools & fallback token removed | Deleted from gateway; 14/14 tests pass | **GO** |
| **Knowledge Parity** | 9 capabilities consolidated with YAML validation | All 9 tools integrated in `infra.js`; 14/14 tests pass | **GO** |
| **Schema Protection** | `pb_create_collection` blocked | Omitted from gateway; negative test passes | **GO** |
| **PR Mergeability (PR #11 & #98)** | Clean mergeability against main | Both PRs report `MERGEABLE (CLEAN)` | **GO** |
| **PR Mergeability (PR #2)** | Clean mergeability against main | **`CONFLICTING (DIRTY)`** against upstream `8ab4cb7` | **NO-GO (Rebase Prerequisite)** |
| **Fleet Session Safety** | Zero disruption to active agents | Active sessions coding on `HELLOWORLD` | **NO-GO (Awaiting Window)** |

---

## I. Remaining Risks & Mitigations

1. **PR #2 Merge Conflict:**
   - *Risk:* Attempting to merge PR #2 via GitHub UI fails due to independent deletion of `factory.js` in upstream commit `8ab4cb7`.
   - *Mitigation:* Rebase `refactor/purge-legacy-factory` onto upstream `main` (`8ab4cb7`) in local worktree, run tests, and force-push to PR branch with lease before merging.
2. **HELLOWORLD Agent Disruption:**
   - *Risk:* Reloading ManagedMCP bounces OpenCode on HELLOWORLD, terminating active sessions in `dbpinball`.
   - *Mitigation:* Defer all client configuration edits until monitor shows HELLOWORLD sessions are idle.
3. **Temporary Gateway Drift on `bw-tools`:**
   - *Risk:* Deploying gateway before client configs removes standalone tools before clients are updated.
   - *Mitigation:* Central Gateway is strictly backwards-compatible: it adds tools, does not remove any currently used tool names.

---

## J. Final Recommendation & Verdict

### Final Verdict: `BLOCKED_BY_ACTIVE_SESSIONS`

**Recommendation:**  
Advance PR #11 (`infra-knowledge-mcp-server`) and PR #98 (`dev-workflow-mcp-server`) for merge approval. Rebase PR #2 (`central-mcp-gateway`) onto upstream `main` (`8ab4cb7`). Hold production deployment and client configuration rollout until active coding sessions on `HELLOWORLD` have checkpointed and the owner declares the official maintenance window open.
