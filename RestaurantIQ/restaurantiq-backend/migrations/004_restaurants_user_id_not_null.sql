-- 004_restaurants_user_id_not_null.sql
-- Promote restaurants.user_id from nullable → NOT NULL now that every existing
-- row has been claimed by an auth user (see migration 003 + the manual claim
-- step in the README). This locks in the multi-tenant invariant: a restaurant
-- without an owner is impossible at the schema level, not just by convention.
--
-- This migration WILL FAIL if any row still has user_id IS NULL. That's the
-- correct behavior — fix the data, then re-run.

BEGIN;

-- Defensive: surface unclaimed rows with a clearer message than Postgres'
-- generic "column contains null values".
DO $$
DECLARE
  unclaimed INT;
BEGIN
  SELECT COUNT(*) INTO unclaimed FROM restaurants WHERE user_id IS NULL;
  IF unclaimed > 0 THEN
    RAISE EXCEPTION '% restaurants still have user_id IS NULL — claim them before running this migration', unclaimed;
  END IF;
END $$;

ALTER TABLE restaurants
  ALTER COLUMN user_id SET NOT NULL;

COMMIT;
