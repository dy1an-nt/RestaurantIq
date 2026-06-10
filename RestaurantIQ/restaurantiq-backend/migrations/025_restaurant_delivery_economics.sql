-- 025_restaurant_delivery_economics.sql
--
-- Adds per-restaurant DoorDash commission configuration, required for the
-- cross-channel margin feature (Sprint Q). The backend uses these values to
-- compute each item's "delivery tax" — the portion of delivery revenue
-- consumed by the platform commission before the operator sees it.
--
-- doordash_commission_bps:
--   Commission rate in basis points (1 bp = 0.01%). Default 2000 = 20%.
--   Allowed range [0, 5000] (0% to 50%).
--
-- doordash_flat_fee_cents:
--   Per-order flat fee in integer cents. Default 0.
--   Allowed range [0, 2000] (up to $20.00 per order).
--
-- Both columns are NOT NULL with defaults so existing rows are automatically
-- populated and no migration data-fill is needed.
--
-- Idempotent: uses DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT so re-running
-- against an already-migrated schema is a no-op.

BEGIN;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS doordash_commission_bps integer NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS doordash_flat_fee_cents integer NOT NULL DEFAULT 0;

-- Drop any pre-existing version of these constraints before (re)adding them,
-- so the migration is safe to re-run (idempotent).
ALTER TABLE restaurants
  DROP CONSTRAINT IF EXISTS restaurants_doordash_commission_bps_check;

ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_doordash_commission_bps_check
  CHECK (doordash_commission_bps >= 0 AND doordash_commission_bps <= 5000);

ALTER TABLE restaurants
  DROP CONSTRAINT IF EXISTS restaurants_doordash_flat_fee_cents_check;

ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_doordash_flat_fee_cents_check
  CHECK (doordash_flat_fee_cents >= 0 AND doordash_flat_fee_cents <= 2000);

COMMIT;
