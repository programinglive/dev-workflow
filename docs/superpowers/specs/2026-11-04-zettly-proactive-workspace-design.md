# Zettly proactive workspace direction and connector foundation

## Owner intent

Zettly should evolve toward the proactive assistant described in [Introducing Claude Duet](https://claude.com/resources/articles/claude-duet), rather than remaining only an activity journal. The immediate authorized deliverable connects Dev Workflow with Zettly, Factory and Sentry on an isolated branch, preserving concurrent AGY work. OpenCode, Codex and AGY remain supported execution clients.

## Product responsibilities

- Zettly owns the user's goals, canonical Todo, priorities, context and verified outcomes.
- Factory owns execution queues, device claims, work sessions and review transitions.
- Sentry supplies production issue evidence. Reading an issue never proves it is fixed.
- Dev Workflow supplies the same implementation rules, progress and evidence to all coding clients.
- A future server worker owns periodic observation, deduplication, prioritization and resumable background execution. An MCP connection alone is not an always-running worker.

## Immediate connector foundation

Keep the existing Zettly and Factory APIs. Add bounded read-only Sentry discovery, a value-free connection health report, and explicit links from an active canonical workflow task to an existing Sentry issue and optional Factory task. Verify each reference before saving it. Propagate these links into the integration-owned Zettly description and outcome, while preserving owner content. Do not create a second Todo or Factory task merely to link an issue.

Sentry credentials use environment variables or a private machine-local config file, never tool arguments, source control, task descriptions or connection-status output. Read-only HTTPS calls allow only Sentry cloud hosts and explicit supported API routes. Bound time, response size, pagination and output fields; never return raw request bodies, cookies, users or complete event payloads. Reject redirects and sanitize provider errors.

The connector supports organization-scoped issue listing and retrieval. It does not resolve Sentry issues, enqueue Factory work, approve review, deploy code, send notifications or start an unattended agent. Those behaviors belong to the following server-worker deliverable and must use durable idempotency and action policy.

## Proactive roadmap

1. Connector foundation: connection checks, bounded issue context, canonical links and testable failure states.
2. Server observation worker: checkpointed Sentry intake, source-event identity, retry/backoff, duplicate prevention and a Zettly attention inbox. Start with deterministic policies; use AI only where judgment helps.
3. Delegation: an owner-authorized Zettly task creates or reuses one Factory task, routes it to an available executor, and records progress and interruption recovery under the same identity.
4. Daily brief and attention management: summarize material changes and unresolved blockers, with owner-configured frequency and quiet hours.
5. Broader assistant workspace: ongoing conversation, reusable context, additional connectors and reviewable actions. Preserve the existing CLI and developer integration surface for each shipped capability.

## Acceptance

Existing Zettly and Factory behavior remains compatible. New MCP and CLI calls expose their real connection states. Sentry reads and task links have regression coverage for malformed input, authentication failure, missing resources, redirects, oversized responses, persistence conflict and duplicate retries. The user can inspect what is connected and why an operation is pending. A source-only connector result must never be reported as a deployed background assistant.

## Updated owner requirement: complete Sentry coverage and legacy retirement

The owner wants every issue across every Sentry project tracked through an actual verified fix, and the old `php artisan sentry:pull` workflow in `programinglive/sentry-resolve` eventually retired. Add cursor-aware reads and a coverage inventory to the immediate foundation. Report the exact query/time window and accessible projects, persist source identities, and explicitly flag incomplete scans. Initial authenticated evidence on2026-11-04:8projects,262unresolved issues in90days, fully paginated and reconciled against the provider count.

The following remediation deliverable must map every Sentry project to its repository and Factory project, reconcile by organization/project/issue identity, distinguish new/regressed/ignored/resolved states, and preserve failures for retry. Completion requires an implementation change, regression evidence, relevant deployment verification and a source-status check. Import, task creation and assignment never count as fixes. Retire the legacy PHP package only after that path works end to end; preserve the Sentry event-reporting SDK. Repository deletion is a later irreversible migration action and is not part of the connector implementation.

## Updated owner requirement: provenance, Zettelkasten and open-source privacy

Every task must expose its true initial source in the monitor, separately from the services that track or execute it. Carry source and links through progress and history; do not infer a Zettly origin from an automatically created Todo. New workflows record manual/Zettly/Sentry provenance at start and Factory provenance at verified claim. Unknown legacy provenance remains explicit.

Zettly follows the Zettelkasten method: tasks and notes form a linked knowledge graph. The MCP reader must retrieve bounded incoming/outgoing context, retain actual edge direction, detect cycles and report missing permissions or truncation. It must not invent dependency semantics or associate cached context with a different canonical Todo. Selecting an existing Todo should provide useful linked context before implementation; explicit tools permit deeper reads within fixed limits.

Zettly is open source. Real service credentials remain private device configuration and may never enter its source, examples, journal, task context or notification output. Source outputs are sanitized and client credential values are registered for redaction. A repository/diff scan against privately resolved values is required before commit. No new application code or real environment is copied into the separate, dirty Zettly checkout.
