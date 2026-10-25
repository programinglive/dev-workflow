# Dev Workflow Enforcement Rules

## 🛑 MANDATORY MCP WORKFLOW DISCIPLINE

You are connected to the `dev-workflow` MCP server. **You MUST NOT perform any coding task, bug fix, or feature implementation without going through the strict workflow enforced by the dev-workflow MCP tools.**

### The Rule of Operation
Before taking any action or answering user requests regarding code changes, check your workflow status and follow these exact steps in sequence:

1. **Start Task**: Call `start_task` with a clear description and type (`feature`, `bugfix`, `refactor`, or `other`).
2. **Implement**: Write your code changes.
3. **Mark Fixed**: Call `mark_bug_fixed` with a summary of the implementation.
4. **Create Tests**: Create appropriate unit/integration tests covering your changes.
5. **Run Tests**: Execute your test suite and call `run_tests` with `passed: true` and the test command. **Never commit if tests fail!**
6. **Document**: Update documentation (README, PRD, release notes) and call `create_documentation`.
7. **Ready Check**: Call `check_ready_to_commit` to verify all steps.
8. **Commit & Push**: Call `commit_and_push` with a conventional commit message.
9. **Release**: Call `perform_release` with the release command (or `skip_release` if non-Node/docs-only).
10. **Complete**: Call `complete_task` to finish the session and reset the workflow.

### Quick Shortcuts
- If you have all information ready, you can use `run_full_workflow` to execute all steps safely in sequence.
- Use `get_workflow_status` at any time to check what step is next.

**Do not bypass these steps. The MCP server will block commits and releases if any required step is skipped.**
