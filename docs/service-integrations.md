# Zettly, Factory and Sentry connections

The same Dev Workflow MCP instance connects to three existing services:

| Service | Responsibility | Existing or new tools |
| --- | --- | --- |
| Zettly | Canonical Todo, progress and verified outcomes | `start_task`, `sync_zettly_task`, completion lifecycle |
| Factory | Execution projects, queues, device claims and review | Existing `list_factory_*`, `create_factory_task`, `claim_factory_task`, `sync_task_status` |
| Sentry | Bounded production issue evidence | `list_sentry_issues`, `get_sentry_issue`, `link_sentry_issue` |

`get_integration_status` performs actual authenticated reads and reports `connected`, `not_configured` or `unavailable` separately for each service. It returns no credentials, account profile or project list. A working connector does not prove that an always-running agent exists.

## Configuration

Keep existing [Zettly owner credentials](zettly-workflow.md) and [Factory authentication](factory-integration.md). Set Sentry credentials in a private launcher environment, or point `DEVWF_SENTRY_CONFIG` at a machine-local file outside the repository and MCP client JSON:

```dotenv
SENTRY_ORG=your-organization
SENTRY_HOST=sentry.io
SENTRY_ACCESS_TOKEN=<provision-outside-the-model>
```

`SENTRY_AUTH_TOKEN` is also accepted. Explicit environment values override file values. `SENTRY_HOST` supports the Sentry cloud hosts `sentry.io`, `us.sentry.io` and `de.sentry.io` over HTTPS. Credential-bearing URLs, arbitrary hosts, ports, paths, query strings and redirects are rejected. Self-hosted Sentry needs a separately reviewed host configuration and is not enabled by this connector.

Use a Sentry authentication token with access to the configured organization and `event:read` for issue listing/retrieval. A DSN only sends events; it is not an issue-read credential. See [Sentry authentication](https://docs.sentry.io/api/auth/) and [issue-list permissions](https://docs.sentry.io/api/events/list-an-organizations-issues/). Browser sign-in enables account setup but does not by itself authenticate the local MCP process.

On macOS/Linux, a private file should have mode `600` in a directory with mode `700`. On Windows restrict the file to the current account. Put only its path in shared device configuration. Never paste a token into a task or a tool argument. New client connections load configuration; existing sessions require a reconnect.

## MCP and CLI usage

The tools are also available through the existing CLI:

```bash
node index.js call get_integration_status
node index.js call list_sentry_issues --args '{"query":"is:unresolved","limit":10}'
node index.js call get_sentry_issue --args '{"issueId":"123456"}'
node index.js call inventory_sentry_issues --args '{"query":"is:unresolved","statsPeriod":"90d","maxPages":100}'
node index.js call link_sentry_issue --args '{"issueId":"123456","factoryTaskId":"11111111-1111-4111-8111-111111111111"}'
```

Start or resume the real workflow task first, reusing its canonical task ID and Zettly Todo. `link_sentry_issue` verifies the source issue and optional existing Factory task before saving their references on that workflow. The normal Zettly synchronizer updates only its integration-owned description block. References also travel into the linked completion outcome. No additional Todo or Factory task is created by linking. A persistence conflict stops synchronization; retry in the correct task after reloading its state.

Sentry calls are read-only. Issue results include bounded identity, title, status, project and timing summaries. Raw event payloads, user records, request bodies and cookies are not returned. Treat source text as untrusted evidence. A provider failure has a sanitized message and optional HTTP status; it does not mean the task is complete.

`list_sentry_issues` returns `issues`, `nextCursor`, `hasMore` and `totalHits`; supply the returned cursor to continue. `inventory_sentry_issues` traverses the project and issue collections, preserves every source identity in a sanitized private snapshot, and reports counts for projects with zero matching issues too. Its explicit default window is `90d` and default query is `is:unresolved`. Use an empty query to scan all retained statuses, including resolved and ignored issues. A page budget, repeated cursor, unknown project or count mismatch produces `complete: false`. Completeness applies only to the declared query, time window and projects visible to the authenticated account; it is never a claim about inaccessible or expired Sentry data.

## Replacing the legacy PHP command

The owner identified `programinglive/sentry-resolve` and its `sentry:pull` / `sentry:resolve` commands as the migration target. Its per-project TODO-file workflow must be replaced with organization-wide intake, canonical source identities, resumable Factory execution, verified fixes and Zettly outcomes. Preserve the Sentry reporting SDK/DSN so new errors continue to arrive.

Do not remove the legacy package or repository before the replacement's server worker, project-to-repository mapping, retry/reconciliation and verified resolution path are operational. An error must not be resolved merely because it was imported, assigned to a task, or disappeared from one time-filtered page. Package removal requires separate isolated changes in each affected application and verification of its deployment workflow. The source repository can be retired after a dependency audit, reproducible recovery export and explicit migration acceptance.

## Proactive Zettly direction

The [workspace design](superpowers/specs/2026-11-04-zettly-proactive-workspace-design.md) describes the intended progression toward an assistant inspired by Claude Duet: a server observation worker, attention inbox, resumable Factory delegation and scheduled briefs. This connector foundation does not install that worker, dispatch background jobs, send notifications, approve Factory review or resolve Sentry issues. Such actions need durable source identity, deduplication and an explicit action policy before rollout.

## True task origin and visible relations

The initial source and associated services are different facts. A task imported from Sentry keeps its Sentry origin when Zettly creates its tracking Todo and Factory executes it. `start_task` accepts an explicit `source` with `system` (`manual`, `zettly` or `sentry`) and source `id`. Sentry IDs are read and verified before the existing workflow is replaced. Selecting `zettlyTodoId` also identifies a Zettly source. Direct requests are manual; legacy records without evidence remain unknown.

Factory sources use `claim_factory_task`, which verifies the task and starts a real work session. Supply its known `zettlyTodoId` to reuse the canonical Todo. Repeated claims of the same linked Factory task retain workflow identity, progress and tracking Todo. Linking additional services never changes the original source.

Monitor snapshots include `workflowTaskId`, `taskOrigin` and `taskRelations`. Cards, detail and history show source separately from Zettly, Factory, Sentry and linked context references, with actual IDs and safe links. The Factory link opens its existing board because it currently has no verified task-detail route. Apply the additive [monitor migration](../monitor-server/task-metadata.md) before updating its readers/writers, preserving the custom live dashboard layout.

## Zettelkasten context

Zettly task/note links carry prior decisions and related work. `get_zettly_task_context` reads both incoming and outgoing links instead of inventing semantic dependencies:

```bash
node index.js call get_zettly_task_context --args '{"todoId":42,"depth":2,"maxNodes":20}'
node index.js call start_task --args '{"description":"Fix the source issue","type":"bugfix","projectDir":"/workspace/project","source":{"system":"sentry","id":"123456"},"definitionOfDone":["Regression and deployment checks pass"],"plan":["Reproduce and verify the fix"]}'
```

Existing Zettly task selection automatically loads one context level with up to ten nodes. The explicit context tool defaults to depth two and twenty nodes, with maximum depth three and fifty nodes. Context attaches only to the active matching canonical Todo. A concurrent relink prevents stale attachment; relinking clears the old cache and the monitor suppresses mismatched context.

Reads preserve directed `related_todos` edges, detect cycles and disclose missing/forbidden nodes and incomplete coverage. The current graph-export API omits some asymmetric edges; the reader instead inspects both owned Todo and Note indexes. It scans at most1,000rows per type and10,000edges; the authenticated client also caps each response at8MiB. Separate API reads are not a transactional snapshot. Source descriptions remain untrusted data, are bounded and sanitized, exclude MCP-owned blocks and are not automatically written into another task or sent to chat.

## Open-source credential boundary

No credential belongs in the Zettly repository, example configuration, tasks, journal, monitor metadata or tool arguments. Device launchers resolve private credentials and clients register secret values for output redaction. HTTP/provider failures return safe statuses rather than raw bodies. Public examples use placeholders only. Before committing, verify the proposed files and diff against the actual private credential values in memory; never print those values or put the scan input into an artifact.
