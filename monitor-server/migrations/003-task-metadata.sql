-- Task-metadata columns of the f2ac45d monitor model, made part of the
-- tracked schema for fresh installs.
--
-- One card carries the identity of the task it belongs to
-- (workflow_task_id), where that task came from (task_origin_json), service
-- links created for it (task_relations_json), and the repository it worked
-- in (repo_path, repo_remote). The repository pair is also self-healed at
-- boot by the dashboard's ensureSessionRepositoryColumns, so on the running
-- database this file is usually a quiet no-op.
--
-- Every statement is additive and idempotent. There is deliberately no
-- BEGIN/COMMIT here: the runner (scripts/migrate-monitor-db.cjs) applies all
-- migration files inside a single transaction of its own, and a nested
-- transaction statement would abort the whole run.
--
-- The standalone file task-metadata-migration.sql at the top level of this
-- directory holds the original three-column DDL with an explicit
-- transaction, for direct `psql -f` use; the two repository columns were
-- added later by the dashboard's boot helper on the running database.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow_task_id text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_origin_json jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_relations_json jsonb NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repo_path text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repo_remote text NOT NULL DEFAULT '';
