-- Controller-to-monitor orphan attestations.
--
-- A machine controller is the only party that can inspect a process on its own
-- host. This table records what it reported, so the scheduler can act on
-- verified evidence instead of guessing from a heartbeat.
--
-- Additive and idempotent: safe to re-run, and existing rows are untouched.

CREATE TABLE IF NOT EXISTS reaper_attestations (
  id bigserial PRIMARY KEY,
  machine text NOT NULL,
  session_key text NOT NULL,
  project_name text NOT NULL,
  pid integer NOT NULL,
  process_started_at text NOT NULL,
  process_executable text NOT NULL,
  lease_owner text NOT NULL DEFAULT '',
  lease_generation integer NOT NULL DEFAULT 0,
  lease_fencing_token text NOT NULL DEFAULT '',
  verified_at timestamptz NOT NULL,
  nonce text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  outcome text NOT NULL DEFAULT 'pending'
);

-- A nonce is single-use per machine, so a captured request cannot be replayed.
CREATE UNIQUE INDEX IF NOT EXISTS reaper_attestations_machine_nonce
  ON reaper_attestations (machine, nonce);

-- The scheduler looks up the newest attestation for one session.
CREATE INDEX IF NOT EXISTS reaper_attestations_session
  ON reaper_attestations (session_key, machine, received_at DESC);
