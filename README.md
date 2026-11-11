# Dev Workflow MCP Server

## Credential isolation

Never commit real credentials. Never store raw secrets inside the workflow
knowledge database. Use environment variables or a secret manager.

`DEV_WORKFLOW_SECURITY_MODE=strict` is the default and only supported mode.
Knowledge may describe credential locations and requirements using SecretReference:

```yaml
database:
  host: db.internal
  secret_ref: env://PROJECT_DATABASE_URL
  classification: INTERNAL
```

Supported reference metadata: `env://VARIABLE_NAME`, `op://vault/item/field`,
`vault://path/to/secret`, `aws-secrets://secret-name`, `gcp-secret://secret-name`,
`bitwarden://item/field`. MCP does not resolve these references.

For PostgreSQL/MySQL, client configuration should specify the variable name only:

```json
{"DEV_WORKFLOW_DB_TYPE":"postgres","DEV_WORKFLOW_DB_URL_ENV":"PROJECT_DATABASE_URL"}
```

Provision that variable in the server's service manager, shell or secret-manager
launcher outside the model and client JSON. The legacy direct URL setting remains
supported with a value-free deprecation warning. SQLite needs neither URL setting.

Raw secret input and writes are rejected with sanitized findings. SECRET-labelled
records are never returned; PUBLIC, INTERNAL (default) and CONFIDENTIAL records
still pass through the output scanner. Use `npm run security:audit` or MCP
`security_audit` for bounded, current-user/project findings. Protected files return
metadata only; the audit does not read their content, resolve secrets or repair data.

Migration: supply explicit `JWT_SECRET`, `SESSION_SECRET` (32+ characters) for their
respective web servers and `ADMIN_PASSWORD` (16+ characters) to create an admin.
Login now uses an HttpOnly cookie; `token` is no longer returned in JSON. Previously
issued bearer tokens remain accepted until expiry. Update custom clients to cookie
authentication. Browser cross-site cookie policies may require a same-site API domain.
Compose requires explicit database credentials and `JWT_SECRET`; build its API from
the repository root. Strict release tools accept the established `npm run release`
syntax only; run other deployment commands in a trusted operator session.

Read the [audit, threat model and migration plan](docs/security-audit.md) and
[verification and remaining risks](docs/security-verification.md). Passing tests
does not prove that all secrets are detected. Trusted executable repository scripts,
external tools, runtime authentication stores, historical Git and backups still
require operational controls. A credential already pasted into a model cannot be
removed by this server.

An MCP server that enforces development workflow discipline: **start (mandatory visual flow gate) → tests → documentation → commit → release**, with no way to skip a step.

```mermaid
graph LR
    A[start_task] --> F[Auto Zettly Draw Canvas & Flow Gate]
    F --> R[refine_with_ai]
    R --> S[Optional search_project discovery]
    S --> B[Implement]
    B --> C[mark_bug_fixed]
    C --> D[create_tests]
    D --> E[run_tests]
    E -- FAIL --> B
    E -- PASS --> G[create_documentation]
    G --> H[check_ready_to_commit]
    H --> I[commit_and_push]
    I --> J[perform_release / skip_release]
    J --> K[complete_task]
```

---

## What lives where

For one approved release shared by HELLOWORLD, MMCH and Mac, see [central managed MCP deployment](docs/central-managed-mcp.md). Device launchers update the local executor automatically from the private release service; existing connections pin their version until reconnect.

The README is the map: you should be able to find any behaviour from this table
without opening a file. If a change makes a row here wrong, the change is not
finished.

| Path | Single responsibility |
|---|---|
| `index.js` | MCP entry point: registers the 64 tools, English implementation instructions and handlers |
| `mcp-index.js` | Central MCP ecosystem index & context-aware recommender for all 11 ecosystem MCP servers |
| `build-monitor.js`, `monitor-server/build-monitor.cjs` | Real-time build & execution status tracker (`report_build_status`) shared between MCP and the live monitor dashboard |
| `mobile-app/build-view.js` | Android build tab presentation and truthful build host labeling |
| `workflow-state.js` | The state machine and its persistence (phase, DoD, plan, history, activeBuild) |
| `workflow-guidance.js` | English implementation instructions delivered at connection and workflow checkpoints |
| `zettly-client.js` | Device-local owner credentials, account checks and bounded authenticated Zettly requests |
| `zettly-workflow.js` | Canonical Todo links, progress synchronization and durable linked-outcome retries |
| `sentry-client.js` | Bounded read-only Sentry cloud issue queries with private device credentials |
| `task-provenance.js` | True initial task origin and verified service/context relation metadata |
| `zettly-context.js` | Bounded incoming/outgoing Zettelkasten task and note context with explicit coverage |
| `tools/handler-modules/integration-handlers.js` | Verified service connection states and canonical Zettly/Factory/Sentry links |
| `db/` | Storage adapters: SQLite (default), PostgreSQL, MySQL, plus migration and replication |
| `monitor.js` | Best-effort reporting of workflow changes to the live dashboard; the MCP process also sends a small heartbeat while its client session stays connected |
| `monitor-server/` | The dashboard process (`dashboard.cjs`), the public share process (`share-server.cjs`), their SQL builders, and their systemd units. Includes responsive bottom navigation bar (Aktif, Riwayat, Rekap, Mesin, Info) and interactive session detail modals. Session cards show the repository (`repo_path` plus `repo_remote`) and warn when a task has no Mermaid flow yet. A card, a history row and a recap line all require **both** a task and a project; see [strict task and project identity](docs/strict-task-identity.md). Reopening a session detail restores its close control. The machine view excludes one identified retired synthetic report while preserving later reports from the same machine name. Main-branch CI deploys reviewed monitor artifacts through a dedicated key after tests pass when monitor files changed. |
| `web/` | The public marketing site: Next.js static export published to `devworkflow.programinglive.com` |
| `mobile-app/` | The tablet client (Expo/React Native) that shows the same sessions on a wall screen. Includes a **"Buka di Browser"** button (Info tab) and a tappable header URL that open the dashboard in the device browser via `Linking.openURL`. |
| `security/` | Secret references, output scanning, and the audit |
| `factory-*.js`, `db/` | Software Factory integration: claiming board tasks, pushing results |
| `managed/` | Central release distribution, bootstrap launcher, protocol validation, and automated multi-device rollout (`managed/rollout.cjs`) |
| `scripts/` | Release, build, verification, and server setup helpers |
| `tests/` | One file per behaviour; `monitor-*` covers the dashboard, `web-*` the site |
| `docs/` | Deployment guides, architecture notes, and the specs/plans this project was built from |

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/programinglive/dev-workflow-mcp-server.git
cd dev-workflow-mcp-server
npm install
```

`better-sqlite3` ships prebuilt binaries for Node 22 and newer (ABI 127, 137,
141, 147). On Node 20 there is no prebuild for the current version, so npm falls
back to `node-gyp` and you need [Python 3](https://python.org) and
[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
on Windows. See [Troubleshooting](#troubleshooting).

### 2. Verify the server runs

```bash
node index.js call get_workflow_status
```

Expected output:

```
📊 Current Workflow Status:

Phase: idle
Task: (none)
Feature flow: ❌
...
```

### 3. Connect an MCP client

See [MCP client configuration](#mcp-client-configuration).

---

## Available Tools

64 tools. See [service connections and proactive Zettly direction](docs/service-integrations.md) and [focus-first development](docs/focus-workflow.md).

| Tool | Purpose |
|---|---|
| `get_current_focus` | Read the configured owner and single active Zettly focus |
| `set_focus` | Set one focus without replacing unfinished work |
| `link_task_to_focus` | Associate the active canonical task while preserving its source |
| `complete_focus` | Close focus only after linked work is complete and evidence is recorded |
| `get_integration_status` | Verify authenticated access to Zettly, Factory and Sentry without exposing credentials |
| `get_zettly_task_context` | Read bounded linked task/note context, cycles and incoming/outgoing coverage |
| `list_sentry_issues` | Read bounded Sentry issue summaries in the configured organization |
| `inventory_sentry_issues` | Scan all accessible projects and issue pages in an explicit window; save a private coverage snapshot |
| `get_sentry_issue` | Retrieve one bounded issue summary without raw event payloads |
| `link_sentry_issue` | Link a verified issue and optional existing Factory task to the current canonical Zettly Todo |
| `start_task` | Begin a task; requires `definitionOfDone` and `plan`; automatically creates or links its Zettly Todo |
| `refine_with_ai` | After the flow gate, submit complete AI-rewritten task instructions using new and prior context; bugfixes require reproduction, expected and observed behavior, evidence, and constraints; updates the same task and Todo, retaining proven evidence |
| `recommend_mcp_tools` | Central discovery index and context-aware recommender for all MCP servers and tools (`central-gateway`, `pocketbase`, `infra-knowledge`, `notify`, `factory`, `zettly`, `clinic-helper`, `playwright`, `gcp`, `cloudflare`, `netlify`, `mermaid`) |
| `report_build_status` | Report live build, test, security scan, or deployment progress (`building`, `testing`, `scanning`, `deploying`, `succeeded`, `failed`, `idle`) with target, command, stage, progress percentage, and output snippet |
| `sync_zettly_task` | Retry pending Zettly task/outcome synchronization or link an existing Todo |
| `set_plan` | Replace the work plan of the running task |
| `search_project` | Search bounded local text in the active repo; returns sanitized path:line citations |
| `mark_plan_step` | Mark one plan step done (or reopen it) |
| `resume_session` | Reconnect to state left behind by another session in this project |
| `checkpoint_task` | Write a checkpoint into the linked Zettly Todo and report `confirmed` only after reading it back; `showRevertPlan` adds a read-only revert record |
| `handoff_task` | Mark the task as leaving this machine for another one; a reason is mandatory |
| `fetch_task` | Refresh another machine's checkpoint over its own dev-workflow process and adopt it here |
| `acknowledge_handover` | Explicitly take a handed-off task back on this machine and clear the marker |
| `set_definition_of_done` | Add or replace the checklist of the current task |
| `mark_dod_item` | Prove one item, with evidence |
| `waive_dod_item` | Exclude one item, with a reason |
| `create_feature_flow` | Record the Mermaid plan and publish an editable Zettly Draw linked to the canonical Todo (tldraw v4 store schema, fractional indexing, and ProseMirror richText compliant) |
| `link_factory_task` | Verify and link an existing Factory task to the active Todo and monitor session |
| `link_zettly_drawing` | Verify and link an existing Zettly Draw to the active Todo |
| `mark_bug_fixed` | Mark the implementation done |
| `create_tests` | Mark tests as written |
| `skip_tests` | Skip tests with a justification |
| `run_tests` | Record test results (blocks commit when failing) |
| `create_documentation` | Record docs as written; `files` are verified against the working tree |
| `waive_documentation` | Exclude the documentation gate with a written reason |
| `check_ready_to_commit` | Verify every required step is complete |
| `commit_and_push` | `git add` → `commit` → `push`, refusing to sweep in another session's work |
| `perform_release` | Record a release; runs even when only another session's files are left unstaged |
| `skip_release` | Skip the release step with a justification |
| `complete_task` | Finish, report what to do next, and reset the workflow |
| `next_steps` | Show the follow-ups stored by the last completed task |
| `get_workflow_status` | Show the current phase |
| `continue_workflow` | Get guidance on the next step |
| `view_history` | List completed tasks |
| `run_full_workflow` | Run every step in one call (requires `dodEvidence` for open items) |
| `rerun_workflow` | Restart the current task from the beginning |
| `drop_task` | Abandon the task without completing it |
| `force_complete_task` | Complete despite missing steps, with a reason |
| `project_summary` | Aggregate activity for the project |
| `project_summary_data` | Read the persisted `project-summary.json` |
| `project_summary_db` | Read the per-user summary from SQLite |
| `list_active_sessions` | List active workflow sessions across all machines from the central monitor (`DEVWF_MONITOR_URL`). Output includes a 🔗 clickable dashboard URL. |
| `list_factory_tasks` | List your Factory task queue (requires config) |
| `list_factory_projects` | List Factory projects available to the configured account |
| `create_factory_task` | Record a new task with a required definition of done |
| `update_factory_task` | Edit a task, including filling a missing definition of done |
| `claim_factory_task` | Claim a Factory task and start a local workflow |
| `start_task` (claim view) | Before you commit to a task, reports which tasks other live sessions currently hold, so two sessions do not compete for the same one. Own, idle and stale (older than 15 minutes) claims are excluded. |
| `sync_task_status` | Report a status change back to Factory |

Development tasks are recorded in Factory by default when the configured account and a matching Git repository project are available. The original request, Zettly Todo, Sentry issue if applicable, Factory task, and visual plan remain separate linked records. `start_task` reports a visible warning when Factory recording fails; it never chooses an unrelated project. Existing Factory links are reused. `create_feature_flow` publishes editable shapes and a preview in Zettly Draw, while `mark_bug_fixed` requires that flow first. The monitor shows the source and linked records. An explicit `FACTORY_AUTO_TASK=false` is reserved for isolated test environments.

#### Junk sessions are not recorded

A session without **both** a task **and** a project carries incomplete
information: it can appear in no active list, no recap, no history entry and no
report. The owner's rule (10 November 2026) is to require both a real task and a
real project (`start_task` and `claim_factory_task` refuse to start without a
valid project), preserve the task description when a task closes, clean up any
incomplete rows, and stop them coming back.

Three things enforce it:

- `monitor-server/empty-session.cjs` holds the one definition (`worthReportingPredicate` requires both `task` and `project_name` to be non-empty). Active, recap and history all filter on it, so a session without a task or without a project is never displayed or counted.
- Ingestion refuses to **create** a row unless it carries **both** a task **and** a project. A sparse report for an existing session is still accepted, and `session-upsert.cjs` preserves both `task` and `project_name` via `COALESCE(NULLIF(...))` when a task closes.
- `node scripts/recover-monitor-identities.cjs --dry-run` restores identity from the linked Zettly Todo, `repo_path` or a sibling row before anything is deleted; `node monitor-server/cleanup-empty-sessions.cjs --dry-run` lists what is left. Running either without `--dry-run` writes at most `--limit` rows.

Full rule, rationale and the production verification are in
[docs/strict-task-identity.md](docs/strict-task-identity.md).

#### Zettly tags for zettelkasten relations

Every record the workflow writes into Zettly carries tags, because the
zettelkasten method depends on being able to walk relations: when you need
something, you should already know what it is connected to.

Four axes, so a card can be reached from several directions:

```
proyek:<repository>   which codebase the work belongs to
tipe:<type>           feature, bugfix, refactor, infra, other
area:<subsystem>      monitor, cli, checkpoint, zettly, erp, deploy, ...
sumber:<origin>       manual, sentry, factory, codex, mcp
```

`zettly-tags.js` derives the names and resolves them to ids. A tag is created
once per owner and reused after that, so the same name never appears twice. Tag
resolution is deliberately **not** allowed to fail the task: if Zettly refuses a
tag call, the task is still created and only the label is lost.

Two details that bit us and are now handled explicitly:

- `GET /api/v1/tags` answers `{ tags, deletedTags }` at the top level, with no
  `data` wrapper. Reading only `data.tags` returned nothing against production,
  which made the client try to create tags that already existed.
- That attempt came back `409`, and treating `409` as a failure silently dropped
  half the tags. A conflict now means "it already exists": the list is re-read
  and the existing id is used.

Drawings and journal entries had no tag relation in Zettly at all, so the
schema now includes `drawing_tag` and `journal_entry_tag` pivots, and
`POST/PATCH /api/v1/drawings` accepts `tag_ids` restricted to the caller's own
tags. Existing records were backfilled with
`php artisan zettly:backfill-tags`, which is idempotent and supports
`--dry-run`; it attached tags to 320 todos, 129 drawings and 318 journal
entries, leaving none without a tag.

The backlog also held 33 free-form tags — `main`, `master`, `@journal`, `dev`,
`—`, `codex/...` — that no reader could place on an axis. `php artisan
zettly:normalise-tags` maps each one to its canonical equivalent and then
deletes it, in that order: branch and session labels become `proyek:<repo>`,
topics become `area:<topic>`, `@journal` becomes `tipe:journal`, and the literal
dash becomes `tipe:todo`. A legacy tag is deleted only after every record that
carried it still holds a schema tag, so normalising can never leave a record
bare. Production ended at 51 tags, all on an axis, with zero records untagged.

Two things to know when reading the result: tags are **per owner**, so the same
name appearing under two users is correct and not a duplicate; and a record
created before a deploy is tagged by the process that created it, which is why a
`php-fpm` reload (and an MCP restart) is part of shipping a tag change.

#### Why a card says "Flow belum ada"
The `sessions` table is keyed by `(session_key, task_id)`, so one session owns
an **identity row** (both fields empty) plus one row per task. Only the card row
carries the relations, including the Zettly Draw link.

On 10 November 2026 the dashboard rendered the identity row as a second card
for a session that already had a properly linked card. That second card has no
relations, so it printed `⚠ Flow belum ada — jalankan create_feature_flow`
while the real card next to it showed `Draw #126`. The flow was never missing;
the duplicate was.

`dedupeSessions` now drops the identity row when the same session has a card
row. The test for "identity" is **both** `task_id` and `task` being empty, not
just `task`: closing a task clears its text but keeps its `task_id` and its
relations, and dropping those would erase the flow from a real card. A session
with no card row keeps its own row, and two different `task_id` rows still
render as two cards.

### Central MCP Ecosystem Index (`recommend_mcp_tools`)

Because `dev-workflow` is always the first MCP server invoked in every coding session, it acts as the discovery index and smart recommender for all MCP servers in our ecosystem (`central-gateway`, `pocketbase`, `infra-knowledge`, `notify`, `factory`, `zettly`, `clinic-helper`, `playwright`, `gcp`, `cloudflare`, `netlify`, `mermaid`).

- **Automatic Recommendations**: `start_task`, `get_workflow_status`, and `continue_workflow` score the active task description, `projectDir`, `definitionOfDone`, and `plan` steps against `MCP_ECOSYSTEM_INDEX` (`mcp-index.js`) and append a `🧭 Recommended MCP Tools` block showing the best-matching MCP servers, key tools, and why they matched.
- **On-Demand Search & Full Catalog**: Call `recommend_mcp_tools` with `{ "query": "send Pusher alert and inspect PocketBase", "projectDir": "D:/code/notification-hub" }` to get targeted recommendations, or `{ "includeAll": true }` to view the complete ecosystem catalog.

### Live Build & Execution Monitor (`report_build_status`)

When a session runs a build, test suite, container image build, security scan, or deployment, call `report_build_status`:

```json
{
  "status": "building",
  "target": "clinic-app:v0.2.11 + Trivy Scan",
  "command": "docker build -t clinic-app:v0.2.11 . && trivy image clinic-app:v0.2.11",
  "stage": "Step 2/4: Compiling Vite frontend assets",
  "progress": 50,
  "output": "vite v5.4.0 building for production..."
}
```

- **MCP Status Visibility**: `get_workflow_status`, `continue_workflow`, and `list_active_sessions` render a `🏗️ Active Build / Execution Monitor` section with an ASCII progress bar, elapsed duration, command, and recent build history.
- **Mission-Control Web Dashboard (`monitor-server/dashboard.cjs`)**: Displays a top KPI strip, a dedicated **🏗️ Live Build & Execution Monitor** hero radar with animated progress bars and 1-second live ticking timers, plus a 6-step Workflow Pipeline Stepper on every session card and detail modal.
- **Zettelkasten card chaining**: starting a new task in the same session creates its own card and marks the previous one `handed-off`, so the board links "continued from" / "continued to" instead of overwriting the topic. See [docs/card-chaining.md](docs/card-chaining.md) and the migration command `node scripts/migrate-monitor-db.cjs`.
- **Fleet parity** (Mesin tab): every machine shows its MCP release version plus the version of each required tool (`gh`, `glab`, `wrangler`, `gcloud`, `node`, `npm`), so "is every device the same?" is answered on one screen instead of by asking three terminals. Version parity and tool parity are reported separately: a matching version with no reported tools is `unreported`, never "in sync". See [docs/fleet-parity.md](docs/fleet-parity.md).
- **Branch and worktree cleanup on completion**: `complete_task` removes the branches whose commits are already reachable from the default branch, and worktrees that are clean, merged, unlocked and idle for 30 minutes. The current branch, `main`, `master`, `develop`, unmerged branches, dirty worktrees and locked worktrees are kept. `cleanupWorkBranches({ repoDir, apply: false })` returns the same decisions without changing anything. A cleanup failure is reported and never fails the completion.

### Build duration report and ETA (`build_report`, `build_estimate`)

`report_build_status` already records every build, test suite and deployment; those events are
now also the history that prediction is built from, so no extra table or migration is needed.

- **`GET /api/builds/report?days=30[&project=&host=]`** pairs `build_started` with its terminal
  event and returns totals, per-project and per-target count/p50/p90/max, stage breakdown, the
  slowest runs and the runs left unclosed. Percentiles use nearest-rank on a 1..30 day window.
- **`build_report`** answers the same question for agents, and **`build_estimate`** predicts how
  long a running build still needs: a p50-p90 range from that target's own successful runs, or
  from its project when the target has no history yet. Fewer than five completed builds never
  produce a number - the answer says there is no baseline instead of inventing one.
- **Trouble changes the number.** A build whose progress has not moved for two minutes is
  `stalled`, one past its own p90 is `overdue` and stops showing a remaining number, and a failed
  build reports no ETA. Each revision carries the reason so the dashboard can say why.
- **Build tab** on the live dashboard lists the durations and the trend, and every session card
  with an active build shows the same estimate the tools give, so a human and an agent never see
  two different answers.

The first estimate for a target appears after its fifth completed build; until then the card
says there is no baseline yet.

### Searching the active project

New implementation artifacts use English: identifiers, comments, docstrings, test descriptions, developer documentation and commit messages. MCP initialization, the workflow prompt and key tool responses deliver this rule to the AI. User conversation and explicitly localized product text can retain the requested language.

Zettly task tracking is automatic at task start, progress and successful completion. Use the existing owner account, not an unverified retired journal service credential. See [Zettly workflow tracking](docs/zettly-workflow.md) for protected credentials, deduplication, retry behavior and linked completion outcomes.

`search_project` searches the Git repository pinned by `start_task.projectDir`. It reads tracked files and untracked, non-ignored files; it skips ignored, known-sensitive, binary, invalid UTF-8, and oversized files. Each call is read-only, keeps no persistent index, and makes no network request. Results are lexical matches, ranked by exact phrase then query-term overlap; this is not semantic/vector search.

Example MCP arguments:

```json
{"query":"where task workflow starts and completes","limit":8}
```

Results contain repository-relative `path:line` citations and at most one 300-character excerpt per result. The scan is bounded to 20,000 candidate paths, 256 KiB per file, and 20 MiB total read; the response reports when a cap may have made results incomplete. The tool accepts no path argument and cannot search outside the active project.

### Definition of Done

Every task carries a checklist of the concrete conditions that must be true before it counts as finished. `start_task` requires it:

```json
{
  "description": "Perbaiki validasi form appointment",
  "type": "bugfix",
  "projectDir": "D:\\code\\clinic",
  "definitionOfDone": ["build lulus", "validasi menolak input kosong"]
}
```

Each item is later either **proven** or **excluded**, and the workflow refuses to commit or close the task while any item is still open:

```json
{ "id": "dod-1", "evidence": "php artisan test -> 412 pass" }
{ "id": "dod-2", "reason": "form ini tidak punya jalur input kosong, sudah dicek di controller" }
```

- Evidence is required (5-500 characters). It is what separates "proven" from "claimed".
- An excluded item keeps its reason in the state and in the `history` entry's `definitionOfDoneSummary`.
- When new working changes appear after a commit, `dodRevision` increments and previously proven items must be re-confirmed against the code that is actually being committed. Waivers survive.
- A task claimed from the Factory board imports the board checklist as **open** items: a checked box on the board is someone's plan, not proof that this machine ran anything.
- `set_definition_of_done` fills the checklist of a task started before this rule existed. Replacing a list that already has proven items is refused unless `append: true`.
- `force_complete_task` is the audited escape hatch: `forced: true`, your reason, and the DoD summary land in history.

### Documentation gate

`create_documentation` used to accept a label. `documentationType: "inline-comments"` closed the step exactly as well as `"README"`, nothing read the working tree, and READMEs fell behind for months while `check_ready_to_commit` reported "Documentation created ✅".

The step now needs **file evidence**:

```json
{
  "documentationType": "README",
  "summary": "Document the new update:check script",
  "files": ["README.md"]
}
```

Every path in `files` must be a documentation path **and** appear as a change in the working tree. `check_ready_to_commit` adds one checklist row, *Documentation updated for code changes*, and `commit_and_push` inherits it, so a commit cannot slip past.

| Situation | Result |
|---|---|
| No source file changed | passes |
| Source changed, a documentation file changed | passes |
| Source changed, no documentation changed, no waiver | **blocked** |
| Source changed, `waive_documentation` with a reason | passes, waiver recorded |
| Repo has no README and no `docs/` | passes (`no-docs`) |

Details worth knowing:

- A documentation file that was **already dirty before `start_task`** does not count, because it cannot be told apart from another session's work. Naming it in `files` claims it explicitly, and that claim is recorded.
- Test files, lockfiles, CI config and data files never trigger the gate. Only source code does.
- `waive_documentation { reason }` is a decision, not a shortcut: the reason goes into history, into the `commit_and_push` report, and into the next session's recommendations. Waiving every task becomes visible instead of silent.
- `run_full_workflow` checks the gate **before the first step**, so it refuses rather than stopping halfway. Pass `documentationFiles` or `documentationWaiverReason`.

### What to do next

`complete_task` no longer just resets. It reports follow-ups built from facts the session produced, and stores them:

- Definition-of-done items that were waived, with their reasons
- Tests that were skipped, with the reason
- Documentation waived, with the reason
- Files left uncommitted (another session's work)
- `TODO`/`FIXME`/`HACK` comments that entered the diff, with `path:line`
- A run of bugfix tasks in the recent history
- A diff that touched an unusually large number of files

You can add your own with `nextSteps` (1-5 items, 10-200 characters). Invalid values are rejected with an explanation, never dropped silently. Facts and your suggestions are printed separately, because a recommendation that always appears for every task gets ignored.

`next_steps` shows the stored list again, at any time — history is per project, so the next session sees it.

### Where the workflow state lives

**Since 1.20.0 the live state lives in a local SQLite database.** JSON files are
still written, but only as an export — they are no longer read as the truth.

```
<project>/.state/
    dev-workflow.db                          ← source of truth (live state, history, summary)
    projects/<project>-<hash>/               ← exported JSON mirror, for humans and old tools
        workflow-state.json
        project-summary.json
        users/<user>/
            workflow-state.<session>.json
```

Two things make concurrent writes impossible rather than merely detected:

- **The row key includes the session.** `workflow_state` is keyed
  `(user_id, project_path, session_key)`, so two sessions never share a row.
- **Every row carries a `version`.** A writer holding a stale version is rejected,
  and its monotonic progress (completed workflow steps, DoD evidence) is merged
  into the stored row instead of overwriting phase, plan, or documentation files.

Postgres is **not** on the write path. It receives a best-effort replica through
a queue, so a database or VPN outage never blocks `start_task`, `mark_dod_item`,
or `commit_and_push`. `get_workflow_status` reports two things you would
otherwise not see: `Replika: tertunda N` when copies are waiting to be sent, and
a warning when two processes write the same session within 60 seconds.

If SQLite itself cannot be opened, **writes are refused** with
`STATE_UNAVAILABLE`. There is no silent fallback to JSON: that path is untested
and would reopen the collision this design closes.

Full layout, schema, and failure behaviour: [`docs/state-storage.md`](docs/state-storage.md).

#### Session and project identity

- **State is per session.** Two OpenCode windows on the same repo no longer overwrite each other's Definition of Done. Before 1.17.0 they shared one file: on 1 November 2026 a session lost its entire DoD twice in one hour.
- **History is per project.** `next_steps` and `view_history` read the same rows from every session, so a follow-up written in one window is visible in the next.
- **`normalizeProjectPath` keeps one project on one row.** `D:\Code\Foo`, `d:/code/foo`, and `D:\Code\Foo\` are the same project on Windows. Case is preserved on POSIX, where `/srv/App` and `/srv/app` really are two directories.
- **The session key comes from MCP metadata.** OpenCode v2 sends `_meta["ai.opencode/sessionID"]` on every call. Clients that send nothing (Codex, Antigravity, the CLI) get `proc-<uuid>`, one per process — not `pid-<pid>`, which made two windows in one process share a key by accident.
- **`projectDir` decides the project, not the process's working directory.** When `start_task` pins a `projectDir`, that choice is recorded per session, so a session opened in `Documents\Default Project` but working on `D:\code\belajar` gets its own project directory instead of sharing one with every other session started from the same folder. Deleting or moving that repository makes the pointer stale, and the session falls back to the working directory.

`start_task` refuses to replace a task that is still running in another live MCP process, **even with `force: true`** — starting a new task would clear that task's Definition of Done, and its evidence cannot be recovered from history. The guard stops applying once the owning process has not written state for 10 minutes, so a leftover MCP process cannot block a session forever. If a layout change finds a running task in an old file, it is not copied; `get_workflow_status` reports it instead of letting it disappear.

#### Upgrading from the JSON layout

Migration runs once per project and is marked in `migration_log` as
`legacy-json-v1:<project>`. It archives the old `workflow_state` table into
`workflow_state_legacy` (those rows belong to the *last writer* of a project, not
to any session), imports each `workflow-state.<session>.json` as its own row, and
moves the old files to `.state/legacy-json/<stamp>/` — **never deletes them**.

Anything the migration could not reach is still visible: `get_workflow_status`
lists `legacy-project` and `pid-*` rows that no session can reach, so a task is
never lost just because its key changed.

#### Running the tests

Tests must not touch your live state. `SqliteAdapter` refuses to open a database
outside the temp directory when it detects a test process (`NODE_TEST_CONTEXT`
or `--test`), so run them with the isolation preload:

```bash
node --no-deprecation --import ./tests/setup-env.js --test tests/*.test.js
```

Running a single file without that flag fails loudly instead of quietly writing
test rows into the database that holds your work. On 2 November 2026 that
happened: 2.544 test rows landed in the production database.

Concurrency is tested with **two real forked processes**
(`tests/state-two-process.test.js`), because Node runs JavaScript one statement
at a time: two promises in one process can never prove that a row claim or a
version guard actually blocked anything. Each property there was verified by
mutation — break the code on purpose, watch the test fail, restore it.


### Watching the work happen
`definitionOfDone` says what must be true before the task may close. It does not say *what you are doing right now*. `start_task` therefore also requires `plan`: 1-15 ordered steps, 3-200 characters each.

#### Test case progress on the card

A card that only says `npm test (100%)` cannot distinguish a slow suite from a
frozen one. Pass `testCases` to `report_build_status` while a suite runs and the
card shows the running case, the counts and a progress bar that moves:

```
report_build_status {
  "status": "testing",
  "target": "unit suite",
  "stage": "tests/cli-commands.test.js",
  "testCases": [
    { "name": "close without --session is refused", "status": "passed", "durationMs": 4 },
    { "name": "drop requires --reason", "status": "passed", "durationMs": 7 },
    { "name": "the card renders the running case", "status": "running" }
  ]
}
```

`status` is one of `passed`, `failed`, `skipped` or `running`; anything else is
recorded as `unknown` rather than guessed as a pass. If you omit `progress`, it
is derived from how many cases have settled, so the bar moves without you having
to compute a percentage. Only the last 100 cases are kept and each name is
truncated to 160 characters, so a huge suite cannot flood every write and every
dashboard poll. An explicit empty `testCases: []` clears the list; omitting the
field keeps what the card already knows.

The same counts also appear in the `report_build_status` answer itself, under
**Test Cases** and **Running now**, so you see the progress without opening the
dashboard.
```
start_task {
  "description": "Tambah endpoint retry",
  "type": "feature",
  "definitionOfDone": ["tes retry lulus"],
  "plan": ["telusuri handler retry", "tulis tes yang gagal",
           "implementasi minimum", "jalankan suite", "perbarui README"]
}
```

Every tool reply then ends with a progress line, so progress is visible while the work happens instead of only at the end:

```
📋 Rencana 2/5 — berikutnya: implementasi minimum
```

`mark_plan_step { id }` closes a step; `mark_plan_step { id, status: "open" }` reopens one that was marked too early. `set_plan { steps }` replaces the plan when the original turns out wrong — steps whose text is unchanged keep their done state, so revising does not erase real progress. `get_workflow_status` shows the full list.

The plan is **not** a gate. Only `definitionOfDone` decides whether a task may close. Two gates for the same work would add friction without adding evidence.

If `plan` is omitted, a temporary plan is derived from the DoD items and the reply says so plainly; the order is a guess, not your plan.

### Resuming work left by another session

State is per session, so a session that is closed leaves its work on disk: phase, DoD evidence, and plan. A new session starts from zero and cannot see it. On 1 November 2026 a task sat stranded at phase `release` and nothing could reach it.

```bash
resume_session                      # list what is resumable in this project
resume_session { "adopt": "ses_..."} # copy it into this session and continue
```

The listing shows the task, phase, DoD and plan progress, and whether it is safe to take. It refuses four things:

- a task whose owner process is still writing (a stopped process stops blocking after 10 minutes)
- resuming while this session already has a running task
- states from another project
- deleting the source file — adoption is a copy, so the original stays as an audit trail

### Sharing a session

Each session on the live dashboard and in the tablet app has a **Bagikan
(Share)** button. It produces a permanent link on the main domain:

```
https://devworkflow.programinglive.com/s/<token>
```

**What the public page shows:** task title and type, current phase, the plan
with completed steps struck through, Definition of Done progress, when it
started, how long it has run, and how long ago it last reported.

**What it never shows:** machine name, project path, project name, session id,
and agent tool. These are enforced by `PUBLIC_DENY` in
`monitor-server/share-page.cjs`, and the test asserts against the rendered HTML
- not the source - so a new template line that leaks a field fails the suite.

**The link is open.** Anyone holding it can read the page, with no login. That
is deliberate: the point is pasting it into WhatsApp. Treat it like an
unlisted document, and revoke it when the work is done.

| Action | How | Effect |
|---|---|---|
| Create | Press **Bagikan** | One live link per session; pressing twice returns the same link |
| Copy again | Press **Salin tautan** | No new token, no new row |
| Revoke | Press **Cabut** | The URL answers `410 Gone` on the next request |

A session card disappears once it has been idle for 30 minutes, but its link
stays live until revoked. The dashboard therefore has a **Tautan berbagi yang
hidup** panel listing every live link, including ones whose session is gone —
marked `sesinya sudah tidak tampil`. Without it a link pasted into WhatsApp
could outlive any way of switching it off. `GET /api/share?all=1` backs it.

**Links never expire on their own.** That is deliberate: a WhatsApp link that
suddenly answers 404 makes people think the system is broken, and they ask you
why. Growth is handled by clearing out links whose session has been *deleted*
— they have nothing left to show — never by age. An idle session from three
hours ago is not an orphan and keeps its link. Press **Cabut yang yatim** in the
panel to clear those out; `POST /api/share?revoke-orphans=1` backs it.

Codes you will see: `200` the page, `404` unknown token or a session already
removed by retention, `410` deliberately revoked. `404` and `410` are kept
apart so a typo is never confused with a link the owner switched off.

Sessions are cleaned up by retention; **share links are not**. `PRUNE_ENABLED`
never touches `share_links`, so a link to a pruned session answers `404` with an
explanation instead of silently disappearing.

Deployment (Cloudflare Tunnel, DNS, Netlify rewrite) is in
[docs/monitor-dashboard.md](docs/monitor-dashboard.md).

### Closing sessions and cards from the terminal

The dashboard is not always reachable — over SSH, in a script, or when the
dashboard is the thing that is stuck. `devwf` does the same closings from a
terminal:

```bash
devwf list                                      # sessions reported by the monitor
devwf close --session ses_abc                   # mark one session closed
devwf share list                                # every live share link
devwf share revoke --token <t>                  # revoke one link
devwf share revoke --orphans                    # clear links whose session is gone
devwf drop --session ses_abc --reason "stale"    # abandon a task, recorded
devwf complete --session ses_abc                 # close a task whose DoD is proven
```

Add `--dry-run` to any writing command to print what would change and write
nothing.

```bash
DEVWF_MONITOR_URL=http://100.77.138.14:3100
DEVWF_MONITOR_TOKEN=<same token the monitor was started with>
```

Both are required for `list`, `close` and `share`. `drop` and `complete` do not
talk to the monitor at all: they load the target session's state on this machine
and run the ordinary `drop_task` / `complete_task` handlers, so the Zettly Todo,
the Factory task and the history are closed exactly as the MCP tool would close
them. Point `DEVWF_STATE_ROOT` at a state tree if the default is wrong.

Four rules matter more than the flags:

- **`--session` is mandatory** for `close`, `drop` and `complete`. There is no
  "current session" default, so a missing target is always a refusal instead of
  a deleted task.
- **`drop` requires `--reason`**, mirroring the MCP rule that abandoning a task
  must say why.
- **No process is ever signalled.** `close` only marks the session closed. The
  monitor's owner pid is the MCP process, not the harness session, so killing it
  can hit the wrong process.
- **Exit code 0 means it really happened.** A refusal, an unknown session, a
  missing token or a `complete` whose Definition of Done is still open all exit
  non-zero, so a script can depend on the result rather than the wording.

### Taking a task across machines

A task can move between the owner's machines (Mac, MMCH, ...) without losing
its Definition of Done, plan, or evidence. The Zettly Todo is the single
record; the machines only *refresh* it over SSH. This is how "take the task
from the Mac and work here on MMCH" works:

```
checkpoint_task                  # write + prove a checkpoint into the Zettly Todo
handoff_task { to, reason }      # mark the task as leaving this machine (reason mandatory)
fetch_task { from, reason }      # on the target: refresh the source's checkpoint, adopt it
acknowledge_handover            # explicit: this machine takes the task back (clears the marker)
```

**When to checkpoint.** At phase transitions, before `complete_task`, and
whenever the owner asks for one. A checkpoint is only `confirmed` after the
machine reads the Zettly Todo back and finds its own element with a matching
timestamp — `confirmed:false` means the write may exist but could not be
verified, so another machine must not rely on it.

**A handoff needs a reason.** `handoff_task` refuses an empty reason: the
machine that picks the task up must know *why* it is taking over. After a
handoff, the source machine's `start_task` and `get_current_focus` refuse to
continue the task silently. Only `acknowledge_handover` (explicit, on the
machine that takes it back) clears the marker, and it records the return in
the checkpoint summary first.

**Fetching from another machine.** `fetch_task` refreshes the source's
checkpoint through that machine's own dev-workflow process with one fixed,
non-interactive SSH command that carries an explicit session key — never a
free-form shell string. An unresolvable machine name is refused, not guessed.
If the remote refresh fails, the last readable Zettly checkpoint is adopted
and the result is flagged `confirmed:false`, so the takeover never blocks.

**Reverts are recorded, never executed.** `checkpoint_task { showRevertPlan:
true }` produces a bounded record of which of this session's commits could be
unwound: candidates, refusals with a reason (already on the remote default
branch, or not authored by this session's identity), and the dirty files.
Nothing runs `reset`, `clean`, or `checkout`; the record is read by the
returning machine and acted on by a human.

### Checking for updates
```bash
npm run update:check        # human-readable
npm run update:check -- --json
```

Compares the installed version against `origin` (for clone installs) and against the npm registry, then prints the exact command. Exit code `0` means up to date, `1` means an update is available, `2` means no source could be checked — "could not check" is not the same as "current". Nothing runs automatically: the tool path that is called most often must never wait on the network.

### Factory task integration

Five tools connect this server to the **Factory** board at
`factory.programinglive.com`. They read and write the real task table
(`factory_tasks`), not the retired PocketBase `activity_tasks` collection
(which still exists but holds 0 records and never reached the board).

They stay **inert** until configured. With no configuration the server behaves
exactly as before, and the tools reply with setup instructions.

```bash
FACTORY_URL=https://factory.programinglive.com
FACTORY_EMAIL=<activity_users email>
FACTORY_PASSWORD=<password>
```

Or supply a ready token instead of a password:

```bash
FACTORY_TOKEN=<PocketBase activity_users token>
```

Optional:

```bash
FACTORY_PB_URL=https://pocketbase.programinglive.com   # where the login happens
FACTORY_MACHINE_ID=<name shown on the device row>       # defaults to the hostname
FACTORY_DEVICE_ID=<fixed device UUID>                   # else derived from the name
FACTORY_AGENT=dev-workflow-mcp                          # max 40 chars
```

Use an **`activity_users` account, not a PocketBase superuser**. Factory accepts
that token as `Authorization: Bearer <token>` for non-browser clients, and the
account only sees its own tasks.

| Tool | Writes? | What it does |
|---|---|---|
| `list_factory_tasks` | no | Reads `GET /api/factory`, maps tasks plus their latest work session, and orders them status → priority. Defaults to `running, queued, backlog, review, blocked` |
| `create_factory_task` | yes | Creates a task (`POST /api/factory {action:create_task}`). Requires `acceptance` and `definitionOfDone`; defaults to `backlog` so recording work never starts a worker run |
| `update_factory_task` | yes | Edits title, description, acceptance or definitionOfDone (`POST /api/factory {action:update_task}`), sending the task's current version so Factory can reject a stale edit with 409 |
| `claim_factory_task` | yes | Opens a work session (`POST /api/work {action:start}`), which is what turns the task `running` on the board, then starts a local workflow |
| `sync_task_status` | yes | Uses the only endpoint that can produce the status; see the table below |

#### Status mapping is not free-form

Factory has no generic "set status" endpoint, so the tool routes each status to
the endpoint that actually supports it:

| Requested status | Endpoint used | Result |
|---|---|---|
| `review`, `blocked`, `paused` | `POST /api/work {action:finish}` | Session closes, task changes accordingly |
| `backlog`, `queued`, `cancelled`, `done` | `POST /api/factory {action:move_task}` | Board column changes; `done` requires the task to be in review with its checklist satisfied |
| `running` | — rejected | Point the caller at `claim_factory_task` |

`review` requires an active work session. Asking for it without one fails with
"no active work session on this device" instead of silently doing nothing - the
task must be claimed first. Full behaviour, limits (summary 2000 chars, step 240
chars) and troubleshooting live in
[docs/factory-integration.md](docs/factory-integration.md).

#### The work session is read from `/api/work`, not from the board payload

`GET /api/factory` deliberately sends only a **badge** per task
(`activityStatus`, device name/agent, client session title). The full session is
191 KB across 829 tasks and no list renders it, so the badge carries no `id` and
no `state`.

Reading the session from that badge made `finishWork` see `state === undefined`
and refuse **every** running task with "no active work session" - measured on
10 November 2026 against a task the board showed as `running`. The client now
reads the real session from `GET /api/work`, which returns `id`, `state` and
`device.id`, and only then sends the finish request. A session that belongs to
another device, or that is already closed, is still refused before any write.

For a linked development task, claim the Factory task, report it for review, and
then call `complete_task` after the workflow checks pass. `complete_task` moves
the matching Factory task to `done` through the configured Factory client and
reports an actionable warning if Factory rejects that transition.

#### Review is reported once, not twice

Factory reads a second `review` report as an **approval**, so a task can jump to
`done` without a human deciding anything. That happened on 29 October 2026 to
four tasks whose earlier session was already `review` while the board still said
`backlog`.

The client now refuses `review` when the latest lifecycle event for that task is
a `work.review` or `task.done`, and says what to do instead:

```
Task "..." sudah pernah dilaporkan untuk review (work.review pada ...).
Melaporkan review kedua kali dibaca Factory sebagai approval, ...
Minta pemilik memutuskan: set done bila pekerjaan diterima, atau kembalikan
ke backlog bila perlu dikerjakan ulang.
```

`blocked` and `paused` are unaffected: only `review` carries approval semantics.

A later `work.paused` event re-opens the task, so rework can be reported again.
That matters because `paused` is the only supported way back from `review` to
`backlog`; without the exception the guard would block legitimate second
reviews forever.

#### Task ids are UUIDs

`list_factory_tasks` prints the full UUID, because `sync_task_status` and
`claim_factory_task` reject the 8-character short key. Earlier versions printed
the short key, which forced agents to call `GET /api/factory` by hand.


### Example session

```
"Start a new task: add user authentication, type: feature"
→ start_task, phase moves to coding

[you write code]

"Mark as fixed: login with JWT token"
→ mark_bug_fixed, phase moves to testing

[you write tests]

"Create tests done"
→ create_tests

"Run tests: passed=true, command='npm test', details='12 tests passed'"
→ run_tests, phase moves to documentation

"Create docs: type=README, summary='Added auth section'"
→ create_documentation, phase moves to ready_to_commit

"Check if ready to commit"
→ check_ready_to_commit → READY

"Commit and push: message='feat(auth): add JWT authentication'"
→ commit_and_push, phase moves to release

"Perform release: command='npm run release:minor'"
→ perform_release, phase moves to ready_to_complete

"Complete task: commitMessage='feat(auth): add JWT authentication'"
→ complete_task, workflow reset to idle
```

---

## MCP client configuration

### OpenCode

OpenCode V2 nests servers under `mcp.servers` and does **not** accept an
`enabled` key there. Config path is reported by `opencode debug paths`
(`~/.config/opencode` on every platform, including Windows).

```json
{
  "mcp": {
    "servers": {
      "dev-workflow": {
        "type": "local",
        "command": ["node", "C:\\path\\to\\dev-workflow-mcp-server\\index.js"]
      }
    }
  }
}
```

The simplest way to write this correctly is to let OpenCode do it:

```bash
opencode mcp add dev-workflow --global -- node "C:\path\to\dev-workflow-mcp-server\index.js"
```

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "args": ["C:\\path\\to\\dev-workflow-mcp-server\\index.js"]
    }
  }
}
```

### Windsurf

`%APPDATA%\Windsurf\config.json` (Windows) or
`~/Library/Application Support/Windsurf/config.json` (macOS):

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "cwd": "C:\\path\\to\\dev-workflow-mcp-server",
      "args": ["index.js"]
    }
  }
}
```

### Antigravity

`%APPDATA%\Antigravity\mcp_config.json`:

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "args": ["C:\\path\\to\\dev-workflow-mcp-server\\index.js"]
    }
  }
}
```

> **Performance:** run `node index.js` directly rather than through `npx`.
> Startup is noticeably faster.

---

## Configuration

### Database

Defaults to **SQLite** (file-based, zero config). PostgreSQL and MySQL are also
supported:

```bash
# .env or environment variable
DEV_WORKFLOW_DB_TYPE=postgres
DEV_WORKFLOW_DB_URL=postgresql://USER:[REDACTED]@HOST:5432/database
```

| Variable | Default | Description |
|---|---|---|
| `DEV_WORKFLOW_DB_TYPE` | `sqlite` | `sqlite`, `mysql`, or `postgres` |
| `DEV_WORKFLOW_DB_URL` | — | Connection string (MySQL/Postgres) |
| `DEV_WORKFLOW_DB_PATH` | `.state/dev-workflow.db` | SQLite path (optional) |
| `DEV_WORKFLOW_USER_ID` | auto-generated | User ID for multi-user isolation |
| `DEV_WORKFLOW_STATE_FILE` | auto-resolved | Base directory for workflow state. Each `<base>/projects/<project>/` holds one state file per session under `users/<user>/`, plus one shared history file. Two sessions never share a task slot. See `docs/2026-11-01-state-isolation-design.md` |
| `FACTORY_URL` | - | Factory base URL, e.g. `https://factory.programinglive.com` |
| `FACTORY_TOKEN` | - | PocketBase `activity_users` token sent as a Bearer header |
| `FACTORY_EMAIL` | - | `activity_users` email, exchanged for a token on demand |
| `FACTORY_PASSWORD` | - | Password for that account |
| `FACTORY_PB_URL` | `https://pocketbase.programinglive.com` | Where the token is obtained |
| `FACTORY_MACHINE_ID` | hostname | Device name shown on the Factory board |
| `DEVWF_MONITOR_URL` | — | Central monitor server URL (e.g. Tailscale IP) for `list_active_sessions` |
| `DEVWF_LOCAL_URL` | — | Local browser-accessible URL of the monitor (e.g. `http://localhost:3100`). When set and different from `DEVWF_MONITOR_URL`, `list_active_sessions` shows an extra **🖥️ Buka di browser** line so you can open the dashboard directly. |
| `DEVWF_MONITOR_TOKEN` | — | Bearer token for write endpoints on the monitor server |
| `FACTORY_DEVICE_ID` | derived from the name | Stable device UUID |

### Project-specific state

Each project keeps its own state in `.state/users/<user-id>/workflow-state.json`.
The `.state/` directory is gitignored.

For multi-client isolation (for example separate state for Windsurf and
Antigravity), set a different user ID per client:

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "args": ["path/to/index.js"],
      "env": { "DEV_WORKFLOW_USER_ID": "windsurf" }
    }
  }
}
```

---

## One-command stack setup (OpenCode V2)

`scripts/setup-stack.js` installs the whole agent stack: this MCP server,
[obra/superpowers](https://github.com/obra/superpowers) skills, and
[RTK](https://github.com/rtk-ai/rtk) token compression.

```bash
node scripts/setup-stack.js      # any platform
```

Platform wrappers install RTK, run `npm install`, then delegate to the same
script:

```powershell
pwsh scripts/bootstrap-windows.ps1
```

```bash
bash scripts/bootstrap-unix.sh
```

### What it does

1. **Finds the real config directory.** Runs `opencode debug paths` and uses the
   reported `config` path, falling back to `~/.config/opencode`. OpenCode V2
   uses that path on Windows too — `%APPDATA%\opencode` is not read.
2. **Backs up `opencode.json`** to `secrets/opencode-backup-<timestamp>.json`
   before touching it.
3. **Registers Superpowers** under the V2 `plugins` key. The V1 `plugin` key is
   deprecated and ignored by V2.
4. **Registers the MCP server** via `opencode mcp add`, which writes a
   schema-valid `mcp.servers` entry.
5. **Installs dependencies.** Without `npm install` the server dies at startup
   with `ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'`.
6. **Smoke tests the server**, then verifies with `opencode mcp list` and
   `opencode plugin list`. Exits non-zero when a check fails.
7. **Creates `AGENTS.md`** in the current project if missing.

---

## Tests

```bash
npm test                            # full suite
npm run test:db                     # tests that need a real PostgreSQL
node --test tests/setup-stack.test.js
```

```
ℹ tests 1053
ℹ pass 1051
ℹ fail 0
ℹ skipped 2
```

`npm run test:db` runs what only a real database can prove — the partial unique
index behind "one live share link per session", and the rule that `unknown`
must not overwrite a real agent label — against `TEST_POSTGRES_URL`. Without
that variable they skip with a visible reason rather than passing silently.

Two sibling test files share one database, so **each file needs its own
`session_key` prefix.** A cleanup assertion like `LIKE 'ses_uji_%'` in one file
fails while the other file's rows are still there; that collision was real and
turned a passing suite red the first time both ran against the same PostgreSQL.

### Rate limit: keyed per reader, not per proxy, and loose enough to not turn readers away

Behind Cloudflare Tunnel every request arrives from `127.0.0.1` — that is
`cloudflared`, not the reader. Keying the limiter on `socket.remoteAddress`
therefore gave **all readers one shared quota**. Measured on 3 November 2026:
130 requests produced 11 × `429`, and one person opening a link 120 times in a
minute locked out everyone else, including the owner. A single WhatsApp preview
fetch would be enough.

`monitor-server/client-key.cjs` returns `CF-Connecting-IP`, but **only when the
connection came from loopback**. From any other address the header is ignored,
because anyone able to reach port 3200 directly could otherwise mint unlimited
quota by inventing a value. The header is validated as an IP first, so a junk
value cannot become a rate-limit key.

**The threshold was also wrong, and that part was worse than the keying.**
Measured before the fix: 200 requests from one IP produced **80 failures**, and
`views` recorded **120 of 200** — four out of ten readers silently lost. At
120/minute, one person refreshing plus a link preview could exhaust the quota.

Now `DEFAULT_RATE_LIMIT = 600`/minute (10 req/s, well under the measured
61 req/s capacity of one process), and `429` answers with a **page that says
the situation is temporary**: "Coba lagi dalam 60 detik - tautannya sendiri
tidak rusak". A bare `too many requests` leads a reader to conclude the link is
broken, and they do not come back.

Measured after: 200 requests → **0 failures, `views` exactly 200**.

> **Measure the limiter directly, not through the tunnel.** Cloudflare
> overwrites or rejects a spoofed `CF-Connecting-IP` (it answered `403`), so a
> probe through the public hostname reports a pass that the server never
> produced. `scripts/probe-rate-limit.sh`, `probe-views.sh`, and
> `probe-capacity.sh` all hit `127.0.0.1:3200` for this reason.

### Lint: local `web/` runs need `.netlify/**` ignored

`npm run lint --prefix web` was red locally with 12 `no-this-alias` errors and
green in CI. The errors were not in source: they were inside the minified Next
bundles that `netlify deploy --build` leaves in `web/.netlify/static/`. CI does a
fresh checkout, so it never sees them.

`web/eslint.config.mjs` now ignores `.netlify/**` alongside `.next/**` and
`out/**`. The ignore is not cosmetic — a lint that is red for a reason unrelated
to your change gets ignored, and a real error reads as more of the same noise.

### Windows: close SQLite before deleting the temp directory

`npm run test:security` was red on Windows for months while CI stayed green:

```
EBUSY: resource busy or locked, unlink '...\dev-workflow.db-shm'
```

The cause was not the security checks. `temporary()` deleted its temp directory
while the `WorkflowState` it created still held an open SQLite handle — **the
test process was holding its own file.** Retrying cannot fix that; only closing
the connection can.

So `temporary(fn)` passes a `daftar` callback and every test hands it the
`WorkflowState` it creates. On the way out, the adapter is closed, then
`tests/helpers/hapus-sementara.js` retries the delete — retrying *only* on
`EBUSY`/`EPERM`/`ENOTEMPTY`, because swallowing `EACCES` would mean the cleanup
failed while the test reported success.

This matters beyond tidiness: a suite that is red for an unrelated reason gets
ignored, and a real security regression disappears into the noise. Proved by
mutation — removing the close loop reproduces exactly six failures.

The two skipped tests are the MySQL and PostgreSQL adapters. They run only when a
database is reachable:

```bash
TEST_MYSQL_URL=mysql://USER:[REDACTED]@HOST:5432/database npm test
TEST_POSTGRES_URL=postgres://USER:[REDACTED]@HOST:5432/database npm test
```

To exercise them against real servers without exposing them publicly:

```bash
# on the database host, once: creates isolated devworkflow_test databases
./scripts/setup-test-dbs.sh

# locally: opens an SSH tunnel, runs only the adapter tests, closes the tunnel
TEST_POSTGRES_URL=... TEST_MYSQL_URL=... ./scripts/test-db-adapters.sh
```

Both adapters pass against live MySQL and PostgreSQL this way (19/19 tests, none
skipped). The tests **write real rows**, so `setup-test-dbs.sh` creates separate
`devworkflow_test` databases and grants the test role access only to those. Never
point these variables at a production database.

Everything else, including the SQLite adapter, always runs.

`tests/test-helpers.js` exports `stripNpmNotices()`, which removes npm's own
`npm warn`/`npm notice` output and Rollup's third-party annotation warnings from
captured stderr before the build test asserts on it.

---

## CI

`.github/workflows/ci.yml` is a thin caller for the organisation-wide standard
`programinglive/ci-cd@v1`. It runs on the **self-hosted runner on MMCH**, not on
GitHub-hosted minutes:

```yaml
jobs:
  ci:
    uses: programinglive/ci-cd/.github/workflows/ci-node.yml@v1
    with:
      runner: '["self-hosted","windows","mmch"]'
```

| Job | Steps |
|---|---|
| `ci` (test/lint/build) | `npm ci` → `npm test` → security boundaries → setup-stack suite → `npm run lint` → `build:server` → **verify the bundle starts** → `npm audit --omit=dev --audit-level=high` |
| `ci` (web) | `npm ci` in `web/` → static export build → `npm audit --omit=dev --audit-level=high` |

The workflow definition lives in `programinglive/ci-cd`, so every repository
runs the same steps. Changing this repository's checks means changing the
caller's `with:` block, not copying pipeline code.

The bundle verification step exists because a successful build does not mean
the artefact runs. `dist/index.mjs` is the published package entry, and a
bundler upgrade once produced a green build whose output crashed on startup.
`scripts/verify-bundle.mjs` starts the bundle and requires the stdio startup
banner, so that class of failure fails the pull request instead of the release.

The `web` job exists because the dashboard is deployed to Netlify from `web/`.
The CSS size check catches a Tailwind regression that a green build would
otherwise hide.

### Tailwind stays on v3

`web/` uses Tailwind 3.4 and is **not** being migrated to v4. Tailwind 4 is a
rewrite of the CSS pipeline: the `@tailwind` directives become
`@import "tailwindcss"`, the config moves into CSS, and the PostCSS plugin is
replaced by `@tailwindcss/postcss`. The dashboard is finished and stable, so
rewriting its styling pipeline risks the entire visual design for no functional
gain.

`dependabot.yml` ignores `tailwindcss`, `@tailwindcss/postcss` and
`@tailwindcss/cli` entirely — not just majors — so no v4 pull request
reappears.

Runner provisioning and troubleshooting: [docs/homelab/ci-runner.md](./docs/homelab/ci-runner.md).

---

## Release workflow

`.github/workflows/github-release.yml` runs on a `v*` tag, split in two:

| Job | Runner | Work |
|---|---|---|
| `build` | self-hosted MMCH | check the tag matches `package.json` → `npm ci` → `npm test` → `build:server` → verify the bundle starts → `npm pack` → upload tarball |
| `publish` | `ubuntu-latest` | download tarball → `npm publish` → create/update the GitHub release |

Publishing uses **Trusted Publishing (OIDC)**: no long-lived npm token is stored
anywhere, and `id-token: write` plus `registry-url` on `setup-node` is the whole
configuration. The trusted publisher is registered with `npm trust`:

```bash
npm trust github @programinglive/dev-workflow-mcp-server \
  --file .github/workflows/github-release.yml \
  --repo programinglive/dev-workflow-mcp-server \
  --allow-publish -y
```

The `file` must match the workflow filename exactly, or OIDC is rejected.

### The tag must match `package.json`

`build` checks out `ref: main`, while the version being released comes from the
tag name. A tag created on a commit that never reached `main` therefore ships
`main`'s version under the tag's name, and only npm notices:

```
npm error You cannot publish over the previously published versions: 1.15.0.
```

That is what happened on 31 October 2026: `v1.15.1` was tagged on
`feat/dod-lock-guard` while `main` still said `1.15.0`.

`scripts/check-release-version.mjs` now compares the two before `npm ci` and
before `npm publish`, and fails early with both versions and the fix:

```
Tag v1.15.1 menunjuk versi 1.15.1, tetapi package.json berisi 1.17.1. ...
Perbaikan: jalankan rilis dari main setelah versi package.json di-bump, lalu buat ulang tag.
```

Release from `main` after the version bump is committed, then tag that commit.

### No provenance

`--provenance` is intentionally **not** used. npm rejects provenance bundles
whose source repository is private:

```
422 Unprocessable Entity - Unsupported GitHub Actions source repository
visibility: "private". Only public source repositories are supported when
publishing with provenance.
```

This repository is private by policy, so provenance is unavailable. Consumers
cannot cryptographically verify which commit produced a published tarball.

### What ships in the package

`.npmignore` limits the tarball to the runtime server: about 60 files and 66 kB.
It excludes `.env*` (only `.env.example` ships), `.state/`, tests, CI config,
`web/`, and docs.

`scripts/install-husky.js` runs from `prepare`. It installs git hooks only when a
`.git` directory is present, so installing the package as a dependency does not
fail on husky.

---

## What this server prevents

- Committing without tests
- Committing with failing tests
- Committing without documentation
- Forgetting a workflow step
- Releasing without committing and pushing
- Committing another session's uncommitted work by accident
- Blocking a release because another session's work is deliberately left alone

---

## Committing when someone else is editing the same repo

`commit_and_push` stages the working tree, so pre-existing changes from another
session ride along into your commit — and once committed, they cannot be
separated from yours. Observed on 31 Oct 2026: two lines of another session's
`billing.yaml` landed in an unrelated commit, and a `devices.yaml` being edited
elsewhere nearly got overwritten.

The guard has three parts:

1. **`start_task` records a baseline** (`dirtyAtStart`): every path that was
   already dirty when the task began.
2. **`commit_and_push` refuses** when any of those paths is still dirty. Files
   that appear *during* the task are never blamed — there is no way to tell a
   new file of yours from a new file of theirs, and false accusations would get
   the check ignored.
3. **You choose explicitly**:

   ```jsonc
   // recommended: stage only what this task touched
   {"commitMessage": "fix: ...", "paths": ["src/app.js", "tests/app.test.js"]}

   // or, after verifying the other work belongs here
   {"commitMessage": "fix: ...", "includeForeign": true}
   ```

With `paths`, staging is `git add -- <paths>` instead of `git add .`, and any
file left unstaged is listed in the success message so it is not silently
forgotten.

Failure is closed, not open: the refusal happens *before* `git add`, so nothing
is staged and nothing is committed. Tasks started before this feature have no
baseline and keep the old behaviour.

Known limit: this catches work that was **already** dirty when the task started.
A file created by another session mid-task cannot be attributed, because git
records content, not authorship.

### What this means for `perform_release`

Release used to require a completely clean working tree, which was correct while
commits swept everything. Once `commit_and_push` deliberately *leaves* another
session's work unstaged, that rule would block every release — and its advice
("commit or stash all changes") would ask you to commit exactly what the guard
just refused.

So `perform_release` now distinguishes two kinds of dirt:

| Working tree contains | Release |
|---|---|
| only paths from `dirtyAtStart` | runs, and lists them as deliberately left alone |
| any path that is not in the baseline | refused, naming those files |

Without a baseline (tasks started before this feature) the old strict rule
applies: anything dirty blocks the release.

---

## Tips

1. Always start with `start_task` — it sets the intent for the session
2. Do not skip tests unless it is genuinely impossible — use `skip_tests` with a clear reason
3. Call `get_workflow_status` whenever you lose track of the phase
4. `run_full_workflow` is a shortcut for simple tasks where all the data is already known. Pass
   `dodEvidence` keyed by item id (`{ "dod-1": "npm test -> 533 pass" }`); without it the call refuses up front
   instead of stopping halfway with implementation, tests and docs already recorded but nothing committed
5. For docs-only work, use `skip_release` rather than forcing a release

---

## Troubleshooting

**`start_task` refuses because another session is working the same project.** A
second session on one working tree silently overwrites the first session's files.
Close the other OpenCode window, or give this session its own checkout with
`git worktree add <path> -b <branch>` and run it from there. The check ignores
locks with no heartbeat for 10 minutes, so a leftover MCP process does not block
you; `force: true` overrides it when you know the other session is idle.

**`ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'`** - dependencies are not
installed. Run `npm install` in the repo.

**`gyp ERR! find VS` on Windows** — the native module is compiling from source
because there is no prebuild for your Node ABI. Either switch to a Node version
that has one, or install Visual Studio Build Tools.

**`EPERM ... better_sqlite3.node`** - a running process holds the file. Stop it,
then reinstall.

**`commit_and_push` says "No changes detected" while the project clearly has
changes** - git ran in the wrong repository. The server used to fall back to its
own package directory, which is also a git repo, so commits landed there (or
nowhere) instead of in your project. It now refuses to run git in the package
repo and asks for the project explicitly.

Since 30 October 2026 the reliable fix is **per task**, not global. Pass
`projectDir` to `start_task`; the repo is pinned for that task and every later
git operation uses it:

```json
{
  "description": "Fix login redirect",
  "type": "bugfix",
  "projectDir": "D:\\code\\clinic",
  "definitionOfDone": ["redirect kembali ke halaman asal", "build lulus"]
}
```

`start_task` answers with `📁 Repo proyek: <path> (<source>)`, so the repo in use
is never a guess. `commit_and_push` repeats it on every response.

`WORKFLOW_PROJECT_DIR` still works as an operator-wide default and still wins
over the session directory, but it is one value for the whole server process.
When the session directory points at a *different* repo, `start_task` now
reports `⚠️ KONFLIK` and tells you to pass `projectDir` — previously that
mismatch was silent, which is how a commit landed in the wrong repo. Prefer
`projectDir`; keep the env var only for machines with a single project.

```bash
export WORKFLOW_PROJECT_DIR=/path/to/your/project
```

Point it at any directory inside the project; the repo root is discovered
upward. Non-git commands are unaffected. Full incident write-up:
[`docs/2026-10-30-project-dir-misrouting.md`](docs/2026-10-30-project-dir-misrouting.md).

**`perform_release`, `commit_and_push`, and `create_documentation` when changes are already committed/released** —
- `perform_release` inspects `HEAD` before running any release script. If `HEAD` already has a semver release tag (`git tag --points-at HEAD`) or a `chore(release): X.Y.Z` commit message (or `recordOnly: true` is passed), it records the release idempotently without re-running `npm run release`, and automatically satisfies `commitAndPushCompleted` when the working tree is clean.
- `commit_and_push` on a clean working tree verifies remote branch state via exact SHA, `git merge-base --is-ancestor`, and `git ls-remote --heads origin <branch>`, and automatically runs `git push origin <branch>` if `HEAD` has not yet been pushed.
- `create_documentation` and `check_ready_to_commit` accept documentation files already committed during the active task (`git log --since=<taskStartedAt>`) or in `HEAD` when the working tree is clean.
- `exec.js` closes child `stdin` immediately and cleans up inherited stdout/stderr pipes after direct child exit so Windows background grandchild processes cannot hang MCP tool calls.

**A task jumped straight to `done` after reporting `review`** - it was reported
twice. Factory treats the second report as approval. Current versions block that
at the client, but if it already happened, review the task and move it back to
`backlog` if the work is not accepted.

**OpenCode does not load the server** — check the config shape. V2 requires
`mcp.servers` and rejects `enabled`:

```bash
opencode mcp list          # should show: dev-workflow  connected
```

---

## Build

```bash
npm run build    # → dist/index.mjs (optimized bundle, used for npm distribution)
npm run web      # → dashboard on http://localhost:3000
```

For MCP use, point the client at `index.js` directly — startup is faster than the
bundled `dist/index.mjs`.

---

## Homelab Development Guide

This repository also documents the internal **programinglive** homelab: Tailscale
plus SSH across three machines (MMCH, HELLOWORLD, Mac).

| Document | Contents |
|---|---|
| [docs/homelab/README.md](./docs/homelab/README.md) | Overview and quick reference |
| [docs/homelab/infra-tailnet-ssh.md](./docs/homelab/infra-tailnet-ssh.md) | Tailnet and SSH setup |
| [docs/homelab/cli-tools.md](./docs/homelab/cli-tools.md) | CLI tools per machine |
| [docs/homelab/ci-runner.md](./docs/homelab/ci-runner.md) | Self-hosted CI runner on MMCH |
| [docs/homelab/security-rules.md](./docs/homelab/security-rules.md) | Security rules |
| [.agent/workflows/homelab-setup.md](./.agent/workflows/homelab-setup.md) | MCP workflow for onboarding a new machine |

> ⚠️ This repository is **private**. Do not share it publicly.

---

## License

MIT
