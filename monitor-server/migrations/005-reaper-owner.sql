-- Process-owner metadata for the session reaper.
--
-- The public /api/sessions payload must not expose these columns. They are
-- returned only by the privileged /api/reaper/sessions endpoint, which is
-- authenticated with an HMAC signature and replay protection.
--
-- Backward compatible: every column has a default, so existing rows and older
-- publishers keep working. A row that predates this migration has an empty
-- owner_started_at / owner_executable and is classified RECOVERY_REQUIRED by
-- the reaper until it reports again.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_started_at text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_executable text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_owner text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_generation integer NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_fencing_token text NOT NULL DEFAULT '';
