#!/usr/bin/env node
'use strict';

/**
 * Remove junk session rows: no task, no session title, no project.
 *
 * OWNER INSTRUCTION (10 November 2026): a session with no title cannot be used
 * in a report, so treat it as junk, clean it, and make sure it does not happen
 * again.
 *
 * WHY A SEPARATE COMMAND RATHER THAN RETENTION
 * -------------------------------------------
 * Retention prunes by AGE, and only when PRUNE_ENABLED is on. Junk rows are
 * wrong from the moment they are written, not after 30 days, and the owner
 * asked for a cleanup that actually runs now. So this is explicit and bounded:
 * it deletes at most --limit rows per run and prints what it removed, so a
 * mistake is visible instead of silent.
 *
 * SAFETY
 * ------
 * - Only rows with an empty task, an empty title AND an empty task_id are
 *   matched. A card keeps its task_id when its task text is cleared on close,
 *   so a real card can never be deleted here.
 * - --dry-run prints the rows and deletes nothing.
 * - The URL and token come from the same environment the monitor uses.
 *
 * Usage:
 *   node monitor-server/cleanup-empty-sessions.cjs --dry-run
 *   node monitor-server/cleanup-empty-sessions.cjs --limit 500
 */
const { Client } = require('pg');
const { buildEmptySessionCleanup } = require('./empty-session.cjs');

function parseArgs(argv) {
  const args = { dryRun: false, limit: 500 };
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === '--dry-run') args.dryRun = true;
    else if (word === '--limit') {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.limit = value;
      i += 1;
    } else if (word === '--help') {
      args.help = true;
    }
  }
  return args;
}

/** The same rows the delete would take, so --dry-run is honest. */
function buildPreviewQuery({ limit }) {
  const { emptySessionPredicate } = require('./empty-session.cjs');
  return {
    sql: `SELECT session_key, machine, project_name, phase, updated_at
            FROM sessions
           WHERE ${emptySessionPredicate()}
             AND COALESCE(task_id, '') = ''
           ORDER BY updated_at ASC
           LIMIT $1`,
    params: [limit],
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: cleanup-empty-sessions [--dry-run] [--limit N]\n\n' +
        'Deletes session rows that have no task, no title and no task id.\n' +
        'These rows cannot appear in any report, so they are treated as junk.\n'
    );
    return 0;
  }

  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING || '';
  if (!connectionString) {
    process.stderr.write(
      'DATABASE_URL is not set; refusing to guess a database.\n' +
        'Export the same connection string the monitor uses.\n'
    );
    return 1;
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (args.dryRun) {
      const preview = buildPreviewQuery({ limit: args.limit });
      const rows = await client.query(preview.sql, preview.params);
      process.stdout.write(`DRY RUN: ${rows.rowCount} junk session rows would be deleted.\n`);
      for (const row of rows.rows) {
        process.stdout.write(
          `  ${row.session_key}  ${row.machine || '-'}  ${row.project_name || '-'}  ${row.phase || '-'}  ${row.updated_at}\n`
        );
      }
      return 0;
    }

    const { sql, params } = buildEmptySessionCleanup({ limit: args.limit });
    const result = await client.query(sql, params);
    process.stdout.write(`Deleted ${result.rowCount} junk session rows.\n`);
    for (const row of result.rows) {
      process.stdout.write(`  ${row.session_key}  ${row.machine || '-'}  ${row.project_name || '-'}\n`);
    }
    if (result.rowCount === args.limit) {
      process.stdout.write('Hit the limit; run again to continue.\n');
    }
    return 0;
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${String(error && error.message || error)}\n`);
    process.exitCode = 1;
  });
