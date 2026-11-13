-- Zettelkasten card chaining: one card per task instead of one row per session.
--
-- Safe to run more than once. Safe on a live table: the three columns are
-- added first, existing rows get task_id = '' (the old single-card identity),
-- and only then is the primary key swapped for the composite one the upsert
-- now conflicts on.
--
-- Run with: node scripts/migrate-monitor-db.cjs   (inside a transaction)
--
-- Rollback is intentionally manual: dropping the composite key and restoring
-- PRIMARY KEY (session_key) requires deleting the extra card rows first.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_id text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_task_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_task_title text;

-- The old primary key is discovered rather than assumed: it is named
-- sessions_pkey on a fresh database but may differ on a restored one. The
-- lookup is scoped to the current schema: the same database can hold a
-- `sessions` table for another purpose, and dropping that one instead would
-- leave this table without any key.
DO $$
DECLARE
  pk_name text;
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
    EXECUTE format('ALTER TABLE sessions DROP CONSTRAINT IF EXISTS %I', pk_name);
  END IF;
END $$;

-- Only add the composite key when it is not already there, so a second run is
-- a no-op instead of an error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE rel.relname = 'sessions'
       AND nsp.nspname = current_schema()
       AND con.contype = 'p'
       AND pg_get_constraintdef(con.oid) = 'PRIMARY KEY (session_key, task_id)'
  ) THEN
    ALTER TABLE sessions ADD PRIMARY KEY (session_key, task_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sessions_parent_task_idx
  ON sessions (session_key, parent_task_id);
