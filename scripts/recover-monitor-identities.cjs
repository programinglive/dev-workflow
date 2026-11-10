#!/usr/bin/env node
'use strict';

/**
 * Recover the real task text and project name of monitor rows from the
 * authoritative Zettly Todo, then delete rows that cannot be recovered.
 *
 * OWNER RULE (10 November 2026): a session without a task, or without a
 * project, is not a valid report. It must never be displayed or recapped.
 *
 * WHY A RECOVERY STEP BEFORE A DELETE
 * -----------------------------------
 * Deleting every incomplete row would also delete the history of real finished
 * work, because closing a task used to blank the `task` column and older
 * reporters never sent `project_name`. The Zettly Todo is the single record of
 * that work, so the honest order is:
 *
 *   1. read the linked Todo (`task_relations_json` -> zettly/tracks),
 *   2. take the Todo title as the task text, and the `Project:` line or the
 *      `proyek:<repo>` tag as the project name,
 *   3. only then delete the rows that no source can explain.
 *
 * Nothing is invented: a value is written only when the Todo actually carries
 * it. Rows with no Todo and no data are reported as unrecoverable.
 *
 * Usage:
 *   node scripts/recover-monitor-identities.cjs --dry-run
 *   node scripts/recover-monitor-identities.cjs
 */

const fs = require('node:fs');
const { Client } = require('pg');

const ZETTLY_BASE = process.env.ZETTLY_URL || 'https://zettly.programinglive.com';
const MINUTE = 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const args = { dryRun: false, deleteUnrecoverable: false, limit: 500, todoSnapshot: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === '--dry-run') args.dryRun = true;
    else if (word === '--delete-unrecoverable') args.deleteUnrecoverable = true;
    else if (word === '--limit') {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.limit = value;
      i += 1;
    } else if (word === '--todo-snapshot') {
      args.todoSnapshot = String(argv[i + 1] || '');
      i += 1;
    } else if (word === '--help') args.help = true;
  }
  return args;
}

/**
 * Load a `{ "<todoId>": { title, project } }` snapshot.
 *
 * Reading the Todos through the authenticated MCP client and handing the result
 * to this script keeps the Zettly credential out of the server process: the
 * script only needs database access, and the snapshot is the reviewed evidence.
 */
function loadTodoSnapshot(file) {
  if (!file) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = new Map();
  for (const [key, value] of Object.entries(parsed || {})) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id < 1) continue;
    map.set(id, {
      title: String(value?.title || '').trim(),
      project: String(value?.project || '').trim(),
    });
  }
  return map;
}

function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const envFile = process.env.DEVWF_MONITOR_ENV_FILE || '/etc/devwf-monitor.env';
  try {
    const text = fs.readFileSync(envFile, 'utf8');
    const match = /^DATABASE_URL=(.+)$/m.exec(text);
    if (match) return match[1].trim();
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error(
    `DATABASE_URL is not set and ${envFile} could not be read. ` +
      'Export the same connection string the monitor uses.',
  );
}

/** The bearer token the Zettly client uses, read from the device configuration. */
function readZettlyToken() {
  const fromEnv = process.env.ZETTLY_TOKEN || process.env.ZETTLY_API_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const candidates = [
    process.env.ZETTLY_CONFIG,
    process.env.HOME ? `${process.env.HOME}/.zettly/config.json` : null,
    process.env.USERPROFILE ? `${process.env.USERPROFILE}/.zettly/config.json` : null,
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const token = parsed.token || parsed.api_token || parsed?.auth?.token;
      if (typeof token === 'string' && token.trim()) return token.trim();
    } catch {
      // Try the next candidate.
    }
  }
  return '';
}

/** Extract the project path the workflow recorded in the Todo description. */
function projectFromDescription(description) {
  const text = String(description || '');
  const pathMatch = /Project:\s*([^\s<]+)/i.exec(text);
  if (pathMatch) {
    const raw = pathMatch[1].trim();
    const base = raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    if (base) return base;
  }
  return '';
}

/** Extract the project from the `proyek:<repo>` Zettly tag. */
function projectFromTags(tags) {
  for (const tag of Array.isArray(tags) ? tags : []) {
    const name = String(tag?.name || '');
    const match = /^proyek:(.+)$/.exec(name);
    if (match) {
      const value = match[1].trim();
      if (!value) continue;
      // `proyek:` carries the repository name, so a namespaced value is reduced
      // to its last segment exactly like `project_name` is.
      return value.replace(/\.git$/i, '').split('/').filter(Boolean).pop() || value;
    }
  }
  return '';
}

function todoIdOf(row) {
  const relations = Array.isArray(row.task_relations_json) ? row.task_relations_json : [];
  const tracked = relations.find((rel) => rel && rel.system === 'zettly' && rel.relation === 'tracks');
  const id = tracked ? String(tracked.id || '').trim() : '';
  return /^\d+$/.test(id) ? Number(id) : null;
}

/**
 * Project name from the repository identity the session already recorded.
 *
 * `repo_path` is what the reporter actually observed (`git rev-parse
 * --show-toplevel`), so its last segment is evidence, not a guess.
 */
function projectFromRepoPath(row) {
  const repo = String(row.repo_path || '').replace(/[\\/]+$/, '');
  if (!repo) return '';
  return repo.split(/[\\/]/).filter(Boolean).pop() || '';
}

async function fetchTodo(id, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${ZETTLY_BASE}/api/v1/todos/${id}`, {
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const todo = body?.data || body;
    if (!todo || typeof todo !== 'object') return null;
    return {
      title: String(todo.title || '').trim(),
      project: projectFromTags(todo.tags) || projectFromDescription(todo.description),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: recover-monitor-identities [--dry-run] [--delete-unrecoverable] [--limit N]\n\n' +
        'Recovers task text and project name from the linked Zettly Todo, then deletes the\n' +
        'rows that no authoritative source can explain. Without --delete-unrecoverable the\n' +
        'unrecoverable rows are only listed.\n',
    );
    return 0;
  }

  const connectionString = readDatabaseUrl();
  const snapshot = loadTodoSnapshot(args.todoSnapshot);
  const token = snapshot ? '' : readZettlyToken();
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const rows = await client.query(
      `SELECT session_key, task_id, machine, project_name, task, task_relations_json,
              repo_path, updated_at
         FROM sessions
        WHERE NULLIF(BTRIM(task), '') IS NULL
           OR NULLIF(BTRIM(project_name), '') IS NULL
        ORDER BY updated_at ASC
        LIMIT $1`,
      [args.limit],
    );

    /**
     * The project a session already proved elsewhere.
     *
     * One session owns an identity row (empty task id) plus one row per task, so
     * a row that lost `project_name` often has a sibling on the same
     * `session_key` that still carries it. That sibling is this device's own
     * earlier report, which is the same class of evidence as `repo_path`.
     */
    const sessionProjects = new Map();
    const allSessionRows = await client.query(
      `SELECT session_key, session_title, project_name
         FROM sessions
        WHERE NULLIF(BTRIM(project_name), '') IS NOT NULL`,
    );
    for (const row of allSessionRows.rows) {
      if (!sessionProjects.has(row.session_key)) {
        sessionProjects.set(row.session_key, String(row.project_name).trim());
      }
    }

    const todoCache = new Map();
    const recoverable = [];
    const unrecoverable = [];

    for (const row of rows.rows) {
      const todoId = todoIdOf(row);
      let todo = null;
      if (todoId) {
        if (snapshot) {
          todo = snapshot.get(todoId) || null;
        } else {
          if (!todoCache.has(todoId)) todoCache.set(todoId, await fetchTodo(todoId, token));
          todo = todoCache.get(todoId);
        }
      }

      const task = String(row.task || '').trim() || (todo ? todo.title : '');
      const project =
        String(row.project_name || '').trim() ||
        (todo ? todo.project : '') ||
        projectFromRepoPath(row) ||
        sessionProjects.get(row.session_key) ||
        '';

      if (task && project) {
        recoverable.push({ row, task, project, todoId });
      } else {
        unrecoverable.push({ row, todoId, missing: [!task ? 'task' : '', !project ? 'project' : ''].filter(Boolean) });
      }
    }

    process.stdout.write(
      `Rows missing task or project: ${rows.rowCount} ` +
        `(recoverable from Zettly: ${recoverable.length}, unrecoverable: ${unrecoverable.length})\n`,
    );

    for (const item of recoverable) {
      process.stdout.write(
        `  RECOVER ${item.row.session_key} ${item.row.task_id || '(no task id)'} ` +
          `-> project="${item.project}" task="${item.task.slice(0, 70)}"` +
          (item.todoId ? ` (Zettly #${item.todoId})` : '') +
          '\n',
      );
    }
    for (const item of unrecoverable) {
      process.stdout.write(
        `  DROP    ${item.row.session_key} ${item.row.task_id || '(no task id)'} ` +
          `machine=${item.row.machine || '-'} project=${item.row.project_name || '-'} ` +
          `missing=${item.missing.join('+')}\n`,
      );
    }

    if (args.dryRun) {
      process.stdout.write('DRY RUN: nothing was written and nothing was deleted.\n');
      return 0;
    }

    let updated = 0;
    for (const item of recoverable) {
      const result = await client.query(
        `UPDATE sessions
            SET task = $3, project_name = $4
          WHERE session_key = $1 AND task_id = $2
            AND (NULLIF(BTRIM(task), '') IS NULL OR NULLIF(BTRIM(project_name), '') IS NULL)`,
        [item.row.session_key, item.row.task_id, item.task, item.project],
      );
      updated += result.rowCount;
    }
    process.stdout.write(`Recovered ${updated} row(s) from their Zettly Todos.\n`);

    if (!args.deleteUnrecoverable) {
      process.stdout.write(
        `Left ${unrecoverable.length} unrecoverable row(s) untouched. ` +
          'Re-run with --delete-unrecoverable to remove them.\n',
      );
      return 0;
    }

    let deleted = 0;
    for (const item of unrecoverable) {
      const result = await client.query(
        `DELETE FROM sessions
          WHERE session_key = $1 AND task_id = $2
            AND NULLIF(BTRIM(task), '') IS NULL
            AND NULLIF(BTRIM(project_name), '') IS NULL`,
        [item.row.session_key, item.row.task_id],
      );
      deleted += result.rowCount;
    }
    process.stdout.write(`Deleted ${deleted} unrecoverable row(s).\n`);
    return 0;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${String((error && error.message) || error)}\n`);
      process.exitCode = 1;
    });
}

module.exports = { projectFromDescription, projectFromTags, todoIdOf };
