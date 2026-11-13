-- Additive migration: apply before updating monitor writers/readers.
-- Older reporters and older dashboard builds can continue using sessions.
BEGIN;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow_task_id TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_origin_json JSONB NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_relations_json JSONB NOT NULL DEFAULT '[]';
COMMIT;
