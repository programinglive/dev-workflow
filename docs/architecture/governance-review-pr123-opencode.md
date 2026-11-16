# Independent Security & Architecture Review — PR #123 (OpenCode)

- **Reviewer Tool:** OpenCode (`opencode v2.3.0`)
- **Model Identifier:** `kenari/deepseek-v4-1-flash`
- **Pull Request:** `https://github.com/programinglive/dev-workflow-mcp-server/pull/123`
- **Branch:** `feat/cli-first-and-doc-governance` -> `main`
- **Reviewer Substitution:** Authorized replacement for `dod-9` (Codex workspace credits exhausted; replaced with independent headless OpenCode review under `dod-15`).
- **Date:** 2026-11-16

## Review Pass 1 — Commit `37202d89806ab7df818916c9ef3f72b72b9b509b`

- **Method:** Independent read-only static inspection and isolated runtime probes in detached worktree `pr123-opencode-review`.
- **Verdict:** **CHANGES REQUIRED**
- **Blocking Findings Identified:**
  - `CRITICAL-1`: `force_complete_task` approval accepted unauthenticated free text when `DEVWF_GOVERNANCE_OVERRIDE_TOKEN` was unset.
  - `CRITICAL-2`: Caller could silently downgrade `governanceMode` via `start_task` arguments.
  - `CRITICAL-3`: `rerun_workflow` and `claim_factory_task` stripped `governance: null` via `reset()`.
  - `HIGH-5`: `devwf governance validate` could not return `PASS` (exit 0) in standalone diff mode.
  - `HIGH-7`: `MEANINGFUL_CLI_EVIDENCE_RE` accepted bare prose (`"all good, tests passed"`).
  - `HIGH-8`: Deleted documentation files were skipped instead of rejected.

## Remediation Applied — Commit `8cba9db4a794f2861baa169216830ba59bbf71fd`

All CRITICAL and HIGH security findings were fixed in `feat/cli-first-and-doc-governance` with regression tests in `tests/governance-policies.test.js`:
1. `validateForceOverrideAuthorization` (`governance/exceptions.js`) now **fails closed** when `DEVWF_GOVERNANCE_OVERRIDE_TOKEN` is unset or mismatched.
2. `start_task` (`tools/handler-modules/workflow-handlers.js`) ignores caller `governanceMode`, and `resolveEffectiveMode` (`governance/engine.js`) refuses downgrades below repository base mode.
3. `handleRerunWorkflow` and `handleClaimFactoryTask` re-resolve `governance`; post-rollout tasks missing `governance` fail closed with `GOVERNANCE_METADATA_MISSING`.
4. `governance/ci-validator.js` tracks deleted docs (`null` content), handles porcelain renames, supports `--state`, and passes on compliant diffs.
5. `governance/evidence-validator.js` tightens CLI-First command/output matching and rejects deleted/missing documentation files.
6. `governance/policies.json` defines `nonOverridableViolations` (`DOCUMENTATION_SECURITY_VIOLATION`, `REQUIRED_CI_FAILED`).

## Review Pass 2 — Incremental Review on `8cba9db4a794f2861baa169216830ba59bbf71fd`

- **Method:** Independent read-only incremental inspection of `37202d8..8cba9db` plus isolated runtime probes in detached worktree `pr123-opencode-review`.
- **Verdict:** **APPROVED WITH NON-BLOCKING FINDINGS**
- **Follow-up Hardening Applied:**
  - Fixed `containsCredentials` in `governance/evidence-validator.js` to compare `classifySecurity({ text: content }) === "SECRET"`.
  - Guarded `statSync` in `loadPolicies()` (`governance/engine.js`) against transient FS errors.
  - Updated `docs/architecture/CLI_FIRST_AND_DOCUMENTATION_GOVERNANCE.md` and added this review artifact.
