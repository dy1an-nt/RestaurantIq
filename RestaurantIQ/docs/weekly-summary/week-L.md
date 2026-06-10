# Week L — Automated Integration Sync & Health

## Sprint goal in one sentence
Stop relying on a human pressing "Run sync": make connected integrations (Square, DoorDash) refresh themselves on a recurring schedule, with per-restaurant locking so two syncs never overlap, durable per-provider sync-health metadata, and failure isolation so one restaurant's broken integration can't poison anyone else's — all with **no new analytics features**, just automation, reliability, and observability.

## What shipped, in plain English
- Connected restaurants now sync automatically in the background every ~15 minutes. Nobody has to click anything.
- Every integration shows its health in the UI: "Up to date / 12 min ago", "Sync failed", or "Reconnect required", refreshed every 30 seconds.
- If a sync is already running for a restaurant, a second one (scheduled or manual) is politely refused instead of doubling the work — the manual "Run sync" button now returns a 409 in that case.
- Integrations that are disconnected or have a dead token are detected up front and skipped — we don't waste a network round-trip hammering a provider with a credential we know is dead.
- If one restaurant's sync blows up, every other restaurant still syncs. The scheduler tick never aborts on a single failure.

## File-by-file

### `restaurantiq-backend/migrations/018_integration_sync_status.sql` (new)
Creates the `integration_sync_status` table — one row per `(restaurant_id, provider)` carrying `status`, `last_success_at`, `last_attempted_at`, `last_error`, and the critical `locked_at` mutex column. A `CHECK` constraint pins `provider IN ('square','doordash')` and `status` to the six legal values. A `UNIQUE INDEX` on `(restaurant_id, provider)` enforces one-row-per-pair **and** doubles as the conflict target for the scheduler's upsert. `ON DELETE CASCADE` ties rows to their restaurant. Idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`) so it can be hand-run safely in the Supabase SQL editor, same as migrations 016/017.

Why a dedicated table instead of columns on `restaurants`: the metadata is naturally keyed per `(restaurant, provider)`, not per restaurant. Bolting `square_last_sync_at`, `doordash_last_sync_at`, `square_locked_at`, … onto `restaurants` would mean adding two columns per provider forever, and the row would carry locking state that has nothing to do with the restaurant's identity. A child table normalizes this: a new provider is a new row value, not a schema migration, and `locked_at` gets to live as a first-class column the lock query can target.

### `restaurantiq-backend/src/services/syncScheduler.ts` (new — the heart of the sprint)
This module owns *when*, *whether*, and *one-at-a-time* a sync runs, and records the outcome. It deliberately does **not** know how to pull from Square or DoorDash — that still lives in `ingestSquare`/`ingestDoorDash`. The split keeps scheduling concerns out of provider logic.

- `classifyIntegration(row, provider)` — the pre-flight. Returns `disconnected` (flag off, or missing location/store id, or no access token), `token_expired` (token past expiry **and** no refresh token to recover with), or `syncable`. In mock mode it short-circuits to `syncable` because the mock ingest generates its own data and ignores tokens entirely. This is what lets the scheduler skip dead integrations *before* any provider call.
- `discoverActiveIntegrations()` — one `SELECT` over `restaurants`, fanned out into `(row, provider)` pairs. It intentionally includes anything ever connected (id present *or* connected flag) so that disconnected/expired integrations still get a status row and stay visible in the UI rather than silently vanishing.
- `ensureStatusRow()` — upsert with `onConflict: 'restaurant_id,provider'` and **`ignoreDuplicates: true`**. The `ignoreDuplicates` matters: it guarantees ensuring-the-row-exists never clobbers an in-flight lock or a recorded error.
- `acquireLock(restaurantId, provider)` — the mutex (detailed below). One conditional `UPDATE … WHERE (locked_at IS NULL OR locked_at < staleCutoff) … .select('id')`; returns `true` only if a row came back.
- `releaseLock()` / `setStatus()` — terminal writes. `releaseLock` always nulls `locked_at` (success *and* failure paths) and sets `last_success_at` only on success. `setStatus` writes a skip state without ever touching the lock.
- `syncIntegration(row, provider, source)` — the end-to-end unit shared by scheduler and manual routes: `ensureStatusRow` → `classifyIntegration` (skip if not syncable) → `acquireLock` (skip with `reason: 'locked'` if refused) → run `ingestFor` under a 90s timeout race → `releaseLock` with the terminal status. **It never throws** — every failure is captured into the returned `SyncOutcome` and the status table. `isAuthError()` maps refresh/401/"reconnect required" messages to `token_expired` so the UI can distinguish "needs re-auth" from a transient blip.
- `runScheduledSync()` — one tick. Guarded by a module-level `running` boolean (cheap dispatcher-level overlap guard), then `Promise.allSettled` over every integration. Because `syncIntegration` never throws and `allSettled` never short-circuits, one restaurant's failure can't stop the others.
- `startSyncScheduler()` — wired from `server.ts`. Idempotent (`if (timer) return`), disablable via `SYNC_SCHEDULER_ENABLED=false`, fires a kick ~5s after boot for immediate freshness, then `setInterval` at `SYNC_INTERVAL_MINUTES` (default 15). Calls `timer.unref()` so the scheduler alone won't keep the Node event loop alive. `stopSyncScheduler()` clears it for tests/shutdown.

### `restaurantiq-backend/src/routes/integrations/syncStatus.ts` (new)
`GET /api/integrations/sync-status`, behind `authMiddleware`. Looks up the caller's restaurant by `user_id = req.user.sub` (tenant scoping — no `restaurant_id` accepted from the client), reads its `integration_sync_status` rows, and returns a `{ square, doordash }` health map in the standard `{ data, error }` envelope. The `build()` helper degrades gracefully: a provider with no status row yet falls back to `connected`/`disconnected` derived from the restaurant row, so the endpoint is correct even before the scheduler's first tick.

### `restaurantiq-backend/src/routes/integrations/square.ts` & `doordash.ts` (modified)
The manual `POST …/sync` handlers were refactored to route through the **shared** `syncIntegration(owned, provider, 'manual')` instead of calling ingest inline. They still do their own ownership check (`.eq('user_id', userId)`) first, then hand the row to the scheduler's path. The payoff: a manual press now obeys the exact same lock and status bookkeeping as a scheduled run, so it can't duplicate an in-flight sync — it returns **409** with "A sync is already in progress" on `reason: 'locked'`, 409 for `disconnected`/`token_expired`, 502 on a real ingest failure, and the usual `{ data, error }` on success. DoorDash also keeps its `/disconnect` endpoint.

### `restaurantiq-backend/src/server.ts` (modified)
Mounts `syncStatusRouter` at `/api/integrations` and calls `startSyncScheduler()` **inside the `app.listen` callback** — i.e. only once the HTTP listener is up. Starting the scheduler after the listener (rather than at module load) keeps boot ordering clean and means a failed bind never leaves a ticking scheduler behind.

### `restaurantiq-backend/src/services/__tests__/syncScheduler.test.ts` (new — 13 tests)
The interesting piece is the hand-rolled **chainable Supabase mock**. `makeBuilder(table)` returns an object whose `.select()/.upsert()/.update()/.eq()/.or()` all return `this`, and whose `.then()` makes the builder itself awaitable (a thenable). `_resolve()` inspects what was chained: a `select` on `restaurants` returns the scripted restaurant list; an `update` that also called `.select()` is recognized as the lock-acquire and returns `[{ id }]` (granted) or `[]` (refused) by shifting the test-controlled `mockState.lockResults` queue. That single mechanism lets the tests script lock contention deterministically without a database. Coverage: `classifyIntegration` (6 cases), status tracking (success clears prior error, failure records it, auth error → `token_expired`), state-respecting skips (2), overlap (lock refusal → ingest never called), and isolation (one restaurant throws, both still attempted).

### `restaurantiq-frontend/src/pages/Integrations.tsx` (modified)
Adds a per-provider "Sync health" block inside each `IntegrationCard`: a status pill mapped via `STATUS_DISPLAY` (e.g. `success → "Up to date"` green, `token_expired → "Reconnect required"` red), `last_success_at` / `last_attempted_at` rendered through `relativeTime()` ("12 min ago"), and the latest `last_error` if any. The parent `Integrations` component fetches `/api/integrations/sync-status` on mount and re-fetches every **30 seconds** via `setInterval`, so background scheduled syncs surface without a reload. Health is best-effort — a failed poll leaves the prior value rather than blanking the UI. `onHealthChange` also re-fetches immediately after a connect/sync/disconnect.

## Key technical decisions

### Dedicated status table vs. columns on `restaurants`
- **Context:** we need durable per-integration answers — last success, last attempt, last error, and a "is a sync running right now?" flag.
- **Decision:** a child `integration_sync_status` table keyed `(restaurant_id, provider)`, not columns on `restaurants`.
- **Why:** the data is per-provider, not per-restaurant. Columns would mean N-per-provider schema growth forever and would put transient locking state on the restaurant's identity row. A child table makes adding a provider a data change, and gives `locked_at` a clean home to lock against.

### The conditional-UPDATE mutex vs. application-level locking
- **Context:** two scheduler ticks, or a scheduled run racing a manual press, must never both ingest the same integration at once.
- **Decision:** the lock *is* a single atomic `UPDATE integration_sync_status SET locked_at=now() … WHERE (locked_at IS NULL OR locked_at < staleCutoff) RETURNING id`. If a row comes back, you hold the lock; if zero rows, someone else does.
- **Why this is a correct mutex:** Postgres serializes concurrent writers of the *same row* — the second updater blocks until the first commits, then re-evaluates its `WHERE` against the now-locked row, matches nothing, and gets back zero rows. There's no read-then-write window to lose, because the read (the `WHERE`) and the write happen in one statement under the row lock. An application-level lock (an in-memory `Set` of "currently syncing" keys) would only protect a *single process* and would evaporate on restart, leaving a half-finished sync's state ambiguous. The DB lock is correct across process restarts and across the scheduled-vs-manual race.
- **Subtle correctness detail — stale reclaim:** a lock held by a process that crashed mid-sync would wedge that integration forever. The `locked_at < staleCutoff` clause (`LOCK_STALE_MS = 10 min`) lets a later run reclaim it. Belt-and-suspenders: the 90s `SYNC_TIMEOUT_MS` race means a hung ingest releases the lock long before it could ever go stale, so the 10-minute window only ever matters for a hard crash.

### `Promise.allSettled` for failure isolation
- **Context:** a tick fans out over every restaurant's integrations.
- **Decision:** `Promise.allSettled` over `syncIntegration(...)`, plus a `syncIntegration` that never throws.
- **Why:** `Promise.all` rejects on the *first* rejection and abandons the rest — one broken restaurant would starve everyone after it in the array. `allSettled` waits for all and reports each independently. We belt-and-suspender it by making `syncIntegration` catch its own errors, so even the `allSettled` result is all `fulfilled`. (Test `runScheduledSync — failure isolation` proves r1 throwing still lets r2 succeed, and both were attempted.)

### Routing manual sync through the same lock
- **Context:** before this sprint the manual `/sync` ran ingest inline, on a totally separate code path from automation.
- **Decision:** the manual route now calls `syncIntegration(..., 'manual')`.
- **Why:** two code paths that both pull data are two places for the lock to be forgotten. Funneling both through one function means the invariant "exactly one sync per integration at a time" is enforced in *one* place. The cost is that a manual press during a scheduled run is refused with a 409 instead of queuing — acceptable, because the scheduled run is already doing the work the user wanted.

### `setInterval(...).unref()`
- **Context:** the scheduler is a long-lived in-process timer.
- **Decision:** call `timer.unref()`.
- **Why:** by default a pending `setInterval` keeps the Node event loop alive, which would prevent clean process exit (and hang test runners / one-off scripts). `unref()` tells Node "don't stay alive *just* for this timer." The HTTP server keeps the process up; the scheduler rides along but never blocks shutdown.

## Patterns and concepts you used

- **Database-backed locking / optimistic concurrency.** The conditional `UPDATE … WHERE locked_at IS NULL` is optimistic concurrency: instead of "lock, then check," you attempt the state transition guarded by the precondition, and the *number of rows affected* tells you whether you won. Same idea as a compare-and-swap (CAS) in lock-free programming, or `UPDATE … WHERE version = $expected` in app DBs.
- **Mutex via single-row serialization.** Postgres' per-row write lock is the primitive; the conditional UPDATE turns it into a named mutex keyed on `(restaurant, provider)`.
- **Idempotent upsert with `ignoreDuplicates`.** `ensureStatusRow` is "create if absent, otherwise leave alone" — make-the-row-exist must never overwrite live state.
- **Fan-out with isolation.** `allSettled` + a never-throwing worker = process all items, surface each result, let none sink the batch.
- **The timeout race pattern.** `Promise.race([work, rejectAfter(ms)])` bounds an operation that has no native timeout. The loser keeps running in the background, but our caller has moved on and released the lock — which is exactly why the bound matters here.
- **Graceful degradation in the read path.** `syncStatus.ts` and the frontend both render sensible defaults when a status row / poll is missing, so observability never hard-fails.

## What you should be able to explain in an interview

**Q: How do you stop two syncs from running for the same restaurant at the same time?**
We use the database row itself as a mutex. There's a `locked_at` column on `integration_sync_status`, one row per restaurant-and-provider. To start a sync you run a single conditional `UPDATE` that sets `locked_at = now()` but only `WHERE locked_at IS NULL OR locked_at < a stale cutoff`, with a `RETURNING id`. Postgres serializes two writers hitting the same row, so the second one re-checks its `WHERE` after the first commits, finds the row locked, and gets back zero rows — meaning it didn't acquire the lock and won't ingest. The nice thing is the check and the set are the same atomic statement, so there's no race window. And because it lives in the DB, it holds across process restarts and even between a scheduled run and someone clicking the manual button.

**Q: What happens if a sync crashes while holding the lock?**
Two layers. First, every ingest runs inside a `Promise.race` against a 90-second timeout, and the lock is released in a `finally`-style path on both success and failure — so a hang releases the lock in under two minutes. Second, even for a hard process crash where no code runs, the acquire query treats any lock older than 10 minutes as stale and reclaimable, so the integration can never wedge permanently.

**Q: One restaurant's integration throws an exception during a scheduled tick. What happens to the others?**
Nothing — they all still run. The tick fans out with `Promise.allSettled`, not `Promise.all`, so a rejection doesn't short-circuit the batch. On top of that, `syncIntegration` catches its own errors and records them to the status table instead of throwing, so the failure becomes a `failed` row, not an exception. We have a test that fails restaurant r1 and asserts r2 still succeeds and both were attempted.

**Q: Why a separate table instead of just adding `last_synced_at` to the restaurants table?**
Because the data is per provider, not per restaurant. With columns I'd be adding several columns for every new integration I ever support, and I'd be putting transient stuff like the lock flag on the restaurant's identity row. A child table keyed on `(restaurant_id, provider)` makes a new provider just a new row value, and gives the lock column a natural home. It also keeps the restaurants row narrow.

**Q: Why does the manual "Run sync" button go through the scheduler now?**
So there's exactly one code path that pulls data, and therefore exactly one place the lock is enforced. If manual sync had its own inline ingest, that's a second path where I could forget the lock and let a user double-trigger work that's already running. Now a manual press just calls the same `syncIntegration`, and if a scheduled run already holds the lock the route returns a 409 instead of duplicating it.

## What to look up if you want to go deeper

- **Postgres advisory locks** — `pg_advisory_lock` / `pg_try_advisory_xact_lock`. A lighter-weight, application-defined lock that doesn't need a row; worth comparing against our row-based approach.
- **`SELECT … FOR UPDATE SKIP LOCKED`** — the canonical pattern for building a work queue in Postgres where each worker grabs a different unlocked row. Read the "row locking" section of the Postgres docs and the classic "What is SKIP LOCKED for in PostgreSQL 9.5" write-up.
- **Leader election** — how you'd ensure only one of N backend instances runs the *tick* (not just avoids duplicate work). Look at how tools do this with a DB lock or a coordination service; the concept matters the moment we scale horizontally (see limitations).
- **Cron vs. in-process schedulers** — tradeoffs between `setInterval` inside the app, OS `cron`, and managed schedulers. Our in-process choice trades external-cron robustness for zero new infra.
- **Backoff and retry** — exponential backoff with jitter for the failed-sync case we currently *don't* retry. "AWS Architecture Blog: Exponential Backoff and Jitter" is the standard reference.
- **Optimistic concurrency control** — Kleppmann, *Designing Data-Intensive Applications*, ch. 7 (transactions / concurrency) connects our conditional-UPDATE directly to CAS and MVCC.

## Things we punted (named technical debt)

- **Single-process scheduler, no leader election.** Today one backend process ticks. The per-restaurant DB lock means multiple instances couldn't *duplicate work*, but each instance would still run its own tick and discovery query. Horizontal scaling needs a leader-election or `pg_advisory_lock` guard around `runScheduledSync` itself — see "What to look up."
- **No retry/backoff on failure.** A `failed` integration simply waits for the next 15-minute tick. There's no exponential backoff and no alerting on repeated failures.
- **30s UI poll is best-effort and can miss `syncing`.** The transient `syncing` status is only visible if a poll happens to land mid-sync; there's no websocket/SSE push.
- **`token_expired` is inferred from error-message regex.** `isAuthError()` pattern-matches strings like `/disconnect|reconnect|401|unauthor|token/i`. A provider that phrases an auth failure differently would be miscategorized as `failed`. A structured error type from the ingest layer would be more robust.
- **Discovery does a full table scan of `restaurants` each tick.** Fine at current scale; at thousands of restaurants we'd want to filter to connected integrations in SQL (and likely paginate the fan-out).

---

## Validation & operational notes
*(folded in from the Sprint L validation report; that report is now superseded by this document)*

**Status at sign-off:** Complete. 13 new tests; full backend suite **108/108 passing**. Frontend + backend `tsc --noEmit` clean.

### Exit-criteria mapping
| Exit criterion | Mechanism |
|----------------|-----------|
| Sync automatically, no manual action | `startSyncScheduler()` runs on boot; `setInterval` at `SYNC_INTERVAL_MINUTES` (default 15), plus a kick ~5s after start. |
| Every restaurant has visible sync health | One `integration_sync_status` row per provider; surfaced via `/sync-status` and the Integrations UI. |
| Last-synced timestamps in the UI | `last_success_at` / `last_attempted_at` rendered as relative time ("12 min ago"). |
| Overlapping runs prevented | Per-`(restaurant, provider)` lock via one atomic conditional `UPDATE`; manual sync uses the same lock; dispatcher-level `running` guard prevents tick-on-tick overlap. |
| Disconnected & expired integrations skipped | `classifyIntegration()` returns `disconnected` / `token_expired`; sync is skipped before any provider call and the status reflects it. |
| Failed syncs don't impact others | `Promise.allSettled` + a never-throwing `syncIntegration`; each failure captured into its own status row. |
| Analytics stay current | A successful ingest rebuilds `daily_summaries` exactly as the manual path did. |

### Locking evidence (the exact statement, conceptually)
```sql
UPDATE integration_sync_status
   SET status='syncing', locked_at=now(), last_attempted_at=now()
 WHERE restaurant_id=$1 AND provider=$2
   AND (locked_at IS NULL OR locked_at < now() - '10 min')
RETURNING id;
```
Postgres serializes two concurrent updaters of the same row; the loser re-evaluates its `WHERE` against the now-locked row, matches nothing, and gets **zero rows** → it does not run ingest. The 10-minute stale window reclaims a crashed sync's lock; the 90-second per-ingest timeout guarantees a hung pull releases far sooner. Proven by `syncIntegration — overlap prevention`: a scripted lock refusal yields `{ skipped: true, reason: 'locked' }` and ingest is never called.

**Status-transition evidence** (from `syncScheduler.test.ts`):
- **success** → `last_success_at` set, `last_error` cleared, `locked_at` nulled.
- **failed** → `last_error` recorded, `locked_at` nulled.
- **token_expired** → an auth/refresh error message is mapped so the UI distinguishes "reconnect required" from a transient failure.
- A subsequent success clears the previous failure (`last_error: null`).

### Configuration (env vars)
| Env var | Default | Effect |
|---------|---------|--------|
| `SYNC_INTERVAL_MINUTES` | `15` | Scheduler cadence. |
| `SYNC_SCHEDULER_ENABLED` | `true` | Set `false` to disable (e.g. one-off scripts / CI). |

**Deployment:** apply `migrations/018_integration_sync_status.sql` to Supabase before/with the release (same manual SQL-editor process as 016/017). The scheduler uses an in-process `setInterval` — no new dependency, no external cron — and works under Railway's always-on process model.

### Live boot-log verification
On startup the listener logs `RestaurantIQ API running on port <port>` followed by `[sync] scheduler starting — interval 15 min`; ~5s later the initial kick logs a `[sync] tick complete {...}` line with `{ integrations, synced, skipped, failed, ms }`. Per-integration lines log as `[sync] ok|fail|skip {...}`. Verified live against the migrated database on 2026-05-31: the scheduler discovered 2 integrations, isolated two independent failures (Square `token_expired`, DoorDash live-sandbox 404 → `failed`), persisted both statuses, and completed the tick cleanly. (Note: the codebase routes operational logging through `console.error` to comply with the "no `console.log` in committed code" convention.)

### Known limitations
- **Single-process scheduler.** The DB lock makes a sync safe across process restarts and against manual triggers, but scaling to multiple backend instances would have each instance ticking. The per-restaurant lock still prevents *duplicate work*; a leader-election or DB-advisory-lock guard around the *tick* is the next step if the API is scaled out.
- **30s UI poll is best-effort** — a `syncing` status is only briefly visible if a poll lands mid-sync.
