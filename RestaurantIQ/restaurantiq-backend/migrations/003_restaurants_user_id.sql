-- 003_restaurants_user_id.sql
-- Link each restaurant to the auth user that created it. Without this,
-- the API can't answer "which restaurant does the current user own?" and
-- everything has to fall back to a manual VITE_RESTAURANT_ID env var.
--
-- Forward migration:
--   1. Add restaurants.user_id (nullable for now — seeded rows have no owner)
--   2. Foreign key it to auth.users(id) with ON DELETE CASCADE
--   3. Index for fast `GET /api/restaurant/me` lookup
--
-- Idempotent — safe to re-run.

BEGIN;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS user_id UUID;

-- FK to Supabase Auth's users table. Drop-then-add so re-runs are clean.
ALTER TABLE restaurants
  DROP CONSTRAINT IF EXISTS restaurants_user_id_fkey;

ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS restaurants_user_id_idx
  ON restaurants (user_id);

-- After the seeded row is claimed (see backend README), promote to NOT NULL:
--   ALTER TABLE restaurants ALTER COLUMN user_id SET NOT NULL;

COMMIT;
