# Focus-first development

Use one Zettly focus to describe the current outcome. Tasks are concrete units inside that outcome. Complete the tasks and save their evidence, close the focus, then select the next focus.

## Tools and ownership

- `get_current_focus`: returns the authenticated owner and its active focus across all dates. Multiple active records are reported as a conflict.
- `set_focus`: creates a focus only if none is active. Repeating the exact existing title reuses it; another title cannot replace unfinished work.
- `link_task_to_focus`: links the active canonical Todo and local workflow to the active focus. It preserves owner text, the original source and existing service relations.
- `complete_focus`: requires concrete evidence, a finished local workflow and at least one linked Todo, all completed. It records the reason through Zettly's completion API and verifies the resulting state. It never creates the next focus automatically.

Every tool accepts `expectedOwnerId`. Use it when comparing a browser session with MCP: an account mismatch stops operations before task data is changed. These tools do not migrate ownership, rotate credentials or silently merge accounts.

```sh
node index.js call get_current_focus --args '{"expectedOwnerId":42}'
node index.js call set_focus --args '{"title":"Verify existing Sentry fixes","expectedOwnerId":42}'
node index.js call start_task --args '{"description":"Verify the deployed fix","type":"bugfix","focusId":7,"requireFocus":true,"expectedOwnerId":42,"definitionOfDone":["Regression and deployment evidence verified"],"plan":["Reproduce and verify the existing fix"]}'
node index.js call link_task_to_focus --args '{"focusId":7,"expectedOwnerId":42}'
```

Finish the normal workflow and verify its Zettly outcome before calling:

```sh
node index.js call complete_focus --args '{"focusId":7,"expectedOwnerId":42,"evidence":"Regression tests passed and the affected deployed revision was verified."}'
```

## Task guards and compatibility

`start_task` and `claim_factory_task` accept `focusId`, `requireFocus` and `expectedOwnerId`. The guard runs before resetting or claiming work. An accepted start automatically links its resulting canonical Todo. A rejected Factory claim never changes the previous task's focus.

Set `DEVWF_REQUIRE_FOCUS=1` in the managed private launcher environment to require focus for every new start or claim. Per-call `requireFocus:true` works without that setting. Existing unlinked tasks remain able to finish; the rollout does not retroactively assign their scope. Initialization instructions and task/status guidance tell every agent to check focus first.

Focus linkage uses an integration-owned marker outside the existing Dev Workflow block in the Todo description. Only a verified current canonical Todo produces a focus relation on the monitor. A task relink suppresses stale metadata. The destination opens Zettly's actual dashboard because the existing `/focus` route returns JSON rather than a focus detail page.

## Evidence and concurrency limits

Reads and writes are bounded. Malformed/foreign focus rows, an incomplete Todo scan, failed local persistence and observed concurrent changes produce explicit errors. Provider exception bodies are not returned.

The current Zettly API has no transactional compare-and-swap across clients. These tools re-read after writes and expose observed conflicts; they do not claim atomic coordination with another browser or device. If completion races with newly linked work, inspect the returned conflict and source records before creating another focus. A server-side atomic lifecycle endpoint is needed for a stronger global guarantee.

Source descriptions remain untrusted context. A completed Todo or supplied evidence string is not independent proof that a physical deployment succeeded: the agent must still run the relevant checks before reporting completion.
