# Zettly, Factory and Sentry connector implementation plan

> For agentic workers: use executing-plans to implement these steps in the isolated worktree.

**Goal:** Connect the existing workflow to bounded Sentry issue context and explicit canonical task links, as the first step toward a proactive Zettly workspace.

**Architecture:** Retain the existing Zettly and Factory clients. Add a small read-only Sentry client and connector handlers. Store verified external references inside the already-persisted Zettly task record and render them in its owned description and completion outcome.

**Tech stack:** Node.js ES modules, existing MCP SDK, native fetch and node:test.

**Spec:** `docs/superpowers/specs/2026-11-04-zettly-proactive-workspace-design.md`.

## Constraints

All new implementation artifacts use English. Credentials stay outside tool arguments, Git and task data. No new runtime dependency. Existing concurrent worktrees and client sessions remain intact. No automatic Sentry resolution, Factory dispatch or new background scheduler in this connector deliverable.

## Review focus

- Provider bodies must not leak credentials or personal event payloads.
- Invalid routes, hosts and redirects must not forward authentication.
- An unavailable service must not be reported as connected.
- Failed local persistence must not mutate the Zettly Todo.
- A retry must preserve task identity and owner description without creating another task.

## Task 1: Read-only Sentry connector

Files: `sentry-client.js`, `tests/sentry-client.test.js`.

- [ ] Write failing tests for configuration, bounded list/get, status errors, routes, redirects, timeout, large bodies and summary projection.
- [ ] Run the focused tests and confirm failures describe the missing connector.
- [ ] Implement `readSentryConfig`, `createSentryClient`, and issue summary projection with cloud-host validation and bounded requests.
- [ ] Run focused tests and inspect failures before proceeding.

## Task 2: Connection checks and canonical task links

Files: `tools/handler-modules/integration-handlers.js`, `tools/definitions.js`, `tools/handler-modules/index.js`, `zettly-workflow.js`, `tests/integration-handlers.test.js`.

- [ ] Test value-free health results, Sentry discovery, existing task verification, idempotent links and persistence conflicts before implementation.
- [ ] Add `get_integration_status`, `list_sentry_issues`, `get_sentry_issue`, and `link_sentry_issue` with injected clients for tests.
- [ ] Render verified source and Factory links in the existing Zettly owned block and outcome. Reuse the canonical Todo.
- [ ] Verify the actual MCP catalog and CLI dispatch, plus existing Factory and Zettly regressions.

## Task 3: Documentation and evidence

Files: `docs/service-integrations.md`, `README.md`, `.env.example`.

- [ ] Document supported configuration, CLI examples, connector boundaries and the separate proactive-worker roadmap.
- [ ] Run the full suite and inspect the actual diff for English artifacts and credential leakage.
- [ ] Verify available service connections without changing production issues or claiming another device's work.
- [ ] Commit the isolated branch through the established workflow and record actual results in Zettly.
