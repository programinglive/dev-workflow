'use strict';

/**
 * One definition of a junk session, used everywhere.
 *
 * OWNER INSTRUCTION (10 November 2026)
 * ------------------------------------
 * "A session without a title does not need to be recorded because it cannot be
 * used in a report; treat it as junk, clean it, and make sure it does not
 * happen again."
 *
 * RULE
 * ----
 * A session is junk when it has NEITHER a task NOR a session title. Those rows
 * say only "some process reported", which no recap, history entry or report can
 * use. A session with EITHER field is real work and must be kept: a card that
 * only has a title is still a card somebody can recognise.
 *
 * WHY A SHARED PREDICATE AND NOT A COPY PER QUERY
 * -----------------------------------------------
 * Recap, history and the active list all answer "is this session worth a row?".
 * If each one spells the condition out, they drift apart: one keeps the junk and
 * the other hides it, and the owner sees a session in recap that is missing from
 * history. The predicate lives here and every query imports it.
 */

/**
 * SQL fragment: true when the session HAS something worth reporting.
 *
 * Written for the `sessions` table, on the raw columns, so it can be dropped
 * into a WHERE clause without aliases.
 */
function worthReportingPredicate() {
  return `(
    NULLIF(BTRIM(task), '') IS NOT NULL
    AND NULLIF(BTRIM(project_name), '') IS NOT NULL
  )`;
}

/**
 * SQL fragment: true when the session is junk (missing task OR missing project_name).
 *
 * The complement of {@link worthReportingPredicate}. Both are offered so a
 * caller can write WHERE instead of a negation it might get wrong.
 */
function emptySessionPredicate() {
  return `(
    NULLIF(BTRIM(task), '') IS NULL
    OR NULLIF(BTRIM(project_name), '') IS NULL
  )`;
}

/**
 * The cleanup statement for rows already stored.
 *
 * Bounded on purpose: a single run deletes at most `limit` rows so an
 * accidental match cannot empty the table in one shot. Re-running is safe and
 * simply continues where the last run stopped.
 *
 * Any row missing `task` or `project_name` is removed because a session without
 * a task or without a project cannot appear in any valid report or recap.
 *
 * @param {{ limit?: number, olderThanMinutes?: number }} options
 * @returns {{ sql: string, params: Array }}
 */
function buildEmptySessionCleanup({ limit = 500, olderThanMinutes = 0 } = {}) {
  const bounded = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(5000, Math.floor(Number(limit)))
    : 500;
  const age = Number.isFinite(Number(olderThanMinutes)) && Number(olderThanMinutes) > 0
    ? Math.floor(Number(olderThanMinutes))
    : 0;

  return {
    sql: `DELETE FROM sessions
            WHERE (session_key, task_id) IN (
              SELECT session_key, task_id
                FROM sessions
               WHERE ${emptySessionPredicate()}
                 AND updated_at < now() - ($1::text || ' minutes')::interval
               ORDER BY updated_at ASC
               LIMIT $2
            )
        RETURNING session_key, machine, project_name`,
    params: [String(age), bounded],
  };
}

/**
 * Decides whether a report may CREATE a session row.
 *
 * The rule is "must have BOTH a non-empty task AND a non-empty project when
 * creating a new row". Everything about it is decided from data, so it is
 * testable without a database:
 *
 * - `body` is the report.
 * - `hasRow` says whether this (session_key, task_id) already exists.
 *
 * A sparse report for an existing row returns false (do not skip) because
 * closing a task sends an empty task and empty project on purpose while the
 * database COALESCE guards preserve the existing task and project_name. A first
 * report missing either task or project returns true (skip) because a card
 * without a task or without a project cannot appear in any report.
 *
 * @param {object} body
 * @param {boolean} hasRow
 * @returns {boolean} true when the row must NOT be created
 */
function shouldSkipCreate(body = {}, hasRow = false) {
  if (hasRow) return false;
  const b = body || {};
  const hasTask = String(b.task || '').trim() !== '';
  const hasProject =
    String(b.projectName || '').trim() !== '' ||
    String(b.projectPath || '').trim() !== '';
  return !(hasTask && hasProject);
}

module.exports = {
  worthReportingPredicate,
  emptySessionPredicate,
  buildEmptySessionCleanup,
  shouldSkipCreate,
};
