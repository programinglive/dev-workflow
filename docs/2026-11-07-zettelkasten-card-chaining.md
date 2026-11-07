# Zettelkasten Card Chaining in Dev Workflow Monitor

## Overview & Concept
When an AI chat session (in OpenCode, Codex, or AGY) transitions across multiple topics or tasks without starting a new chat thread, Dev Workflow Monitor now treats each topic transition as a new linked card (Zettelkasten slip-box chaining).

Instead of destructively overwriting previous task states or leaking previous build statuses (e.g., stale `tests_passed` or active build boxes), card chaining creates a distinct card for each task while maintaining bidirectional provenance links.

## Architecture

1. **Card Key Generation (`cardKeyFor`):**
   - Combines the base `sessionKey` with a slug of the current task description:
     `cardKey = ${sessionKey}::${cleanSlug(taskDescription)}`
   - Preserves backward compatibility when no task description is present.

2. **Parent Task & Provenance Tracking:**
   - On `start_task`, when the topic changes, `assignWorkflowIdentity` captures `parentTask`:
     `state.parentTask = { id: previous.workflowTaskId, description: previous.taskDescription, todoId: previous.zettly.todoId }`
   - `buildSnapshot` adds a `session_chain` relation with `relation: 'preceded_by'` and `label: parentTask.description`.

3. **Active Build Isolation:**
   - New cards start with `activeBuild: null`.
   - `liveBuildsBySession` is cleared whenever `activeBuild` is empty.
   - `dashboard.cjs` rejects historical build events whose timestamps are older than the active task's `started_at`, preventing stale builds from haunting new cards.

4. **Monitor UI Reference Badges:**
   - `renderTaskMetadata` formats `session_chain` relations as:
     `🔗 Lanjutan dari: "<Previous Task Title>"`
   - Previous cards transition to `phase: 'archived'` in PostgreSQL, keeping the active tab clean while preserving full audit history in the History tab.
