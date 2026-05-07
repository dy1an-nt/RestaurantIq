-- 005_menu_items_external_id.sql
-- Adds menu_items.external_id so we can dedupe upserts against the source POS's
-- own ID (e.g. Square catalog item id) instead of matching on `name`. Without
-- this column the Square ingest fails because the normalizer always sets it.
--
-- Forward migration:
--   1. Add nullable external_id (manual rows have none)
--   2. Unique index on (restaurant_id, source, external_id) — partial, so
--      multiple manual rows with NULL external_id remain allowed
--
-- Idempotent.

BEGIN;

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS external_id TEXT;

-- Partial unique index: only enforce uniqueness when external_id is present.
-- Lets manual rows (external_id IS NULL) coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS menu_items_restaurant_source_external_idx
  ON menu_items (restaurant_id, source, external_id)
  WHERE external_id IS NOT NULL;

COMMIT;
