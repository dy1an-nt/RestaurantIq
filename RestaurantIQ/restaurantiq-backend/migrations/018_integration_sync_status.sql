-- 018_integration_sync_status.sql
-- Per-restaurant, per-provider sync health + locking metadata (Sprint L).
--
-- Until now synchronization was manual: a user pressed "Run sync" and the
-- ingest ran inline. Sprint L makes sync automatic (services/syncScheduler),
-- which means the system needs durable answers to:
--   - When did this integration last sync successfully?
--   - When was the last attempt, and did it fail (and why)?
--   - Is a sync running RIGHT NOW (so a second one can't start)?
--
-- We store this in a dedicated table rather than columns on `restaurants` so the
-- metadata is normalized per (restaurant, provider), scales to new providers
-- without widening the restaurants row, and gives us a clean lock column.
--
-- Locking model (see services/syncScheduler.ts):
--   `locked_at` non-null  → a sync currently holds the lock.
--   Lock acquisition is a single conditional UPDATE … WHERE locked_at IS NULL
--   OR locked_at < (now - stale window). Postgres row locks serialize the two
--   updaters, so exactly one wins — that's the per-restaurant mutex. The stale
--   window lets a crashed sync's lock be reclaimed instead of wedging forever.
--
-- Statuses: connected | syncing | success | failed | disconnected | token_expired
--
-- Idempotent so it can be re-run on a fresh database.

BEGIN;

CREATE TABLE IF NOT EXISTS integration_sync_status (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('square', 'doordash')),
  status           TEXT NOT NULL DEFAULT 'connected'
                     CHECK (status IN (
                       'connected', 'syncing', 'success',
                       'failed', 'disconnected', 'token_expired'
                     )),
  last_success_at   TIMESTAMPTZ,
  last_attempted_at TIMESTAMPTZ,
  last_error        TEXT,
  -- Non-null while a sync holds the per-restaurant/provider lock.
  locked_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One status row per (restaurant, provider). This unique constraint is also the
-- upsert conflict target the scheduler uses to ensure-create the row.
CREATE UNIQUE INDEX IF NOT EXISTS integration_sync_status_restaurant_provider_idx
  ON integration_sync_status (restaurant_id, provider);

COMMIT;
