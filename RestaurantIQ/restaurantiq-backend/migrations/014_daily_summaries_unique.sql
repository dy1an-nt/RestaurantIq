-- 014_daily_summaries_unique.sql
-- Add a UNIQUE constraint on (restaurant_id, menu_item_id, date) so that
-- refreshDailySummaries can safely upsert instead of delete+insert.
-- With upsert, old data is preserved if the insert step fails — eliminating
-- the data-loss window that exists when DELETE succeeds but INSERT fails.
--
-- Postgres treats NULL as distinct in UNIQUE constraints, so multiple rows
-- with menu_item_id IS NULL on different dates (orphaned by ON DELETE SET NULL)
-- coexist safely.
-- Idempotent.

BEGIN;

ALTER TABLE daily_summaries
  DROP CONSTRAINT IF EXISTS daily_summaries_restaurant_item_date_key;

ALTER TABLE daily_summaries
  ADD CONSTRAINT daily_summaries_restaurant_item_date_key
  UNIQUE (restaurant_id, menu_item_id, date);

COMMIT;
