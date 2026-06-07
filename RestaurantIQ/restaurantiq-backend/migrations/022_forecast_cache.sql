-- 022_forecast_cache.sql
--
-- Sprint P: cached weekly purchasing forecasts.
--
-- One row per restaurant per generation. We store the full computed payload as
-- JSONB so the GET /api/advisor/forecast route is a single read. Cache TTL is
-- enforced in code (default 24h), not by the DB — easy to tune without a migration.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS forecast_cache (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Full forecast result payload returned directly by the GET endpoint.
  payload           JSONB NOT NULL,
  -- Anthropic token usage for cost auditing.
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  -- The window the forecast was computed over.
  trailing_days     INTEGER NOT NULL DEFAULT 28,
  projection_days   INTEGER NOT NULL DEFAULT 7,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- We only ever read "the latest" per tenant.
CREATE INDEX IF NOT EXISTS forecast_cache_restaurant_generated_idx
  ON forecast_cache (restaurant_id, generated_at DESC);

COMMIT;
