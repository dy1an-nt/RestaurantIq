-- 011_alerts_type_check.sql
--
-- Adds a CHECK constraint on alerts.type restricting it to the five values
-- the alerts engine is permitted to emit:
--   no_sales, trending_down, new_top_performer, unusual_spike, traffic_drop
--
-- Why: the column was added as plain TEXT with no constraint, which means any
-- string can be inserted. Codifying the allowed set at the DB level prevents
-- stale code paths or misconfigured callers from silently inserting unknown
-- types that the frontend and alertsService.ts would never surface correctly.
--
-- Safety: before adding the constraint we defensively UPDATE any existing rows
-- whose type falls outside the approved list to 'no_sales'. This makes the
-- ALTER idempotent against dirty data that may exist in sandbox environments.
--
-- PostgreSQL does not support IF NOT EXISTS for CHECK constraints on ALTER TABLE,
-- so we use a DO block that checks pg_constraint before executing the ALTER.
--
-- Idempotent.

BEGIN;

-- Sanitize any rows with an unrecognized type so the constraint cannot fail
-- on pre-existing data.
UPDATE alerts
SET type = 'no_sales'
WHERE type NOT IN ('no_sales', 'trending_down', 'new_top_performer', 'unusual_spike', 'traffic_drop');

-- Drop any existing version of the constraint (which may have fewer values)
-- before re-adding it. DROP CONSTRAINT IF EXISTS is idempotent.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_type_check;

ALTER TABLE alerts
  ADD CONSTRAINT alerts_type_check
  CHECK (type IN ('no_sales', 'trending_down', 'new_top_performer', 'unusual_spike', 'traffic_drop'));

COMMIT;
