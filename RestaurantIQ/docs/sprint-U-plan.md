# Sprint U — Persistent AI Insights (Architect Brief)

> Status: **backend shipped** (2026-07-01) — migration 026, insightsService,
> rewritten /api/insights router (GET read + POST /refresh + PATCH /:id),
> post-sync generation hook, service unit tests, and the repo's first
> HTTP/supertest route suite. Remaining: run migration 026 in each environment,
> then the frontend Phase 2 UI (complete/dismiss buttons, "new since last
> visit" marker) — the GET response is backward compatible so the current UI
> keeps working untouched.
>
> Pre-sprint gate (landed with this sprint): review findings H1 (token log
> line), H2 (decryptTokenSafe pass-through → now throws
> EncryptionKeyMismatchError), and H4 (failed orders pull now fails the sync
> unless the payments fallback is enabled).

## Why this initiative

`GET /api/insights` currently regenerates recommendations from scratch on every
page view and persists nothing. One schema change fixes five problems at once:

1. **Cost** — cached insights replace a paid Claude call per page view.
2. **History** — "here's what changed since last week" becomes possible; that
   recurring delta is the weekly-return hook the product currently lacks.
3. **Workflows** — owners can mark a recommendation completed or dismissed.
4. **Product analytics** — completed/dismissed/ignored rates are the first real
   measure of whether users act on recommendations.
5. **Future learning loop** — accumulating (recommendation → action → outcome)
   data starts now; using it to improve prompts is explicitly Phase 3 / out of
   scope for this sprint, but it can't happen later if we don't persist today.

**Architectural precedent:** the deterministic alerts engine (Sprints C, F,
migration 009/010) already persists, dedups via `dedup_key`, tracks read state,
and regenerates as a post-sync hook (`runAlerts` in `ingestion/persistence.ts`).
Persistent insights are the same shape with the AI as the rule engine. Reuse
those patterns; do not invent new ones.

## Scope

**Phase 1 (this sprint):** persist insights, generate post-sync (not per-view),
serve reads from the table, expire stale rows.
**Phase 2 (this sprint if capacity, else Sprint V):** completed/dismissed
actions + a minimal product-event log.
**Phase 3 (explicitly out of scope):** outcome attribution and prompt
improvement from accumulated data.

## DB changes

New migration `026_persistent_insights.sql`:

```sql
CREATE TABLE insights (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  menu_item_id     uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  dedup_key        text NOT NULL,          -- e.g. 'menu_performance|<item>|down'
  category         text NOT NULL,          -- same enum as the tool schema
  priority         text NOT NULL CHECK (priority IN ('high','medium','low')),
  title            text NOT NULL,
  explanation      text NOT NULL,
  metric           text NOT NULL,
  impact           text NOT NULL,
  action           text NOT NULL,
  link             text NOT NULL,
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','completed','dismissed','expired')),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,            -- set when status leaves 'active'
  generation_meta  jsonb NOT NULL DEFAULT '{}',  -- days of data, confidence, model
  UNIQUE (restaurant_id, dedup_key)
);
CREATE INDEX insights_list_idx ON insights (restaurant_id, status, priority, last_seen_at DESC);
ALTER TABLE insights ENABLE ROW LEVEL SECURITY;  -- backstop, no policies (matches 024)
```

Phase 2 adds `insight_events` (or a general `product_events`) table:
`id, restaurant_id, insight_id, event ('completed'|'dismissed'|'reactivated'|'viewed'), created_at`.

## Generation flow (replaces per-view generation)

1. New service `insightsGenerationService.ts`: after a successful sync,
   alongside `runAlerts`, call `generateInsights` (existing, already validated)
   and upsert results by `(restaurant_id, dedup_key)`:
   - new dedup_key → insert (`status='active'`).
   - existing `active` row → update fields + `last_seen_at` (fresh numbers win).
   - existing `completed`/`dismissed` row → update `last_seen_at` ONLY. Never
     resurrect a dismissed insight; never duplicate it.
2. `dedup_key` is computed server-side from the validated insight —
   `category | normalized menu-item reference (or 'general') | trend direction`.
   The model does not choose it.
3. Expiry: `active` rows whose `last_seen_at` is older than 7 days (the model
   stopped reporting the pattern) flip to `expired` during generation.
4. Frequency guard: generate at most once per restaurant per 6 hours (stored in
   `generation_meta` / compared against `last_seen_at`), even though syncs run
   every 15 minutes — this is the actual cost cap. Manual refresh bypasses the
   guard but is rate-limited as today.
5. Fewer than 3 days of data → skip generation (the existing FALLBACK insight
   moves to the frontend empty state; do not store placeholder rows).

## API contract

### GET /api/insights  (changed: now a cheap read, no Claude call)
```
200 { "data": {
  "insights": [ { "id": "...", "category": "menu_performance", "priority": "high",
                  "title": "...", "explanation": "...", "metric": "...",
                  "impact": "...", "action": "...", "link": "margins",
                  "status": "active",
                  "first_seen_at": "...", "last_seen_at": "..." } ],
  "meta": { "generatedAt": "...", "daysWithData": 24, "confidence": "high", ... }
}, "error": null }
```
- Returns `active` insights ordered by priority rank then `last_seen_at` desc.
- Optional `?status=completed|dismissed` for history views.
- `meta` comes from the stored `generation_meta`, not recomputed.

### POST /api/insights/refresh  (new)
- Triggers on-demand generation. Keeps the existing AI rate limiter.
- 202 `{ data: { queued: true }, error: null }` or 200 with fresh list.

### PATCH /api/insights/:id  (Phase 2)
- Body: `{ "status": "completed" | "dismissed" | "active" }` (zod-validated).
- Tenant-scoped in the UPDATE itself (`.eq('restaurant_id', ...)`), 404 when no
  row — match the single-statement pattern, NOT the alerts fetch-then-update
  shape (see review finding L1).

### Frontend
- InsightsPanel reads instantly (no 25 s worst-case spinner), gains
  complete/dismiss buttons (Phase 2) and a "new since your last visit" marker
  derived from `first_seen_at`.

## Risks

1. **Dedup key too coarse/fine.** Too coarse merges distinct problems; too fine
   duplicates the same one. Mitigation: start coarse (category+item+direction),
   log collisions, tune. The UNIQUE constraint makes mistakes visible, not silent.
2. **Model output drift vs dedup.** Title wording changes must not create new
   identities — that's why the key is computed from structured fields only.
3. **Generation moves into the sync path.** A slow Claude call must not eat the
   90 s sync budget — generate AFTER the sync completes and outside the sync
   lock (same fire-and-forget isolation as `runAlerts`).
4. **Dismissed-forever trap.** An owner dismisses "raise price on X," the
   situation worsens sharply — allow escalation: if a dismissed insight's
   priority rises (e.g. medium→high), reactivate it and record the event.
5. **Route/middleware tests still don't exist (review H5).** The PATCH endpoint
   is a write endpoint with tenant scoping; it does not ship without a
   wrong-tenant supertest. Use this sprint to introduce the HTTP test harness.

## Success criteria

- Anthropic insight calls per restaurant per day: from ~page-views to ≤4.
- p95 latency on GET /api/insights: from Claude-bound (up to 25 s) to <300 ms.
- Re-sync twice → zero duplicate insight rows (idempotency test).
- Dismissed insight does not reappear on the next 5 generations (test).
- Phase 2: completed/dismissed rates queryable with one SQL statement —
  the first real answer to "are users acting on the recommendations?"
