-- 020_scheduler_state.sql
-- Singleton observability row for the distributed scheduler leader (Sprint L+).
--
-- With multiple backend instances running (Railway replicas, rolling deploys),
-- exactly ONE instance holds the Postgres advisory lock and acts as the
-- scheduler leader. This table provides a durable, queryable record of:
--   - Which instance is currently the leader (leader_instance_id).
--   - When it acquired the lock (leader_acquired_at).
--   - When the last scheduler tick completed (last_tick_at).
--   - How many jobs were processed in the last tick.
--   - How long the last tick took in ms.
--
-- Consumers: the sync-metrics API endpoint (routes/integrations/syncStatus.ts)
-- surfaces these fields so the frontend can show scheduler health without
-- operators needing to grep logs.
--
-- Singleton enforcement: id is always 1 and is constrained to only be 1.
-- We INSERT the row here so it always exists — no "row not found" edge cases.
--
-- Idempotent — safe to re-run on an existing database.

BEGIN;

CREATE TABLE IF NOT EXISTS scheduler_state (
  -- Enforces the singleton: only id=1 can exist.
  id                          INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  leader_instance_id          TEXT,
  leader_acquired_at          TIMESTAMPTZ,
  last_tick_at                TIMESTAMPTZ,
  last_tick_jobs_processed    INTEGER     NOT NULL DEFAULT 0,
  last_tick_duration_ms       INTEGER,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure the singleton row exists. If the table already had it from a prior
-- run of this migration, this is a no-op.
INSERT INTO scheduler_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMIT;
