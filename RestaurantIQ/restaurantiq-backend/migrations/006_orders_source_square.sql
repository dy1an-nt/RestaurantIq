-- 006_orders_source_square.sql
-- Migration 002 added 'square' to menu_items.source CHECK but missed orders.source.
-- This fixes that gap so Square ingestion can write order rows.
--
-- Idempotent.

BEGIN;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_source_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_source_check
  CHECK (source IN ('toast', 'doordash', 'manual', 'square'));

COMMIT;
