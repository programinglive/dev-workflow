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

- A human operator issues a single-use exception with a dedicated CLI command, e.g. `devwf exception issue --policy <policyId> --scope <repository> --reason <text> --expires <ISO-8601>`. The command **requires an interactive TTY** (`process.stdin.isTTY` and `process.stdout.isTTY`), prints a short summary and asks for an explicit confirmation before writing anything. A non-interactive caller receives a refusal, not a token.
- The token is delivered only through the human's terminal or a separate channel chosen by the operator. The MCP tool response must never echo the token. The agent receives it out of band and passes it as `approvalToken` to `skip_tests`, `waive_documentation`, `waive_dod_item` or `skip_release`.
- At issuance the CLI records `policyId`, `repository`, `justification`, `scope`, `risk`, `owner` (the requesting agent session), `approver` (the human operator identity from the CLI/OS user), `expiresAt`, and the caller process identity. The handler validates with `validatePolicyException` (`governance/exceptions.js:71,92-126`), checks that the token is unused and unexpired and that the caller identity matches the request, consumes it atomically, and only then mutates state.
- The consumed token and validation outcome are appended to the existing history entry, so review can see who approved what and when.
- An agent with shell access cannot obtain a token by calling the CLI from its own non-interactive process: the TTY gate and confirmation refuse it. It also cannot simply reuse a token issued for another session because the record binds the caller identity. This is a speed bump, not a cryptographic guarantee — see section 3.

## 2. Separation of duties: solo versus team

The rule enforced by `governance/exceptions.js:103-108` is that `owner !== approver`. Phase 3 keeps that exact rule but changes who fills the fields:

- **Solo mode:** `owner` is the agent session identity (for example the `ai.opencode/sessionID` metadata handled in `session-scope.js:8`) and `approver` is the human operator who confirmed the CLI prompt. The human is still a different principal from the agent, so the validator's separation requirement is satisfied while a single developer can approve their own agent's waiver.
- **Team mode:** `owner` is the human developer who will perform the work and `approver` is a different human reviewer. The same validator rejects self-approval, so team mode is stricter without a second mechanism.
- Mode selection is explicit: `DEVWF_EXCEPTION_MODE=solo|team`, with `solo` as the default for local work and `team` recommended for shared repositories. Both modes feed the same `validatePolicyException` call; no new approval schema is introduced.

## 3. CI, headless sessions, and behavior in automated agents

- In CI or any headless runner there is no TTY, so the CLI issuance path is unavailable to the agent by design.
- Authorized humans pre-provision a short-lived token in the CI secret store and inject it into the job environment. The agent session reads that token and passes it to the waiver tool; the record binds it to the job/session identity and to a narrow expiry.
- With `DEVWF_REQUIRE_EXCEPTION=1` and no valid token, the four tools refuse and leave state unchanged, so an automated agent cannot silently waive a gate.
- A headless job that tries to self-issue a token is refused by the TTY gate. This protects against the common case, not against a compromised host that can fabricate a PTY or read the CI secret store — recorded honestly in section 4.

## 4. What this design cannot prevent

- An agent with shell access on the same machine can edit `~/.devworkflow/profile.json`, set `DEVWF_TOOL_PROFILE`, `DEVWF_REQUIRE_EXCEPTION`, or the exception store, and restart the MCP server. Tool profiles are visibility controls, not a sandbox (`src/tool-profiles.js:1-10`).
- An agent that controls a PTY on the human's terminal, or has the human's privileges, can fabricate an interactive confirmation or read the token from the local store. The TTY requirement raises the bar but does not remove this class of bypass.
- A token stored in a local file is readable by any process with that user's privileges. In CI, anyone able to read the secret store can inject a token. “Distinct approver” is meaningful only when the approver is a different human or a service with separate credentials.
- The design cannot stop an agent from bypassing MCP entirely and editing workflow state or git directly. True separation requires an external signing service or hardware-backed key, which is out of scope.
- `validatePolicyException` does not verify a cryptographic signature; it validates record shape, expiry and identity strings only (`governance/exceptions.js:71-130`).

## 5. Tests required

- Unit: each of the four handlers with no token, an invalid token, an expired token, a token whose `owner === approver`, a token for a different repository, a token issued for a different caller identity, and a valid token; assert state is unchanged on every refusal.
- Unit: `validatePolicyException` is called with the correct `policyId` and repository, proving the decision comes from `governance/exceptions.js:92-126` and not from a new validator.
- CLI issuance: interactive TTY confirmation succeeds; non-TTY and piped-stdin attempts are refused; output never contains the token.
- Mode tests: solo record has agent-session owner and human approver; team record has two distinct human principals; team mode rejects the solo-shaped record.
- CI: pre-provisioned token with short expiry works; self-issued or missing token fails; expired token fails.
- Token reuse and caller-binding: two calls with the same token fail on the second attempt; a token issued for session A is rejected from session B.
- Integration: CLI issues token, MCP call consumes it, history entry contains approver and expiry, and `get_workflow_status` shows the waiver as approved.
- Regression: with `DEVWF_REQUIRE_EXCEPTION` unset, all existing waivers keep their current behavior.
- Security boundary: no provider error body, token value, or approver credential appears in tool output.

## 6. Implementation order and compatibility risk

1. Add the optional `approvalToken` argument to the four tool definitions in `tools/definitions.js` and accept it in the handlers named above. No behavior change.
2. Add a shared validator helper that wraps `validatePolicyException` and the single-use store, including caller-identity binding; wire it into the four handlers before their state mutations.
3. Add the interactive TTY CLI issuance command with solo/team modes and history projection.
4. Add `DEVWF_REQUIRE_EXCEPTION` opt-in enforcement and CI pre-provisioning guidance.
5. Only in a later major/minor release, consider changing the default.

Compatibility risks: existing automation that calls the four tools without a token keeps working until step 4; after step 4 those clients need an issued token. Adding `approvalToken` to tool schemas increases the prompt payload slightly for `core` and `standard` profiles, so the token estimates in `src/tool-profile-cost.js` must be recomputed. Team mode may reject existing waivers whose approver was not recorded, so migration must allow legacy records to remain visible but unusable under `DEVWF_REQUIRE_EXCEPTION=1`. Any change to `governance/engine.js` must preserve the existing `evaluateGovernanceGate` call sites at `:182` and `:206`.
