-- 017_square_token_refresh.sql
-- Adds Square OAuth refresh-token bookkeeping so access tokens (which expire
-- after ~30 days) can be refreshed automatically instead of forcing operators
-- to manually reconnect (Sprint K).
--
-- Context: migration 002 added restaurants.square_access_token. What's missing
-- is the refresh token + expiry needed for the proactive refresh flow — this
-- mirrors the DoorDash columns added in 016.
--
-- Columns added (all nullable, all IF NOT EXISTS so this is safe to re-run):
--   1. square_refresh_token     — AES-GCM encrypted refresh token (nullable;
--      sandbox PAT-style tokens won't have one)
--   2. square_token_expires_at  — when the access token expires, so ingest can
--      proactively refresh before calling the Square API
--
-- Idempotent so it can be re-run on a fresh database.

BEGIN;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS square_refresh_token TEXT;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS square_token_expires_at TIMESTAMPTZ;

COMMIT;
