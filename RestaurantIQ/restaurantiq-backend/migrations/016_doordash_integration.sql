-- 016_doordash_integration.sql
-- Adds DoorDash as a first-class order source alongside Square (Sprint J).
--
-- The restaurants table already carries `doordash_store_id` (from the original
-- schema) and `delivery_connected`. What's missing is encrypted credential
-- storage that mirrors the Square pattern (square_access_token), plus the
-- fields needed to support an OAuth refresh / re-auth flow.
--
-- Forward migration:
--   1. doordash_access_token   — AES-GCM encrypted bearer token (see lib/tokenCrypto)
--   2. doordash_refresh_token  — AES-GCM encrypted refresh token (nullable; PAT-style
--                                connections won't have one)
--   3. doordash_token_expires_at — when the access token expires, so ingest can
--                                refresh proactively
--
-- orders.source and menu_items.source already allow 'doordash' (migration 006 /
-- 002), so no CHECK changes are needed here.
--
-- Idempotent so it can be re-run on a fresh database.

BEGIN;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS doordash_access_token TEXT;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS doordash_refresh_token TEXT;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS doordash_token_expires_at TIMESTAMPTZ;

COMMIT;
