-- Primary-key swap: one card per (session_key, task_id) instead of one row
-- per session.
--
-- Standalone on purpose: it is safe whether 001 ran, was skipped, or only
-- partially applied. Every step guards itself, and a second run is a no-op
-- rather than an error.
--
-- Deployment order (see docs/card-chaining.md):
--   1. copy the unified monitor files into /opt/devwf-monitor (old files .bak)
--   2. run this migration as the table owner (one transaction)
--   3. restart devwf-monitor
-- The code swap and the key swap happen while the service is stopped, so the
-- old upsert never runs against the new key and the new upsert never runs
-- against the old one: no ingest window is broken.
--
-- Rollback is intentionally manual: drop the composite key, delete the extra
-- card rows (WHERE task_id <> ''), and restore PRIMARY KEY (session_key).

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_id text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_task_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_task_title text;

-- The current primary key is discovered rather than assumed: it is named
-- sessions_pkey on a fresh database but may differ on a restored one. The
-- lookup is scoped to the current schema: the same database can hold a
-- `sessions` table for another purpose, and dropping that one instead would
-- leave this table without any key.
--
-- Only swap when the key is NOT already the composite one. If 001 already
-- performed the swap this whole block is a quiet no-op.
DO $$
DECLARE
  pk_name text;
  pk_def text;
BEGIN
  SELECT con.conname INTO pk_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
   WHERE rel.relname = 'sessions'
     AND nsp.nspname = current_schema()
     AND con.contype = 'p'
   LIMIT 1;

  IF pk_name IS NOT NULL THEN
    SELECT pg_get_constraintdef(con.oid) INTO pk_def
      FROM pg_constraint con
     WHERE con.conname = pk_name;

    IF pk_def IS DISTINCT FROM 'PRIMARY KEY (session_key, task_id)' THEN
      EXECUTE format('ALTER TABLE sessions DROP CONSTRAINT %I', pk_name);
      ALTER TABLE sessions ADD PRIMARY KEY (session_key, task_id);
    END IF;
  END IF;
END $$;

-- The chain label "continued from" is looked up through the parent id, so
-- the index keeps that direction cheap on both the active and history tabs.
CREATE INDEX IF NOT EXISTS sessions_parent_task_idx
  ON sessions (session_key, parent_task_id);
