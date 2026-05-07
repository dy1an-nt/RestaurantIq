-- 007_order_items_fks.sql
-- The dashboard's daily_summaries refresh used to issue a Supabase nested
-- embed: `orders ( ..., order_items ( ... ) )`. PostgREST resolves embeds
-- through real FK constraints. If `order_items.order_id` and
-- `order_items.menu_item_id` are bare uuid columns with no FK, the embed
-- silently returns empty arrays and the dashboard ends up with $0 / 0 orders
-- per item even though the row inserts succeeded.
--
-- Backend has been refactored to do a two-step fetch instead, so the embed
-- bug can't recur. We still want the FKs for referential integrity and
-- cascade-on-delete behavior.
--
-- Idempotent.

BEGIN;

-- 1. order_items.order_id → orders.id
ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_order_id_fkey;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_order_id_fkey
  FOREIGN KEY (order_id)
  REFERENCES orders(id)
  ON DELETE CASCADE;

-- 2. order_items.menu_item_id → menu_items.id
-- SET NULL on delete: removing a menu item shouldn't nuke historical orders.
ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_menu_item_id_fkey;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_menu_item_id_fkey
  FOREIGN KEY (menu_item_id)
  REFERENCES menu_items(id)
  ON DELETE SET NULL;

-- 3. Helpful indexes for the join the refresh now does by hand.
CREATE INDEX IF NOT EXISTS order_items_order_id_idx
  ON order_items (order_id);

CREATE INDEX IF NOT EXISTS order_items_menu_item_id_idx
  ON order_items (menu_item_id);

COMMIT;
