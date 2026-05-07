-- 008_menu_items_unique_constraint.sql
-- Migration 005 added a PARTIAL unique index (WHERE external_id IS NOT NULL).
-- PostgREST/Supabase's upsert API translates `onConflict: '...'` to
-- `ON CONFLICT (cols)` without the partial-index WHERE predicate, so the
-- planner can't match the partial index and the upsert errors with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- Fix: drop the partial index, add a regular UNIQUE constraint on the same
-- triple. In Postgres, NULLs are considered distinct in unique constraints by
-- default, so multiple manual rows with external_id IS NULL still coexist.
--
-- Idempotent.

BEGIN;

DROP INDEX IF EXISTS menu_items_restaurant_source_external_idx;

ALTER TABLE menu_items
  DROP CONSTRAINT IF EXISTS menu_items_restaurant_source_external_key;

ALTER TABLE menu_items
  ADD CONSTRAINT menu_items_restaurant_source_external_key
  UNIQUE (restaurant_id, source, external_id);

COMMIT;
