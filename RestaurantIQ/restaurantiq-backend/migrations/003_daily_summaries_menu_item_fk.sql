-- 003_daily_summaries_menu_item_fk.sql
-- Documents the FK required for Supabase embed joins:
--   daily_summaries.menu_item_id → menu_items.id
--
-- Without this constraint, `.select('menu_items(name, category)')` in the
-- insights route silently returns null for all item names.
--
-- ON DELETE SET NULL preserves historical aggregate numbers even when a
-- menu item is later removed, rather than cascading a delete of revenue history.
--
-- NOTE: this constraint was created directly in Supabase before this migration
-- was written. The DO block is a no-op if it already exists.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'daily_summaries_menu_item_id_fkey'
      AND table_name      = 'daily_summaries'
  ) THEN
    ALTER TABLE daily_summaries
      ADD CONSTRAINT daily_summaries_menu_item_id_fkey
      FOREIGN KEY (menu_item_id)
      REFERENCES menu_items (id)
      ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
