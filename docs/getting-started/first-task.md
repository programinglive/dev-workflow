# Your First Governed Task

Once DevWorkflow is installed and connected to your AI coding client, every coding task follows an enforced local-first lifecycle:

```text
start_task -> create_feature_flow -> refine_with_ai -> implement -> create_tests -> run_tests -> create_documentation -> check_ready_to_commit -> commit_and_push -> perform_release / skip_release -> complete_task
```

## Step 1: Verify Your Environment

```bash
devwf doctor
```

## Step 2: Start a Task in Your AI Client

Ask your MCP-connected AI client (Claude Code, Codex, OpenCode, or Antigravity) to start a task:

> "Start a DevWorkflow task for adding input validation to `src/validator.js`, record the Mermaid flow, write tests first, and verify before committing."

The client calls `start_task` with:
- `description` (English task summary)
- `type` (`feature`, `bugfix`, `refactor`, or `other`)
- `projectDir` (absolute path to your Git repository)
- `definitionOfDone` (concrete verifiable acceptance criteria)
- `plan` (ordered steps)

## Step 3: Code Audit & Safe Fixes

Before committing, your agent can run the built-in DevWorkflow V2.0 audit tools:
- `audit_standards` — validate repository engineering standards
- `audit_changes` — inspect modified files for security, database, architecture, and quality violations
- `helper_apply_safe_fix` — apply deterministic `AF-0`/`AF-1` fixes with automatic snapshot rollback on verification failure

## Step 4: Verify & Complete

After tests pass and documentation is updated, the agent runs `check_ready_to_commit`, `commit_and_push`, `perform_release` (or `skip_release`), and `complete_task`. All task history is stored locally in SQLite WAL.
