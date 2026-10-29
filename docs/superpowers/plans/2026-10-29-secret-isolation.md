# Secret isolation implementation plan

Goal: incrementally enforce SecretReference knowledge without rebuilding the MCP.
Architecture: shared scanner and sanitizer with independent input, storage,
logging, configuration and output guards. Node ESM, existing node:test and SQL adapters.
Spec: ../../security-audit.md. Execute inline under the user's existing authorization;
do not pause for repeated phase approvals or modify another session's workflow state.

Global constraints: strict by default; no credential values in findings; preserve
existing successful workflow behavior; no production data changes or deployments.

Review focus: serialized JSON payloads, sensitive object keys, legacy SECRET
records formatted into text, asynchronous handler rejections, symlinked protected files.

- [x] Task 1: write and observe failing security primitives tests; implement
  references, scanner, recursive sanitizer, classification and file metadata guards.
- [x] Task 2: write and observe failing persistence/handler/exec tests; guard
  WorkflowState, SQLite/MySQL/Postgres, Factory, MCP results and async errors.
- [x] Task 3: implement and test scoped security_audit, runtime DB indirection,
  safe logs and HTTP boundaries; fail on unsafe auth defaults.
- [x] Task 4: update ignore/container/CI configuration and documentation; remove
  production environment template and inline credentials from usage examples.
- [x] Task 5: run security and existing tests, lint, build, review diff; record
  exact evidence, remaining risks and verified canonical journal entry.
