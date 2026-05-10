-- 015_orders_external_id.sql
-- Add external_id (Square order UUID) to orders table.
-- Enables reliable deduplication on re-sync: match by external_id rather
-- than the fragile (ordered_at, total_cents) collision check that silently
-- drops legitimate duplicate-total orders placed at the same timestamp.
-- Idempotent.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS external_id TEXT;

CREATE INDEX IF NOT EXISTS orders_restaurant_external_id_idx
  ON orders (restaurant_id, external_id)
  WHERE external_id IS NOT NULL;

COMMIT;
