-- 024_enable_rls_backstop.sql
-- Defense-in-depth: enable Row-Level Security on every tenant-owned table.
--
-- Context
-- -------
-- The backend connects with the Supabase SERVICE ROLE key, which has BYPASSRLS,
-- so enabling RLS here does NOT change backend behaviour — every existing query
-- keeps working exactly as before. Tenant isolation is still enforced in code
-- (each route derives restaurant_id from the verified JWT and scopes its query).
--
-- What this adds is a backstop: the frontend ships the public ANON key and can
-- reach Supabase PostgREST directly. Today nothing legitimately queries these
-- tables that way, but if any code (or an attacker with the anon key) ever does,
-- RLS-enabled-with-no-policies means the `anon` and `authenticated` roles get
-- ZERO rows instead of the whole table. The database stops being a single missed
-- `.eq('user_id', ...)` away from a cross-tenant leak.
--
-- We intentionally create NO policies: that is a default-deny for every
-- non-bypassing role. The service role continues to bypass RLS entirely.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is safe to re-run, and each table is
-- guarded by to_regclass so a missing table is skipped rather than erroring.
--
-- Rollback
-- --------
--   ALTER TABLE <each table> DISABLE ROW LEVEL SECURITY;
-- (No data is touched; this only toggles the row-security flag.)

BEGIN;

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'restaurants',
    'menu_items',
    'orders',
    'order_items',
    'daily_summaries',
    'alerts',
    'chat_conversations',
    'chat_messages',
    'forecast_cache',
    'integration_sync_status',
    'sync_jobs',
    'scheduler_state'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
