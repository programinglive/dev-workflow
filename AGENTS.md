# Dev Workflow Enforcement Rules

## 🛑 MANDATORY MCP WORKFLOW DISCIPLINE

You are connected to the `dev-workflow` MCP server. **You MUST NOT perform any coding task, bug fix, or feature implementation without going through the strict workflow enforced by the dev-workflow MCP tools.**

### The Rule of Operation
Before taking any action or answering user requests regarding code changes, check your workflow status and follow these exact steps in sequence:

1. **Start Task**: Call `start_task` with a clear description, type (`feature`, `bugfix`, `refactor`, or `other`), `projectDir`, **and a `definitionOfDone` checklist**. Every task must say, up front, which concrete conditions must be true before it counts as finished.
2. **Implement**: Write your code changes.
3. **Mark Fixed**: Call `mark_bug_fixed` with a summary of the implementation.
4. **Prove the Definition of Done**: For each item, call `mark_dod_item` with `evidence` (5-500 characters naming what you actually ran or checked, e.g. `npm test -> 505 pass`). An item that turned out not to apply is excluded with `waive_dod_item` and a written reason - never silently dropped.
5. **Create Tests**: Create appropriate unit/integration tests covering your changes.
6. **Run Tests**: Execute your test suite and call `run_tests` with `passed: true` and the test command. **Never commit if tests fail!**
7. **Document**: Update documentation (README, PRD, release notes) and call `create_documentation`.
8. **Ready Check**: Call `check_ready_to_commit` to verify all steps. It fails while any definition-of-done item is still open.
9. **Commit & Push**: Call `commit_and_push` with a conventional commit message. It refuses while any item is open.

   If the repo also contains another session's uncommitted work, `commit_and_push`
   refuses to stage the whole tree. Pass `paths` with only the files this task
   touched (recommended), or `includeForeign: true` after verifying that work
   belongs in this commit. Never resolve it by overwriting the other session's
   files.
10. **Release**: Call `perform_release` with the release command (or `skip_release` if non-Node/docs-only).
11. **Complete**: Call `complete_task` to finish the session and reset the workflow. It refuses while any item is open, and records `dodSummary` in history.

### Definition of Done

`start_task` **requires** `definitionOfDone`: 1-20 items, each 3-300 characters, no duplicates. The workflow will not let you commit or close a task while an item is still open.

- `mark_dod_item { id, evidence }` proves an item. Re-marking a proven item refreshes its evidence.
- `waive_dod_item { id, reason }` excludes an item with a written reason. A proven item cannot be waived.
- `set_definition_of_done { items, append }` fills the checklist of a task started before this rule existed. Replacing a list that already has proven items is refused unless `append: true`.
- When new working changes appear after a commit, `dodRevision` goes up and previously proven items must be re-confirmed against the code that is actually being committed. Waivers survive.

`force_complete_task` remains the audited escape hatch: it records `forced: true` with your reason and the DoD summary.

### Quick Shortcuts
- If you have all information ready, you can use `run_full_workflow` to execute all steps safely in sequence.
- Use `get_workflow_status` at any time to check what step is next.

**Do not bypass these steps. The MCP server will block commits and releases if any required step is skipped.**
