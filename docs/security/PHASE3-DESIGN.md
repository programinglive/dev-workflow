# Phase 3 design — waiver approvals through the existing exception mechanism

Status: written proposal only. No production code is changed by this document.

## Problem and evidence

Four escape hatches mutate workflow state without any approval check:

- `skip_tests` — `tools/handler-modules/workflow-handlers.js:1291-1335`
- `waive_documentation` — `tools/handler-modules/workflow-handlers.js:1610-1655`
- `waive_dod_item` — `tools/handler-modules/dod-handlers.js:205+`
- `skip_release` — `tools/handler-modules/release-handlers.js:426+`

`validatePolicyException` already exists at `governance/exceptions.js:71`, with the validation body at `:92-126`: required `justification`, `scope`, `risk`, `owner` and `approver`, separation of duties (owner != approver), optional `expiresAt`, and rejection of `bypassCi` / `bypassSecurity`. Its only production callers are `governance/engine.js:182` and `:206`, and they run only when `state.governance.exceptions` contains a record. Runtime governance initializes `exceptions: []` at `governance/engine.js:98`, so in practice the validator is never reached by the four handlers.

Phase 3 should route those four handlers through `validatePolicyException` rather than inventing a second approval engine.

## 1. Human approval flow

- A human operator issues a single-use exception with a dedicated CLI command, e.g. `devwf exception issue --policy <policyId> --scope <repository> --reason <text> --expires <ISO-8601>`. The CLI records `policyId`, `repository`, `justification`, `scope`, `risk`, `owner`, a **distinct** `approver`, `expiresAt` and a token, and stores it in a local exception store.
- The agent receives the token out of band and passes it as an optional `approvalToken` argument to `skip_tests`, `waive_documentation`, `waive_dod_item` or `skip_release`.
- Before mutating state, the handler calls `validatePolicyException` with the decoded record and `{ policyId, repository }`, then checks that the token is unused and unexpired, consumes it atomically, and only then writes the waiver. On failure it returns a refusal naming the missing field and leaves state unchanged.
- The consumed token and validation outcome are appended to the same history entry the waiver already produces, so review can see who approved what and when.
- This reuses the expiry and separation-of-duties rules at `governance/exceptions.js:103-119` instead of adding new policy fields.

## 2. Opt-in versus default and user impact

- Phase 3a: accept and validate `approvalToken` when supplied, but do not require it. Existing scripts keep working; behavior is unchanged for callers that do not pass a token.
- Phase 3b: `DEVWF_REQUIRE_EXCEPTION=1` makes a valid token mandatory for the four tools. Teams that want approval gates opt in explicitly.
- Phase 3c (only after a full release cycle without regressions): make the requirement the default and provide a documented escape hatch for machine owners, with a breaking-change note.
- Impact: agents can no longer waive a gate silently in opt-in mode; every waiver gains an approver identity and an expiry. Users must run one extra CLI command before an agent can waiver a step.

## 3. What this design cannot prevent

- An agent with shell access on the same machine can edit `~/.devworkflow/profile.json`, set `DEVWF_TOOL_PROFILE`, `DEVWF_REQUIRE_EXCEPTION`, or the exception store, and restart the MCP server. Tool profiles are visibility controls, not a sandbox (`src/tool-profiles.js:1-10`).
- A token stored in a local file is readable by any process with that user's privileges, so “distinct approver” is only meaningful when the approver is a different human or a service with separate credentials.
- The design cannot stop an agent from bypassing MCP entirely and editing workflow state or git directly. True separation requires an external signing service or hardware-backed key, which is out of scope.
- `validatePolicyException` does not verify a cryptographic signature; it validates record shape and expiry only (`governance/exceptions.js:71-130`).

## 4. Tests required

- Unit: each of the four handlers with no token, an invalid token, an expired token, a self-approved token (`owner === approver`), a token for a different repository, and a valid token; assert state is unchanged on every refusal.
- Unit: `validatePolicyException` called with the correct `policyId` and repository, asserting the decision comes from `governance/exceptions.js:92-126` and not from a new validator.
- Token reuse: two calls with the same token must fail on the second attempt even if the first call failed after validation.
- Integration: CLI issues token, MCP call consumes it, history entry contains approver and expiry, and `get_workflow_status` shows the waiver as approved.
- Regression: with `DEVWF_REQUIRE_EXCEPTION` unset, all existing waivers keep their current behavior.
- Security boundary: no provider error body, token value, or approver credential appears in tool output.

## 5. Implementation order and compatibility risk

1. Add the optional `approvalToken` argument to the four tool definitions in `tools/definitions.js` and accept it in the handlers named above. No behavior change.
2. Add a shared validator helper that wraps `validatePolicyException` and the single-use store; wire it into the four handlers before their state mutations.
3. Add the CLI token-issuance command and history projection.
4. Add `DEVWF_REQUIRE_EXCEPTION` opt-in enforcement.
5. Only in a later major/minor release, consider changing the default.

Compatibility risks: existing automation that calls the four tools without a token keeps working until step 4; after step 4 those clients need an issued token. Adding `approvalToken` to tool schemas increases the prompt payload slightly for `core` and `standard` profiles, so the token estimates in `src/tool-profile-cost.js` must be recomputed. Any change to `governance/engine.js` must preserve the existing `evaluateGovernanceGate` call sites at `:182` and `:206`.
