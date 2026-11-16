# Global CLI-First & Documentation-as-Code Governance

**Policies:** `architecture.cli_first` (`v1.0.0`), `engineering.documentation_required` (`v1.0.0`)  
**Policy Registry:** `governance/policies.json`  
**Current Rollout Stage:** `PILOT_BLOCKING` (`programinglive/dev-workflow-mcp-server`, `beautyworld_repository/clinic`)

## 1. CLI-First Architecture Policy (`architecture.cli_first` v1.0.0)

Business capabilities must be executable and testable without a UI through reusable domain/application services and, where applicable, a non-interactive CLI. UI, Livewire, API, MCP, and background workers are thin adapters over shared business logic.

- **Applicable classes:** `NEW_FEATURE`, `BUG_FIX`, `REFACTOR`, `INTEGRATION`, `INFRASTRUCTURE`, `SECURITY_FIX`
- **Exempt classes:** `PRESENTATION_ONLY`, `DOCUMENTATION_ONLY`

## 2. Documentation-as-Code Policy (`engineering.documentation_required` v1.0.0)

Documentation is part of the feature and must be created or updated within the same task before completion.

- **New features, CLI commands, API changes, migrations, and infrastructure changes:** documentation is `REQUIRED`.
- **Internal bug fixes, refactors, or presentation-only changes without contract changes:** may use `NOT_REQUIRED_WITH_REASON` with a specific rationale (`>= 15` characters).
- **Quality contract:** rejects empty/placeholder-only files, rejects credentials/secrets, verifies declared files exist in the repository diff, and enforces CLI usage/options or API contract coverage when CLI/API paths change.

## 3. Task Classification

`governance/classifier.js` (`classifyTask`) classifies tasks using both declared intent (`taskType`, `description`) and actual changed paths (`changedPaths`):

`NEW_FEATURE`, `BUG_FIX`, `REFACTOR`, `PRESENTATION_ONLY`, `INTEGRATION`, `INFRASTRUCTURE`, `DOCUMENTATION_ONLY`, `SECURITY_FIX`, `MAINTENANCE`.

If a task starts as `PRESENTATION_ONLY` or `MAINTENANCE` and later modifies business logic files, re-evaluation automatically upgrades applicability to `REQUIRED`.

## 4. Evidence Requirements & Integrity

`governance/evidence-validator.js` binds every piece of evidence to:
- `repository`: normalized git remote slug (rejects cross-repo evidence)
- `revision` / `commitSha`: detects stale evidence (`POLICY_EVIDENCE_STALE`) when code changes after assessment
- `policyVersion` & `policyDigest`: detects policy version drift

Bare declarations (`true`, `ok`, `cli_first=ok`, `README updated`, `Services folder exists`) are rejected.

## 5. MCP Enforcement Behavior

- `start_task`: resolves effective policies, `taskClass`, and applicability in `workflowState.state.governance`.
- `mark_dod_item`: validates CLI-First/headless evidence when marking CLI-First DoD items and records `cliFirstEvidence`.
- `create_documentation` / `waive_documentation`: records `documentationEvidence` bound to repository, revision, and policy digest.
- `complete_task`: runs `evaluateGovernanceGate()` and blocks completion in `enforce` mode with actionable error codes:
  - `CLI_FIRST_ASSESSMENT_MISSING`
  - `CLI_FIRST_EVIDENCE_INVALID`
  - `DOCUMENTATION_ASSESSMENT_MISSING`
  - `DOCUMENTATION_REQUIRED`
  - `DOCUMENTATION_EVIDENCE_INVALID`
  - `DOCUMENTATION_SECURITY_VIOLATION`
  - `POLICY_EVIDENCE_STALE`
  - `POLICY_EXCEPTION_NOT_APPROVED`
  - `REQUIRED_CI_FAILED`

## 6. CI Integration (`devwf governance`)

Run non-interactively in CI or locally:

```bash
devwf governance policies --json
devwf governance validate --policy all --json --dir /path/to/repo --base origin/main
```

Options:
- `--policy <all|architecture.cli_first|engineering.documentation_required>`: Policy scope to evaluate (default: `all`).
- `--dir <path>`: Target repository directory (default: current working directory).
- `--base <ref>`: Optional git base ref for diff inspection.
- `--task-type <type>`: Task type hint (`feature`, `bugfix`, `refactor`, `other`).
- `--description <text>`: Task description hint.
- `--json`: Output machine-readable JSON report.

Exit codes:
- `0`: Gate passed (`gateResult: "PASS"`).
- `1`: One or more policy violations detected (`gateResult: "FAIL"`).

## 7. Exception Approval

`governance/exceptions.js` (`validatePolicyException`) requires `policyId`, `repository`, `justification`, `scope`, `risk`, `owner`, a distinct `approver` (separation of duties; self-approval is rejected), and a valid non-expired `expiresAt`. Exceptions can never bypass CI or security checks.

## 8. Legacy Migration

Tasks started before central governance (`state.governance === null` or `legacyExempt === true`) remain compatible so existing in-flight work is not deadlocked.

## 9. Agent Usage

1. Start the task with `start_task` (policies are attached automatically).
2. Implement shared headless domain/service logic + CLI adapter where applicable, and run headless tests.
3. Prove CLI-First DoD items via `mark_dod_item` with actual test command output.
4. Update relevant docs and call `create_documentation { files: [...] }` (or `waive_documentation` for internal fixes with rationale).
5. Close with `complete_task`.

## 10. Troubleshooting

- `POLICY_EVIDENCE_STALE`: re-run tests/docs and re-confirm `mark_dod_item` / `create_documentation` at the current revision.
- `DOCUMENTATION_SECURITY_VIOLATION`: remove any token, private key, or secret pattern from documentation files.
- `CLI_FIRST_EVIDENCE_INVALID`: include actual test runner output or CLI verification command in the DoD evidence.

## 11. Rollout Stages

1. `AUDIT_ONLY` (`audit`) — evaluate and log without blocking.
2. `WARNING` (`warn`) — emit warnings; non-blocking.
3. `PILOT_BLOCKING` (`pilot`) — **current stage**; blocking enforced on `programinglive/dev-workflow-mcp-server` and `beautyworld_repository/clinic`.
4. `EXPANDED_BLOCKING` (`expanded`) — expand pilot list after compatibility validation.
5. `GLOBAL_ENFORCEMENT` (`enforce`) — set `defaultMode: "enforce"` in `governance/policies.json`.

## 12. Rollback

To roll back blocking immediately without losing audit data, set `rollout.defaultMode` (or `DEVWF_GOVERNANCE_MODE`) to `"warn"` or `"audit"` in `governance/policies.json`, or revert the release tag via `managed/publish.cjs` + `managed/rollout.cjs`.

## 13. Governance Versioning

`governance/policies.json` defines `schemaVersion` (`1.0.0`), per-policy `version` (`1.0.0`), and a deterministic SHA-256 `digest` computed by `loadPolicies()`. Evidence bound to an older policy version or digest is flagged as mismatched.
