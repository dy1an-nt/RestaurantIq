-- 013_restaurants_user_id_unique.sql
-- Add a UNIQUE constraint on restaurants.user_id to enforce one restaurant
-- per auth user. Prevents a double-create (network retry, double-click) from
-- producing two restaurant rows and breaking .single() lookups in every
-- analytics/insights/marketing route.
-- Idempotent.

BEGIN;

ALTER TABLE restaurants
  DROP CONSTRAINT IF EXISTS restaurants_user_id_key;

ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_user_id_key UNIQUE (user_id);

COMMIT;
