# Troubleshooting MCP Connections

## Client shows `dev-workflow` as failed or disconnected
1. Verify the binary starts cleanly:
   ```bash
   devwf --version
   devwf doctor
   ```
2. Ensure no stray debug output is written to `stdout` (MCP stdio reserves `stdout` strictly for JSON-RPC frames).
3. Restart your AI client completely after updating `@programinglive/dev-workflow`.

## Project Lock Refusal (`PROJECT_OWNERSHIP_LOST` or active lock)
If another AI session owns the same repository directory, create an isolated Git worktree (`git worktree add ../repo-task -b feat/task`) and point `projectDir` to the worktree instead of bypassing the lock.
