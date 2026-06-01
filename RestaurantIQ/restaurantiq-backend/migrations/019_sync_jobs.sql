-- 019_sync_jobs.sql
-- Durable job / audit / retry queue for the distributed sync scheduler (Sprint L+).
--
-- integration_sync_status (018) owns per-restaurant locking + health snapshots
-- (one row per restaurant+provider, updated in-place). This table is different:
-- it is an APPEND-ONLY audit log — one row per sync attempt, retained forever —
-- which gives us:
--   - Full retry history with delay schedule and error messages.
--   - "Pending retry" state persisted across process restarts (the scheduler
--     recovers due retries on the next tick via findDueRetryJobs).
--   - Aggregate metrics (success_rate, average_duration_ms) without scanning
--     the status table.
--   - A recent-jobs feed for the sync-metrics UI without building a log table.
--
-- Status values:
--   pending          → created, not yet started
--   running          → acquired lock, ingest in progress
--   success          → completed successfully
--   failed           → transient failure, retry count exhausted or manual skip
--   pending_retry    → transient failure, next_retry_at set, will be re-tried
--   failed_permanently → auth/disconnect failure or retry budget exhausted
--   skipped          → integration not syncable at dispatch time
--
-- Trigger values:
--   scheduled → emitted by the scheduler tick
--   manual    → emitted by a user-initiated /sync route
--   retry     → emitted by the retry processor in the scheduler tick
--
-- Idempotent — safe to re-run on an existing database.

BEGIN;

CREATE TABLE IF NOT EXISTS sync_jobs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    UUID        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL CHECK (provider IN ('square', 'doordash')),
  trigger          TEXT        NOT NULL DEFAULT 'scheduled'
                               CHECK (trigger IN ('scheduled', 'manual', 'retry')),
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN (
                                 'pending', 'running', 'success', 'failed',
                                 'pending_retry', 'failed_permanently', 'skipped'
                               )),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  -- Wall-clock milliseconds from started_at to completed_at (null while running).
  duration_ms      INTEGER,
  retry_count      INTEGER     NOT NULL DEFAULT 0,
  last_error       TEXT,
  -- When to re-run this job (null for terminal statuses).
  next_retry_at    TIMESTAMPTZ,
  catalog_count    INTEGER,
  order_count      INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Efficient lookup of due retry jobs — the scheduler queries this every tick.
-- Partial index keeps it tiny: only pending_retry rows carry a next_retry_at.
CREATE INDEX IF NOT EXISTS sync_jobs_pending_retry_idx
  ON sync_jobs (next_retry_at)
  WHERE status = 'pending_retry';

-- Per-restaurant feed ordered newest-first (used by the sync-metrics endpoint
-- and by countActive/countPendingRetries).
CREATE INDEX IF NOT EXISTS sync_jobs_restaurant_provider_created_idx
  ON sync_jobs (restaurant_id, provider, created_at DESC);

-- Global status feed for admin / health dashboards.
CREATE INDEX IF NOT EXISTS sync_jobs_status_created_idx
  ON sync_jobs (status, created_at DESC);

COMMIT;
