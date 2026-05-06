-- 002_square_integration.sql
-- Replaces Toast as the primary POS integration with Square.
--
-- Forward migration:
--   1. Rename restaurants.toast_guid -> restaurants.square_location_id
--   2. Add restaurants.square_access_token (per-tenant OAuth/PAT token)
--      NOTE: production should encrypt at rest (pgcrypto / Vault). Plain text for dev only.
--   3. Drop the existing source CHECK on menu_items (if any) and add one that includes 'square'
--
-- Idempotent so it can be re-run on a fresh sandbox.

BEGIN;

-- 1. restaurants.toast_guid -> square_location_id
ALTER TABLE restaurants
  RENAME COLUMN toast_guid TO square_location_id;

-- 2. per-restaurant Square access token (sandbox PAT or OAuth bearer)
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS square_access_token TEXT;

-- 3. menu_items.source — drop old constraint, re-add with 'square' allowed
ALTER TABLE menu_items
  DROP CONSTRAINT IF EXISTS menu_items_source_check;

ALTER TABLE menu_items
  ADD CONSTRAINT menu_items_source_check
  CHECK (source IN ('toast', 'doordash', 'manual', 'square'));

-- Optional: enforce uniqueness on (restaurant_id, source, external_id) for upserts.
-- Left commented because external_id is not yet on the schema. Add when wiring sync.
-- ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS external_id TEXT;
-- CREATE UNIQUE INDEX IF NOT EXISTS menu_items_restaurant_source_external_idx
--   ON menu_items (restaurant_id, source, external_id);

COMMIT;
