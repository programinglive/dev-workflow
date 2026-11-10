-- Tool versions per session, so the monitor can show whether every device has
-- the same required tools (gh, glab, wrangler, gcloud, node, npm).
--
-- Stored as jsonb rather than one column per tool: the required list changes
-- over time, and a new tool must not need a migration. The value is bounded by
-- the writer (at most 20 entries, each truncated).
--
-- Safe to run more than once.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS toolchain_json jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The parity view reads the newest row per machine, so the index keeps that
-- lookup cheap as the table grows.
CREATE INDEX IF NOT EXISTS sessions_machine_updated_idx
  ON sessions (machine, updated_at DESC);
