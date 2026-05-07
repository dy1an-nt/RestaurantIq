-- 010_alerts_dedup_key.sql
--
-- Adds a dedup_key column to alerts and a unique index on (restaurant_id, dedup_key).
-- This makes alert insertion idempotent — concurrent syncs that race past the
-- in-memory dedup check will hit a DB-level conflict instead of inserting a duplicate.
--
-- dedup_key format: "${type}|${menu_item_id ?? ''}|${monday-of-current-UTC-week}"
-- One alert of each type per item per week is the intended invariant.
--
-- Idempotent.

BEGIN;

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS dedup_key TEXT;

-- Backfill existing rows with their id so the NOT NULL constraint can be applied.
-- Existing rows predate this system and will never conflict with new ones.
UPDATE alerts SET dedup_key = id::text WHERE dedup_key IS NULL;

ALTER TABLE alerts ALTER COLUMN dedup_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS alerts_restaurant_dedup_key_idx
  ON alerts (restaurant_id, dedup_key);

COMMIT;
