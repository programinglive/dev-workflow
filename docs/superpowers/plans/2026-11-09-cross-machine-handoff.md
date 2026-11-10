# Cross-Machine Task Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any machine write a verifiable checkpoint of the current task into its Zettly Todo, adopt another machine's checkpoint, record a handoff with a mandatory reason, and detect it on return.

**Architecture:** The Zettly Todo stays the single record. `blockFor()` gains one machine-readable element so new fields survive `mergeBlock()`. A dedicated reader parses that element from the raw description (never through `zettly-context.js`, which strips the block). SSH carries one fixed command with an explicit session key. Revert data is recorded, never executed.

**Tech Stack:** Node ESM, `node:test` runner, existing Zettly client (`zettly-client.js`), existing SSH pattern from `managed/rollout.cjs`, MCP tool definitions in `tools/definitions.js`.

**Spec:** `docs/superpowers/specs/2026-11-09-cross-machine-handoff-design.md`

## Global Constraints

- Identifiers, comments, docstrings, test names, and commit messages in English. Messages shown to the owner may be Indonesian.
- Never let `zettly-context.js` touch checkpoint parsing: it strips `dev-workflow` regions and truncates at 4000 characters.
- A checkpoint write is only successful when the element is read back from Zettly and matches.
- `sanitize()` JSON-parses any string starting with `{` or `[`; encode summaries before passing them through it.
- SSH runs one fixed command with an explicit session key. Never a free-form shell string.
- No automatic revert anywhere in this plan. Detect and report only.
- Run `npm test` before each commit; a red suite stops the task.

## Review Focus

1. **A checkpoint written while the state is empty.** If `start_task` was never called, `checkpoint_task` must refuse rather than write a Todo with no task text that later looks authoritative.
2. **A handoff whose receiving machine never starts.** The source must stay resumable; a handoff that silently freezes a machine would strand the task.
3. **Two machines adopting the same checkpoint.** The second adoption must be refused visibly, not merged.
4. **A commit list that contains someone else's commit.** Revert data must exclude commits whose author is not this session's identity.
5. **A machine name that resolves to nothing.** `from: "Mac"` where the SSH alias is `mac` must ask, not silently pick the local machine.

---

### Task 1: Machine-readable checkpoint element

**Files:**
- Modify: `zettly-workflow.js:81-89` (`blockFor`)
- Create: `tools/handler-modules/checkpoint-block.js`
- Test: `tests/checkpoint-block.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `renderCheckpointElement(workflowTaskId: string, payload: CheckpointPayload): string` and `parseCheckpointElement(description: string): CheckpointPayload | null`, where `CheckpointPayload = { machine, checkpointedAt, summary, baseSha, commits: string[], handover: {from,to,reason,at,sessionKey} | null }`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCheckpointElement, parseCheckpointElement } from "../tools/handler-modules/checkpoint-block.js";

test("a rendered checkpoint element round-trips", () => {
  const payload = { machine: "Mac", checkpointedAt: "2026-11-09T10:00:00.000Z", summary: "closed the runner work", baseSha: "a".repeat(40), commits: ["b".repeat(40)], handover: null };
  const html = renderCheckpointElement("wf-1", payload);
  assert.deepEqual(parseCheckpointElement(`<p>before</p>${html}<p>after</p>`), payload);
});

test("a description without the element yields null", () => {
  assert.equal(parseCheckpointElement("<p>plain</p>"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/checkpoint-block.test.js`
Expected: FAIL, `Cannot find module .../checkpoint-block.js`

- [ ] **Step 3: Implement the two functions in `tools/handler-modules/checkpoint-block.js`**

`renderCheckpointElement` returns `<script type="application/json" data-dev-workflow-state="<id>">{json}</script>` with `JSON.stringify` of the payload (escape `</script` occurrences as `<\/script`). `parseCheckpointElement` matches that element by regex on the `data-dev-workflow-state` attribute, takes the inner text, and returns `JSON.parse` inside a try/catch that returns `null` on failure. Do not sanitize on read: the value is data, not instructions.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/checkpoint-block.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Call it from `blockFor`**

In `zettly-workflow.js`, after the closing `</section>` prefix is built, append `renderCheckpointElement(id, buildCheckpointPayload(state))`. `buildCheckpointPayload(state)` lives in the same module and reads `state.machine`, `state.checkpoint?.checkpointedAt`, `state.checkpoint?.summary`, `state.checkpoint?.baseSha`, `state.checkpoint?.commits`, `state.checkpoint?.handover`, defaulting each to `null`/`[]` when absent. Add the `import` at the top.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. Existing block tests must still pass — the element is additive.

- [ ] **Step 7: Commit**

```bash
git add zettly-workflow.js tools/handler-modules/checkpoint-block.js tests/checkpoint-block.test.js
git commit -m "feat(checkpoint): add a machine-readable checkpoint element to the Zettly block"
```

---

### Task 2: Record `machine` and `baseSha` in state

**Files:**
- Modify: `workflow-state.js:1205-1245` (state defaults)
- Modify: `tools/handler-modules/workflow-handlers.js` (`start_task` around line 311)
- Test: `tests/checkpoint-state.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `state.machine: string`, `state.checkpoint: { checkpointedAt: string|null, summary: string, baseSha: string|null, commits: string[], handover: object|null }`.

- [ ] **Step 1: Write the failing test**

```js
test("start_task records the machine and the base commit", async () => {
  const state = await startTaskInTempRepo({ machine: "Mac" });
  assert.equal(state.machine, "Mac");
  assert.match(state.checkpoint.baseSha, /^[a-f0-9]{40}$/);
});

test("checkpoint defaults are present before any checkpoint is written", () => {
  const state = freshWorkflowState().state;
  assert.equal(state.checkpoint.summary, "");
  assert.deepEqual(state.checkpoint.commits, []);
  assert.equal(state.checkpoint.handover, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/checkpoint-state.test.js`
Expected: FAIL, `state.checkpoint` is undefined.

- [ ] **Step 3: Add the defaults and the two writes**

Add `checkpoint` and `machine` to the defaults object in `workflow-state.js`. In `start_task`, set `state.machine = String(env.DEVWF_MACHINE || os.hostname())` and `state.checkpoint.baseSha = await git(["-C", projectDir, "rev-parse", "HEAD"]).stdout.trim()` when the directory is a git repo; leave `null` otherwise.

- [ ] **Step 4: Run tests**

Run: `node --test tests/checkpoint-state.test.js` then `npm test`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add workflow-state.js tools/handler-modules/workflow-handlers.js tests/checkpoint-state.test.js
git commit -m "feat(checkpoint): record the owning machine and base commit at start_task"
```

---

### Task 3: `checkpoint_task` writes and proves it

**Files:**
- Modify: `tools/definitions.js` (new tool entry)
- Modify: `tools/handler-modules/index.js` (dispatch case + add to `syncTools`)
- Create: `tools/handler-modules/checkpoint-handlers.js`
- Test: `tests/checkpoint-task.test.js`

**Interfaces:**
- Consumes: `renderCheckpointElement`, `parseCheckpointElement` from Task 1; `state.checkpoint` from Task 2.
- Produces: `handleCheckpointTask(args: { summary?: string }, context): Promise<{ ok: boolean, confirmed: boolean, note: string }>`.

- [ ] **Step 1: Write the failing test**

```js
test("checkpoint_task refuses when no task was started", async () => {
  const result = await handleCheckpointTask({ summary: "x" }, { workflowState: emptyState() });
  assert.equal(result.ok, false);
  assert.match(result.note, /no task/i);
});

test("checkpoint_task reports confirmed only after reading the element back", async () => {
  const result = await handleCheckpointTask({ summary: "half done" }, { workflowState: stateWithTask(), fetchImpl: fakeZettly({ confirm: true }) });
  assert.equal(result.confirmed, true);
});

test("checkpoint_task reports unconfirmed when the element is not readable back", async () => {
  const result = await handleCheckpointTask({ summary: "half done" }, { workflowState: stateWithTask(), fetchImpl: fakeZettly({ confirm: false }) });
  assert.equal(result.confirmed, false);
  assert.match(result.note, /not confirmed/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/checkpoint-task.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `handleCheckpointTask`**

Guard on `state.taskDescription`; when empty return `{ok:false, note:"No task has been started; nothing to checkpoint."}`. Compute `commits` as `git rev-list <baseSha>..HEAD` filtered by the author identity from `git config user.email`. Write `checkpointedAt`/`summary`/`commits` into `state.checkpoint`, then call `syncZettlyTask(workflowState, { force: true })` — `force` bypasses the `lastPayloadHash` short-circuit from the spec's constraints. Then `GET /todos/<id>`, `parseCheckpointElement(description)`, and compare `checkpointedAt`. Return `confirmed:true` only on an exact match; otherwise `confirmed:false` with a note naming what was missing.

- [ ] **Step 4: Register the tool**

Add the definition with `summary` (optional string) and a description that says it writes a checkpoint and verifies it. Add `checkpoint_task` to the `syncTools` set and a dispatch case.

- [ ] **Step 5: Run tests**

Run: `node --test tests/checkpoint-task.test.js` then `npm test`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add tools/definitions.js tools/handler-modules/index.js tools/handler-modules/checkpoint-handlers.js tests/checkpoint-task.test.js
git commit -m "feat(checkpoint): add checkpoint_task with read-back confirmation"
```

---

### Task 4: Handoff record and refusal on return

**Files:**
- Modify: `tools/handler-modules/checkpoint-handlers.js`
- Modify: `tools/handler-modules/workflow-handlers.js` (`get_current_focus`, `start_task`)
- Test: `tests/handoff-refusal.test.js`

**Interfaces:**
- Consumes: `handleCheckpointTask`, `state.checkpoint.handover`.
- Produces: `handleHandoffTask(args: { to: string, reason: string }, context)`; `handoffGuard(state): { handedOver: boolean, to?: string, reason?: string }`.

- [ ] **Step 1: Write the failing test**

```js
test("a handoff without a reason is refused", async () => {
  const result = await handleHandoffTask({ to: "MMCH", reason: "" }, contextWithTask());
  assert.equal(result.ok, false);
  assert.match(result.note, /reason/i);
});

test("a session whose task was handed over refuses to continue", async () => {
  const state = stateWithTask();
  state.checkpoint.handover = { from: "Mac", to: "MMCH", reason: "laptop left behind", at: "2026-11-09T10:00:00.000Z", sessionKey: "ses_x" };
  const result = await handleStartTask({ description: "again", projectDir: "/tmp" }, { workflowState: withState(state) });
  assert.equal(result.ok, false);
  assert.match(result.note, /handed over to MMCH/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/handoff-refusal.test.js`
Expected: FAIL, `handleHandoffTask` not exported.

- [ ] **Step 3: Implement the record and the guard**

`handleHandoffTask` requires a non-empty `reason` and a `to` that differs from `state.machine`; writes `state.checkpoint.handover`, then calls `handleCheckpointTask` and returns its result. `handoffGuard` returns the recorded handover or `{handedOver:false}`. Call it at the top of `start_task` and `get_current_focus`; when handed over, return `{ok:false, note:"This task was handed over to <to> by <from> at <at>. Reason: <reason>. Resume locally with acknowledge_handover."}`.

- [ ] **Step 4: Add `acknowledge_handover`**

A tool that clears `state.checkpoint.handover` only after recording the acknowledgement into `state.checkpoint.summary` (so it is not silently forgotten), and only when called explicitly.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/handoff-refusal.test.js` then `npm test`
Expected: PASS both.

```bash
git add tools/handler-modules/checkpoint-handlers.js tools/handler-modules/workflow-handlers.js tools/definitions.js tests/handoff-refusal.test.js
git commit -m "feat(handoff): record a handoff with a reason and refuse silent continuation"
```

---

### Task 5: Fetch a checkpoint from another machine over SSH

**Files:**
- Create: `tools/handler-modules/remote-checkpoint.js`
- Modify: `tools/definitions.js`, `tools/handler-modules/index.js`
- Test: `tests/remote-checkpoint.test.js`

**Interfaces:**
- Consumes: `state.checkpoint` shape from Task 2; `list_active_sessions` output for machine discovery.
- Produces: `resolveMachineAlias(name: string, aliases: Record<string,string>): string | null`; `handleFetchTask(args: { from?: string, reason?: string }, context)`.

- [ ] **Step 1: Write the failing test**

```js
test("an unknown machine name resolves to null instead of the local machine", () => {
  assert.equal(resolveMachineAlias("Nope", { mac: "mac", mmch: "mmch" }), null);
});

test("a name differing only in case resolves to its alias", () => {
  assert.equal(resolveMachineAlias("Mac", { mac: "mac" }), "mac");
});

test("the SSH command carries the explicit session key", () => {
  const { args } = buildRemoteCheckpointCommand({ alias: "mac", sessionKey: "ses_abc", nodePath: "/usr/bin/node" });
  assert.ok(args.join(" ").includes("ses_abc"));
  assert.ok(args.includes("checkpoint"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-checkpoint.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the helpers**

`resolveMachineAlias` lowercases and matches exactly; returns `null` on no match. `buildRemoteCheckpointCommand` returns `{ command: "ssh", args: ["-o","BatchMode=yes", alias, nodePath, ".../index.js", "call", "checkpoint_task", "--session", sessionKey] }` — absolute `nodePath` because a non-interactive shell has no PATH, as `managed/rollout.cjs` already proves.

- [ ] **Step 4: Implement `handleFetchTask`**

When `from` is absent or is the local machine, run `handleCheckpointTask` locally. Otherwise resolve the alias (return an error naming the available machines when it is `null`), run the SSH command with a 120 s timeout, and on failure offer the checkpoint already in Zettly and require `reason`. On success, adopt the payload into this session's `state.checkpoint` and stamp `handover` on the source by calling `handleHandoffTask` locally.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/remote-checkpoint.test.js` then `npm test`
Expected: PASS both.

```bash
git add tools/handler-modules/remote-checkpoint.js tools/definitions.js tools/handler-modules/index.js tests/remote-checkpoint.test.js
git commit -m "feat(handoff): fetch a checkpoint from another machine over SSH"
```

---

### Task 6: Revert record with refusals

**Files:**
- Modify: `tools/handler-modules/checkpoint-handlers.js`
- Test: `tests/revert-record.test.js`

**Interfaces:**
- Consumes: `state.checkpoint.commits`, `state.checkpoint.baseSha`.
- Produces: `planRevert({ state, git }): { candidates: string[], refused: Array<{sha: string, why: string}>, dirty: string[] }`.

- [ ] **Step 1: Write the failing test**

```js
test("a commit that is not in the checkpoint is refused", async () => {
  const plan = await planRevert({ state: withCommits(["a".repeat(40)]), git: fakeGit({ remoteContains: ["b".repeat(40)] }) });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.refused.length, 0);
});

test("a commit already pushed to the default branch is refused", async () => {
  const sha = "a".repeat(40);
  const plan = await planRevert({ state: withCommits([sha]), git: fakeGit({ remoteContains: [sha] }) });
  assert.equal(plan.refused[0].why, "already on the remote default branch");
});

test("a dirty tree is reported, never cleaned", async () => {
  const plan = await planRevert({ state: withCommits([]), git: fakeGit({ dirty: [" M app.js"] }) });
  assert.deepEqual(plan.dirty, [" M app.js"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/revert-record.test.js`
Expected: FAIL, `planRevert` not exported.

- [ ] **Step 3: Implement `planRevert`**

For each sha in `state.checkpoint.commits`: refuse when `git branch -r --contains <sha>` names the default branch, refuse when `git show -s --format=%ae <sha>` is not this session's identity, otherwise keep as a candidate. Collect `git status --porcelain` into `dirty`. Never run `reset`, `clean`, or `checkout`.

- [ ] **Step 4: Expose it read-only through `checkpoint_task`**

Add a `showRevertPlan: boolean` argument that appends the plan to the checkpoint note. No new tool that acts on it.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/revert-record.test.js` then `npm test`
Expected: PASS both.

```bash
git add tools/handler-modules/checkpoint-handlers.js tests/revert-record.test.js
git commit -m "feat(checkpoint): produce a bounded revert record and refuse unsafe candidates"
```

---

### Task 7: Document the workflow for the next agent

**Files:**
- Modify: `README.md`
- Test: `tests/checkpoint-readme.test.js` (create)

**Interfaces:**
- Consumes: all tools above.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the README documents checkpoint_task and fetch_task", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.ok(readme.includes("checkpoint_task"));
  assert.ok(readme.includes("fetch_task"));
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `node --test tests/checkpoint-readme.test.js`
Expected: FAIL.

- [ ] **Step 3: Document the loop**

Add a section: when to checkpoint, how to fetch from another machine, that a handoff needs a reason, what the returning machine will refuse, and that revert is recorded but never automatic.

- [ ] **Step 4: Run `npm test` and commit**

```bash
git add README.md tests/checkpoint-readme.test.js
git commit -m "docs: describe the checkpoint and handoff workflow"
```
