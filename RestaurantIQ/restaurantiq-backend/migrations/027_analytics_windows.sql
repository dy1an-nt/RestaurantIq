-- 027_analytics_windows.sql
-- Support selectable analytics windows (7 / 30 / 90 days).
BEGIN;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS summaries_covered_from date;

COMMENT ON COLUMN restaurants.summaries_covered_from IS
  'Earliest date for which daily_summaries is complete. NULL = unknown; the next sync performs a one-time full-window recompute and sets this.';

CREATE INDEX IF NOT EXISTS daily_summaries_restaurant_date_idx
  ON daily_summaries (restaurant_id, date);

CREATE INDEX IF NOT EXISTS orders_restaurant_ordered_at_idx
  ON orders (restaurant_id, ordered_at);

COMMIT;
