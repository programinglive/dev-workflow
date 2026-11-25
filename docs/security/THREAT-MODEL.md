# Security threat model — tool profiles, waivers and external side effects

## What profiles and gates can prevent

- Tool profiles limit what an agent can **call through MCP**. `core` (18 tools) and `standard` (30) do not register mutation tools such as `set_sentry_issue_status`, waivers or forced completion. `tools/call` for an unregistered name is refused by the dispatcher.
- The identity contract and preflight scope prevent a task that started in one checkout from committing, pushing or releasing in another checkout (`repository-identity.js:520-526`, `:563-577`; `tools/handler-modules/commit-handlers.js:312-340`).
- `set_sentry_issue_status` requires `confirm: true` and a written reason (`tools/handler-modules/integration-handlers.js:90-96`). The gate is a deliberate speed bump against accidental writes, not an authorization boundary.

## What they cannot prevent

- An agent with shell access can edit `~/.devworkflow/profile.json`, set `DEVWF_TOOL_PROFILE`, `DEVWF_SENTRY_AUTORESOLVE` or the preemption environment variables, or restart the MCP server with a different profile. Profiles are visibility and ergonomics controls, **not** a sandbox.
- The preemption gate is config-driven and off by default. When enabled, it fails closed on Sentry errors or incomplete configuration, but `allowPreemptionOverride` is an explicit escape hatch that any agent may pass.
- Waivers are recorded in history; they are not approved by a second party.

## Finding carried over from verification A (not fixed here)

`validatePolicyException` (`governance/exceptions.js:71`, validation body `:92-126`) is called only from `governance/engine.js:182` and `:206`, and only when `state.governance.exceptions` holds a record. Runtime governance initializes `exceptions: []` (`governance/engine.js:98`). None of `skip_tests` (`tools/handler-modules/workflow-handlers.js:1291-1335`), `waive_documentation` (`:1610-1655`), `waive_dod_item` (`tools/handler-modules/dod-handlers.js:205+`) or `skip_release` (`tools/handler-modules/release-handlers.js:426+`) creates such a record or calls the validator.

Proposed Phase 3 design (written proposal only, no implementation): route the four waiver/skip handlers through the existing exception mechanism by recording `policyId`, `repository`, `justification`, `scope`, `risk`, `owner`, a distinct `approver`, and `expiresAt`, then validate with `validatePolicyException` before the state mutation. Do not build a second approval engine.

## Implicit external and local mutations

| Tool | Mutation | Evidence | Recommendation |
|---|---|---|---|
| `complete_task` | PUT to Sentry resolving a linked issue when `resolveSentry` or `DEVWF_SENTRY_AUTORESOLVE=1` | `tools/handler-modules/integration-handlers.js:128-146`; `tools/handler-modules/commit-handlers.js:829-830` | Explicit response naming issue id, new status and result (implemented) |
| `link_sentry_issue` | PUT to Sentry for `resolve`/`unresolve`/`ignore` | `tools/handler-modules/integration-handlers.js:111-132` | Deprecated alias with warning; prefer the confirmed tool (implemented) |
| `set_sentry_issue_status` | PUT to Sentry plus local Zettly link update | `tools/handler-modules/integration-handlers.js:90-110` | Mandatory `confirm` and `reason` (implemented) |
| `inventory_sentry_issues` | Local snapshot write with mode 0600 | `tools/handler-modules/integration-handlers.js:81-88` | Documented in the tool description (implemented) |
| `commit_and_push` | `git commit` and `git push origin` | `tools/handler-modules/commit-handlers.js:468`, `:578` | Already named by the tool; documentation unchanged |
| `perform_release` | Release command and tag push | `tools/handler-modules/release-handlers.js:231`, `:252` | Already named by the tool; documentation unchanged |
| `checkpoint_task` | Zettly Todo sync and read-back | `tools/handler-modules/checkpoint-handlers.js:73`; `zettly-workflow.js:150`, `:165` | Tool name implies checkpointing; keep explicit read-back reporting |
| `sync_zettly_task` | Zettly Todo create/PATCH | `zettly-workflow.js:150`, `:165`, `:169` | Tool name is explicit; no change |

## Separate finding — `refine_with_ai` canonical ID

Reproduction: call `get_workflow_status`, take the Zettly Todo number it prints, then call `refine_with_ai` with that number as `taskId`. The tool replies `Task identity changed. Read the active task and retry with its canonical ID.` `get_workflow_status` does not expose the canonical task ID needed for refinement. Recorded without a fix.

## Written proposal only — packaging gate in the release pipeline

Add a `prepublishOnly` script that runs the packaging dry-run test (`tests/npm-packaging.test.js`) so a tarball cannot be published with runtime state files. This proposal does **not** change any release script in this task.
