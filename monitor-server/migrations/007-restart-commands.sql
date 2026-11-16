-- Restart command queue for the Monitor-to-controller channel.
--
-- The Monitor plans a restart; the machine controller executes it. This table
-- is the durable channel between them. A command is polled by the controller
-- that owns the machine, executed locally, and reported back once.
--
-- Additive and idempotent: safe to re-run, and existing rows are untouched.

CREATE TABLE IF NOT EXISTS restart_commands (
  id bigserial PRIMARY KEY,
  machine text NOT NULL,
  session_key text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  result_code text,
  result_detail jsonb
);

-- One open command per (machine, session, mode): a repeated Restart All cannot
-- queue the same target twice while the first is still pending.
CREATE UNIQUE INDEX IF NOT EXISTS restart_commands_open_unique
  ON restart_commands (machine, session_key, mode)
  WHERE status = 'pending';

-- The controller polls this direction.
CREATE INDEX IF NOT EXISTS restart_commands_pending
  ON restart_commands (machine, status, created_at);

-- The Monitor shows the history for one session.
CREATE INDEX IF NOT EXISTS restart_commands_session
  ON restart_commands (session_key, created_at DESC);
