# English implementation and automatic Zettly tracking

Dev Workflow delivers an explicit English implementation rule during MCP initialization, in the workflow prompt, and in `start_task`, status, implementation, documentation and commit-check responses. New identifiers, comments, docstrings, test descriptions, developer documentation and commit messages use English. The user's conversation language and explicitly localized product text remain independent. Existing unrelated files are not translated automatically.

The rule is an instruction to the AI, not a claim that a natural-language detector has proved every arbitrary source file English. The regression suite validates that real MCP clients receive the rule and that the new implementation and documentation are English.

## Automatic task lifecycle

`start_task` persists a canonical workflow identity before synchronization. By default it creates a Zettly Todo, or links the positive `zettlyTodoId` supplied by the caller. A continuation should reuse that Todo ID; `taskId` can preserve a known canonical workflow identity. Repeated starts for the same active task and project retain their identity and link.

Progress updates an integration-owned block in the Todo description with the project, phase, plan and definition of done. Owner text outside that block, the title of an existing Todo, tags, priority and checklist are preserved. Successful workflow completion marks the Todo complete and records a linked Zettly journal outcome containing evidence, commit and next actions. Cancellation and forced closure record their actual status and keep unfinished Todos incomplete.

The state records the Todo ID and account identity. Terminal sync work is persisted in `zettlyOutbox` before a local reset. `sync_zettly_task` retries pending work; status requests also retry pending terminal work. A resumed successful completion supersedes an earlier pending forced closure with the latest verified snapshot.

## AI session index in the Todo

A closed session takes its conversation with it. To make the work findable again, the integration-owned block now carries an `AI sessions` section built from `state.aiSessions` (`ai-sessions.js`):

```
ses_e4b3f3805ffeiua93K1Cq0VIgc · opencode · HELLOWORLD · "Fix POS deploy" · resumable
proc-67a1a335-... · codex · MMCH · "Handover" · tidak bisa di-resume (proses)
```

Each `save()` upserts the current session (deduplicated by key, newest first, capped at 10), so a handover across sessions keeps every participant. `startedAt` is preserved from the first report; `lastSeenAt` follows the latest one.

Only OpenCode session keys (`ses_...`) can be resumed, with `opencode --session <id>`. Codex and Antigravity report a per-process key (`proc-...`) that identifies the monitor card but no resumable conversation; those lines say so explicitly instead of pretending otherwise. The same list is written to the Zettly journal outcome, so the trail survives completion.

## Credentials and account ownership

Credentials remain on each device. They are never copied to the central release host, logged, placed in a repository, or embedded in MCP client JSON.

1. An explicit `ZETTLY_API_TOKEN` can select the authenticated owner.
2. Windows uses the existing Zettly CLI DPAPI store at `~/.zettly/token.dpapi`.
3. A configured Mac owner credential uses the login Keychain. Its nonsecret metadata lives in `~/.zettly/config.json`, under `managedOwnerCredential` with `source: macos-keychain`, a service/account name and `expectedUserId`.
4. Existing machine-local configuration is a fallback only when explicitly selected or checked against an expected owner. The historical `DailyActivityJournal/config.env` path is only a credential source; no tasks or outcomes are written to the retired application. Its token may belong to an ingestion service account, so an unverified legacy file is not automatically used for owner tasks.

`ZETTLY_EXPECTED_USER_ID` or `managedOwnerCredential.expectedUserId` checks `/api/v1/user` before any mutation. A mismatch stops writes before task content is sent. An inaccessible configured protected credential does not silently select a different service account. Missing credentials and API failures are visible as pending synchronization in tool responses.

`ZETTLY_API_BASE` selects the instance; `DEVWF_ZETTLY_CONFIG` can point to an existing local config file. `DEVWF_ZETTLY_SYNC=0` disables external synchronization for deliberate diagnostics. Test workers disable production synchronization unless a test explicitly injects its own mock client.

## Retries and duplicate prevention

The current Zettly Todo API does not provide a server-side idempotency endpoint. The integration saves creation intent before POST and reconciles by an exact canonical marker after an uncertain response. If no matching Todo can be verified after an uncertain creation, it remains pending instead of blindly issuing another POST. Link the existing Todo explicitly when reconciling such a case.

Linked outcomes use the complete canonical ID, terminal status and Todo ID. A `task-1` marker cannot match `task-10`. Local persistence conflicts stop remote writes; a successful save that adopts another state object also stops the stale synchronizer. For concurrent cross-device work, link the existing Todo explicitly rather than having independent clients create tasks from the same human description.

Use the managed central release workflow to promote a verified runtime once. New connections on HELLOWORLD, MMCH and Mac consume it automatically. Existing processes must reconnect to load new instructions and tool definitions; no task is hot-swapped while running.
