# Sprint U — Persistent AI Insights

**Theme:** Stop regenerating AI insights on every page view. One schema change —
persisting insights — fixed five problems at once: cost (a paid Claude call per
render → ≤4/day), latency (up to 25 s → a table read), history, an owner
workflow (complete/dismiss), and the first real product-analytics signal
("do users act on the recommendations?").

**Architectural precedent:** the deterministic alerts engine (Sprints C/F)
already persisted rows, deduped via a key, tracked read state, and regenerated
as a post-sync hook. Sprint U is the same shape with the AI as the rule engine —
deliberately reusing a proven pattern instead of inventing one.

---

## 1. What changed (file by file)

| File | Change |
|------|--------|
| `restaurantiq-backend/migrations/026_persistent_insights.sql` | Three new tables: `insights` (the recommendations, with `dedup_key`, `status`, `first/last_seen_at`, `UNIQUE (restaurant_id, dedup_key)`), `insights_generation_state` (one row per restaurant: `last_generated_at` + the meta block, powering the frequency guard), and `insight_events` (append-only audit: completed / dismissed / reactivated / escalated). RLS enabled as a default-deny backstop on all three, matching migration 024. |
| `restaurantiq-backend/src/services/insightsService.ts` *(new)* | Owns the whole lifecycle: `computeDedupKey`, `fetchInsightInputs` (30-day summaries + meta, moved out of the route so read and generation share one implementation), `generateAndPersistInsights` (frequency guard → generate → reconcile → expire), `runInsightsGeneration` (fire-and-forget post-sync hook), `getStoredInsights` (the cheap read). |
| `restaurantiq-backend/src/routes/insights.ts` | Rewritten around the table: `GET /` is now a read (optional `?status=` for history views), `POST /refresh` is the only path that spends tokens (behind the AI rate limiter, `force: true` bypasses the freshness guard), `PATCH /:id` sets completed/dismissed/active with zod validation and tenant scoping in the UPDATE statement itself. |
| `restaurantiq-backend/src/services/syncScheduler.ts` | Calls `runInsightsGeneration` after a successful sync, alongside `runAlerts`. |
| `restaurantiq-backend/src/services/anthropicService.ts` | Exports the pieces the service needs (`Insight`, `PRIORITY_RANK`, `SummaryRow`); generation itself was already built and validated in Sprint T. |
| `restaurantiq-backend/src/services/__tests__/insightsService.test.ts` *(new)* | Unit tests for dedup identity, upsert rules, dismissed-stays-dismissed, escalation, expiry. |
| `restaurantiq-backend/src/routes/__tests__/insightsRoutes.test.ts` *(new)* | **The repo's first HTTP/supertest route suite** — including the wrong-tenant PATCH test the sprint plan made a shipping condition. |
| `restaurantiq-frontend/src/components/InsightsPanel.tsx` | Phase 2 UI: Active/Completed/Dismissed tabs, per-card Complete/Dismiss actions (PATCH + optimistic pending state), a "new since your last visit" marker (`first_seen_at` vs. a per-restaurant `localStorage` timestamp), refresh wired to `POST /refresh`. |
| `restaurantiq-backend/tsconfig.json` | Fix: ts-node now loads ambient type declarations, repairing `npm run dev` boot. |

Pre-sprint gate (landed first, commit `49e06c5`): three engineering-review
HIGHs — token value no longer logged, `decryptTokenSafe` throws
`EncryptionKeyMismatchError` instead of passing ciphertext through as a bearer
token, and a failed orders pull now fails the sync instead of being swallowed.

---

## 2. Key technical decisions

### Identity is computed, never generated
`dedup_key = category | normalized-item-name`, built server-side from the
model's *structured* fields. Title wording changing between generations must not
mint a new row — otherwise "dismissed" would be meaningless, because the model
could reword its way past the owner's decision. The key is deliberately coarse
to start; the `UNIQUE` constraint turns a wrong choice into a visible update,
never a silent duplicate.

### The reconcile rules encode respect for the owner
Per `(restaurant_id, dedup_key)`:
- **No row** → insert as `active`.
- **Active / expired** → update fields + `last_seen_at` (fresh numbers win;
  expired rows reactivate — the pattern came back).
- **Completed / dismissed** → touch `last_seen_at` only. Never resurrect a
  decision the owner made — **except escalation**: a dismissed insight whose
  priority *rose* (medium→high) reactivates, with an `escalated` audit event.
  That closes the "dismissed-forever trap" where an owner dismisses "raise the
  price on X" and the situation then sharply worsens in silence.

### Generation lives outside the sync path
`runInsightsGeneration` is fire-and-forget (`void promise.catch(log)`), exactly
like `runAlerts`: a slow or failing Claude call can never fail or extend a sync.
The frequency guard (default 6 h, env-overridable) lives *inside* the service,
so a 15-minute sync cadence doesn't mean 15-minute Claude spend — the guard is
the actual cost cap, not the sync schedule.

### Concurrency handled by the constraint, not a lock
Two overlapping generations can race on insert. Rather than adding a lock, the
insert treats Postgres error `23505` (unique violation) as "someone else already
handled it." The database constraint is the arbiter.

### Tenant scoping in the write itself
`PATCH /:id` updates with `.eq('id', …).eq('restaurant_id', …)` in a single
statement and 404s on zero rows — not fetch-then-update, which is both a race
and (per review finding L1 on the alerts code) an easier shape to get scoping
wrong in.

---

## 3. Patterns and concepts used

- **Write-behind cache / materialized read model:** the expensive computation
  (Claude) runs on a schedule and writes to a table; reads never trigger it.
  Same idea as a materialized view refreshed out-of-band.
- **Idempotency via natural keys:** `dedup_key` + `UNIQUE` is the same pattern
  the alerts engine and order ingestion (`external_id`) already use — re-running
  never duplicates.
- **State machine on a status column:** `active → completed | dismissed |
  expired`, with `resolved_at` marking transitions and an append-only event
  table as the audit trail. The events table is what makes
  completed/dismissed *rates* queryable in one SQL statement.
- **Fire-and-forget with contained failure:** post-sync hooks may log errors
  but must not propagate them.

---

## 4. Deployment + closeout (2026-07-09)

- Migration 026 is **applied** on the production database (verified by probing
  `insights`, `insights_generation_state`, `insight_events` directly).
- The migration runner was **baselined** on that database the same day — it had
  never been adopted there, so `migrate:status` showed all 26 pending despite
  the schema being current. After verifying sentinel objects from every
  migration era, `npm run migrate:baseline` recorded all 26; status now reports
  `26 applied · 0 pending`.
- Follow-on hardening: `TOKEN_ENCRYPTION_KEY` is now fail-fast validated at
  boot (required in production, format-checked everywhere), closing review M7
  from `known-limitations.md`.

## 5. To go deeper

- Read `insightsService.ts` top to bottom — the header comment is the design
  doc in miniature.
- Compare it with `services/ingestion/persistence.ts` (`runAlerts`) to see the
  pattern it copies.
- Look up: materialized views, upsert idempotency (`ON CONFLICT`), Postgres
  error `23505`, event-sourcing-lite audit tables, optimistic UI updates.
- Phase 3 (explicitly out of scope): outcome attribution — joining
  `insight_events` to subsequent sales changes to measure whether acting on a
  recommendation helped, and feeding that back into the prompt.
