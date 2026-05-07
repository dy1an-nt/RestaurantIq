-- 009_alerts_engine.sql
--
-- Extends the alerts table with the columns required by the alerts engine:
-- severity, title, message, and metadata. These were missing from the initial
-- schema (which only had id, restaurant_id, menu_item_id, type, is_read,
-- created_at). Also adds a covering index to support deduplication lookups
-- and the GET /api/alerts list query.

BEGIN;

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info'
  CHECK (severity IN ('info', 'warning', 'critical'));

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS message TEXT NOT NULL DEFAULT '';

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- Supports deduplication (restaurant_id + type + menu_item_id window query)
-- and the default list order (created_at DESC) used by GET /api/alerts.
CREATE INDEX IF NOT EXISTS alerts_restaurant_type_item_created_idx
  ON alerts (restaurant_id, type, menu_item_id, created_at DESC);

COMMIT;
