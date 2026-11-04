# English guidance and Zettly task lifecycle

Goal: remind every connected AI to write implementation artifacts in English, and automatically track real workflow tasks in Zettly instead of relying on a manual report or retired journal store.

## Design

- A shared English implementation policy is included in MCP initialization instructions, the workflow prompt, and relevant tool responses. It covers new identifiers, comments, docstrings, test descriptions, developer documentation and commit messages. User conversation and explicitly localized product text may retain their requested locale. Existing unrelated files are not mass-translated.
- Zettly is the default task integration. Reuse the existing device-local authenticated Zettly configuration; do not copy credentials to the release server. A stable workflow task ID and the linked Todo ID are persisted in workflow state.
- `start_task` creates a Todo or links an explicit existing Todo. Repeated starts/continuations reuse the canonical task identity. Progress updates only the integration-owned description block, preserving user text, tags, checklist and other task fields.
- Successful completion marks the linked Todo complete and records one linked journal outcome. Forced closure/cancellation is described honestly without claiming unfinished work is complete. Terminal sync failures are retained in a durable state outbox across resets and can be retried with `sync_zettly_task`.
- The existing API has no server-side idempotency key. Persist creation intent before POST and reconcile by the canonical marker after an uncertain response; never blindly create again. Explicit existing Todo IDs support continuation across devices.
- API failures remain visible in tool output, with credentials redacted. They do not silently stop local development. Tests must disable production synchronization unless they explicitly use a mock client.

## Execution

- [ ] Reproduce missing initialization/start/status language policy and absent Todo integration.
- [ ] Add failing guidance and Zettly client/lifecycle tests; implement the shared policy, authenticated client and persisted sync state/outbox.
- [ ] Wire successful start/progress/completion and retry tool; verify rejected actions cannot create or close Todos.
- [ ] Run full tests and independent review. Document configuration, ownership, deduplication, outage behavior and rollout.
- [ ] Commit and publish one approved managed release; verify the three device clients consume it and receive English instructions.
- [ ] Verify the actual task and linked journal outcome in Zettly; record the checkpoint and close the monitor workflow.

## Constraints

Preserve the existing Factory workflow and unrelated session state. New source, comments, tests and documentation are written in English. Do not use heuristic language detection to claim that arbitrary code was proved English. Test delivery of the explicit policy and verify actual English source changes. No chat notifications, destructive task actions or credential values in logs.
