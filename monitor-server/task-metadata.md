# Task provenance on the monitor

Reporters may send `workflowTaskId`, `taskOrigin` and `taskRelations` alongside
the existing session snapshot. Origin is the initial source of the work and
accepts `zettly`, `factory`, `sentry`, `manual` or `unknown`. Relations describe
associated Zettly Todos, Factory tasks and Sentry issues without changing that
source. Each record carries its actual ID, label and HTTP(S) resource URL;
relations also carry a short relation description. Use the known Factory board
URL when no task detail route exists. The monitor never invents detail routes.

Cards, session detail and history show Source separately from Relations. Missing
legacy provenance displays Unknown, even if an automatically created Zettly Todo
exists. Completed snapshots preserve the last known origin and relations when
the sender omits them. A different nonempty workflow ID or task title clears
stale metadata before accepting the new task's records. Empty relation lists in
sparse updates preserve known records; explicit unlinking is not represented by
this reporting contract.

Records are bounded to 64 relations, 200 characters for IDs/labels/workflow IDs
and 80 characters for relation descriptions. Only known systems are accepted.
Duplicate system/ID/relation tuples are collapsed. HTTP(S) URLs must be at most
2048 characters and contain no credentials, query, fragment or whitespace.
Rejected URLs retain the visible service ID without a link. Both the ingestion
path and browser use the same validator, and display text is HTML escaped.

## Rolling deployment

1. Back up the current deployment and apply `task-metadata-migration.sql` to the
   monitor PostgreSQL database using its existing authenticated operations path.
   This additive, idempotent migration supplies defaults for existing rows.
2. Update `task-metadata.cjs`, `session-upsert.cjs`, `sessions-query.cjs` and
   `history-query.cjs` together. Surgically integrate the renderer import,
   browser function injection, metadata elements/calls and anchor click guards
   from `dashboard.cjs` into the deployed dashboard. Preserve its custom layout.
3. Deploy updated reporters after the monitor accepts the metadata fields. Old
   reporters remain compatible and do not erase same-task metadata when sparse.
4. Verify one task with a known origin, multiple cross-service relations, a
   sparse completion and the resulting history/detail display. Keep meaningful
   task filtering and active task counts unchanged.

The monitor does not run this migration automatically. New readers/writers
require it before startup. Older monitor builds tolerate the additional columns;
rolling back code does not require dropping columns. Old upsert code cannot
clear metadata when switching tasks, so return to the new writer promptly if old
writers must temporarily run after migration. No public share projection adds
these internal relation records.

Offline regression: `node --test tests/monitor-task-relations.test.js`. This
executes the real upsert conditions in an in-memory SQLite database with only
PostgreSQL casts and clock/min/max calls adapted, plus the served browser script
with a DOM boundary fixture. PostgreSQL coverage is also available in
`tests/monitor-upsert-behavior.test.js` against a configured disposable test
database; do not point its test connection at production.
