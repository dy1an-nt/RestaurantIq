-- 026_persistent_insights.sql
-- Sprint U: persist AI insights instead of regenerating per page view.
--
-- Why
-- ---
-- GET /api/insights used to call Anthropic on every request and store nothing.
-- Persisting insights (a) caps AI cost (reads become table lookups), (b) creates
-- a recommendation history, (c) enables completed/dismissed workflows, and
-- (d) makes "do users act on recommendations?" measurable.
--
-- Design mirrors the alerts engine (migrations 009/010): dedup_key uniqueness
-- makes regeneration idempotent — the same underlying pattern re-detected on
-- the next generation UPDATES its row rather than duplicating it, and a
-- dismissed insight stays dismissed.
--
-- Rollback
-- --------
--   DROP TABLE IF EXISTS insight_events;
--   DROP TABLE IF EXISTS insights_generation_state;
--   DROP TABLE IF EXISTS insights;

BEGIN;

CREATE TABLE IF NOT EXISTS insights (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  menu_item_id     uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  -- Computed server-side from structured fields (category | item-slug), never
  -- from model wording, so title drift can't mint a new identity.
  dedup_key        text NOT NULL,
  category         text NOT NULL CHECK (category IN (
                     'staffing','peak_hours','slow_days','sales_anomaly',
                     'menu_performance','operational','customer_behavior')),
  priority         text NOT NULL CHECK (priority IN ('high','medium','low')),
  title            text NOT NULL,
  explanation      text NOT NULL,
  metric           text NOT NULL,
  impact           text NOT NULL,
  action           text NOT NULL,
  link             text NOT NULL CHECK (link IN (
                     'analytics','forecast','margins','menu','alerts')),
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','completed','dismissed','expired')),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  -- Set when status leaves 'active' (completed/dismissed/expired); cleared on
  -- reactivation.
  resolved_at      timestamptz,
  UNIQUE (restaurant_id, dedup_key)
);

-- List query: active insights for a restaurant ordered by priority then recency.
CREATE INDEX IF NOT EXISTS insights_list_idx
  ON insights (restaurant_id, status, last_seen_at DESC);

-- Per-restaurant generation bookkeeping: the frequency guard reads
-- last_generated_at; GET /api/insights serves last_meta (period, days of data,
-- confidence, generated-at) without recomputing it.
CREATE TABLE IF NOT EXISTS insights_generation_state (
  restaurant_id     uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  last_generated_at timestamptz NOT NULL DEFAULT now(),
  last_meta         jsonb NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Product-analytics event log (Sprint U Phase 2): every owner action on an
-- insight, append-only. completed/dismissed rates come straight off this table.
CREATE TABLE IF NOT EXISTS insight_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  insight_id    uuid NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  event         text NOT NULL CHECK (event IN
                  ('completed','dismissed','reactivated','escalated')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS insight_events_restaurant_idx
  ON insight_events (restaurant_id, created_at DESC);

-- RLS backstop with no policies, matching migration 024: the anon key gets zero
-- rows; the service-role backend bypasses RLS as everywhere else.
ALTER TABLE insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE insights_generation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_events ENABLE ROW LEVEL SECURITY;

COMMIT;
