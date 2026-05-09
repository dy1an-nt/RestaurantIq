-- 012_alerts_list_index.sql
--
-- Adds a two-column index optimized for the GET /api/alerts list query, which
-- filters by restaurant_id and orders by created_at DESC.
--
-- Why a new index: migration 009 created alerts_restaurant_type_item_created_idx
-- covering (restaurant_id, type, menu_item_id, created_at DESC). That index
-- serves deduplication lookups well (they filter on all four columns) but is
-- suboptimal for the simple list query that filters only on restaurant_id —
-- Postgres must scan more index pages because type and menu_item_id are
-- interleaved before created_at. A dedicated two-column index on
-- (restaurant_id, created_at DESC) directly matches the list query's access
-- pattern, giving the planner a tight index scan over exactly the rows it needs.
--
-- Idempotent.

BEGIN;

CREATE INDEX IF NOT EXISTS alerts_restaurant_created_idx
  ON alerts (restaurant_id, created_at DESC);

COMMIT;
