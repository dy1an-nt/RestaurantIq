# Week L+ — Supabase-Native Distributed Sync Infrastructure

## Sprint goal in one sentence
Take Sprint L's single-process scheduler and make it safe to run on **multiple backend instances at once** (Railway replicas, rolling deploys) without duplicating work or dropping it — by electing exactly one leader via a Postgres advisory lock, turning every sync attempt into a durable `sync_jobs` row, and adding a Postgres-backed retry/backoff queue that survives crashes and deploys — plus an ops dashboard so you can see all of it without grepping logs.

## What shipped, in plain English
- The backend can now run as **several copies at once** and they won't trample each other. One copy "wins an election" and does the scheduling; the others sit on standby, ready to take over instantly if the winner dies.
- Every single sync attempt is now **written down** in a permanent log table (`sync_jobs`) — when it started, how long it took, whether it worked, and the error if it didn't.
- Failed syncs now **retry on their own** on a backoff schedule (immediately, then 1, 5, 15, 60 minutes). Because the retry state lives in the database — not in memory — retries survive a server restart or a deploy mid-backoff.
- Failures that a retry can't fix (a dead token, a disconnected integration) are marked **permanently failed immediately** instead of being retried forever against a credential we know is dead.
- A new **Sync Health page** (`/sync-health`) shows which instance is the leader, when it last ran, success rates, pending retries, and the last 20 jobs per restaurant — refreshed every 30 seconds.
- Shutdown is now **graceful**: on `SIGTERM`/`SIGINT` the leader releases its lock so a standby can take over in milliseconds instead of waiting out a stale-lock timeout.

## File-by-file

### `restaurantiq-backend/migrations/019_sync_jobs.sql` (new)
Creates `sync_jobs`, an **append-only audit log** — one row per sync attempt, retained forever. This is deliberately a *different shape* from Sprint L's `integration_sync_status`, which is a mutable one-row-per-`(restaurant, provider)` snapshot updated in place. The columns that earn this table its keep: `status` (the seven-state lifecycle: `pending`/`running`/`success`/`failed`/`pending_retry`/`failed_permanently`/`skipped`), `retry_count`, `next_retry_at`, `last_error`, `duration_ms`, and the ingest result counts `catalog_count`/`order_count`. Three indexes earn their place: a **partial index** on `(next_retry_at) WHERE status = 'pending_retry'` (the scheduler queries due retries every tick, and a partial index stays tiny because only pending-retry rows are in it), a `(restaurant_id, provider, created_at DESC)` index for the per-restaurant recent-jobs feed, and a `(status, created_at DESC)` index for global health views. `ON DELETE CASCADE` ties rows to the restaurant. Idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`, wrapped in `BEGIN/COMMIT`), hand-run in the Supabase SQL editor like 016–018.

### `restaurantiq-backend/migrations/020_scheduler_state.sql` (new)
Creates `scheduler_state`, a **singleton observability row** (`id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1)` — the CHECK is what makes it a singleton: no other id can ever be inserted). It records the global facts about *which* instance is leading: `leader_instance_id`, `leader_acquired_at`, `last_tick_at`, `last_tick_jobs_processed`, `last_tick_duration_ms`. The migration `INSERT … ON CONFLICT (id) DO NOTHING` so the row always exists — no "row not found" branch anywhere downstream. This table is **not** the source of truth for who's the leader (the advisory lock is); it's a denormalized mirror so the dashboard can show leadership without holding a pg session.

### `restaurantiq-backend/src/services/scheduler/leaderElection.ts` (new — the conceptual heart of the sprint)
Owns the question "is *this* process allowed to run the scheduler tick?" via a Postgres **session-level advisory lock** (`pg_try_advisory_lock(987654321)`). Public API: `acquireLeadership()`, `verifyLeadership()`, `releaseLeadership()`, `isLeader()`, and the exported `INSTANCE_ID`.

The load-bearing design decision lives here: it opens its **own dedicated `pg.Client`** rather than reusing the `supabase-js` client. `supabase-js` talks to the DB over PostgREST (an HTTP layer in front of Postgres) — every query is a stateless HTTP round-trip through a connection pooler, with no persistent session. A *session-level* advisory lock is bound to one Postgres session and released the instant that session returns to the pool. So a lock taken over `supabase-js` would evaporate immediately. The fix is to hold **one long-lived `pg` connection open for the entire process lifetime**, and that single connection is the only thing that holds the lock.

`INSTANCE_ID` defaults to `${os.hostname()}-${process.pid}` so two replicas have distinct identities even without config. `acquireLeadership()` lazily connects the client and calls `pg_try_advisory_lock` (the non-blocking `try` variant — it returns `true`/`false` immediately rather than waiting in a queue), records the winner into `scheduler_state` (fire-and-forget), and emits `LEADER_ACQUIRED`. Failover is wired through the client's `'error'` and `'end'` event handlers, which set `_isLeader = false` and null the client immediately — so the next tick re-elects. `verifyLeadership()` does a cheap `SELECT 1` heartbeat to confirm the session is still alive; if it's dead it re-acquires. `releaseLeadership()` runs `pg_advisory_unlock` and closes the session on graceful shutdown so a standby takes over without waiting. The **sole-leader fallback**: if `DATABASE_URL` is unset (dev/test/mock mode), it logs a one-time `LEADER_FALLBACK` warning and treats itself as permanent leader — preserving the exact single-instance dev experience.

### `restaurantiq-backend/src/services/scheduler/index.ts` (new — the tick driver and lifecycle)
The scheduler loop. `runSchedulerTick()` is one tick, in four phases: (1) **leadership check** — `isLeader() ? verifyLeadership() : acquireLeadership()`; a non-leader returns 0 and dispatches nothing. (2) **retry processing** — `findDueRetryJobs(now, batchSize)` pulls `pending_retry` rows whose `next_retry_at <= now`, fetches their restaurant rows in one `.in()` query, and dispatches each through `syncIntegration(row, provider, 'retry', retry_count, job.id)` — passing the existing job id is what makes retries consume their own row (see the bug story). (3) **discovery + dispatch** — `discoverActiveIntegrations()` then fresh `syncIntegration(row, provider, 'scheduled')`. (4) **record tick metadata** into `scheduler_state`.

Both phases run through `concurrentMap(tasks, limit)`, a hand-rolled bounded-concurrency pool: at most `SYNC_MAX_CONCURRENCY` (default 5) tasks run in flight, with `Promise.allSettled` semantics so one failure never sinks the batch. `SYNC_BATCH_SIZE` (default 50) caps how many integrations/retries a single tick picks up. A module-level `ticking` guard prevents tick-on-tick overlap. Lifecycle: `startScheduler()` (idempotent, disablable via `SYNC_SCHEDULER_ENABLED=false`, kicks an initial tick ~5s after boot, then `setInterval` at `SYNC_INTERVAL_MINUTES`, with both timers `unref()`'d and tracked so a shutdown inside the 5s boot window can cancel the kick) and `stopScheduler()` (clears timers and calls `releaseLeadership()`). It re-exports `startSyncScheduler`/`stopSyncScheduler` aliases so `server.ts`'s existing import names didn't have to change.

Config getters (`batchSize()`, `maxConcurrency()`, `intervalMs()`) are **functions, not module constants** — read at call time, not module-load time, because env vars aren't populated until `dotenv.config()` runs in `server.ts`, which happens *after* imports resolve.

### `restaurantiq-backend/src/services/scheduler/syncJobs.ts` (new — repository over `sync_jobs`)
Typed helpers that hide raw Supabase calls behind a small vocabulary: `createJob` (insert a `pending` row, return its id, or `null` on failure so the ingest is never blocked by a tracking-write failure), `markRunning`, `markSuccess`, `markFailedOrRetry` (the branch that decides `pending_retry` vs `failed_permanently` based on whether `nextRetryAt` is null), `markSkipped`. Query side: `findDueRetryJobs` (the every-tick retry discovery query), `countPendingRetries`, `countActive`. Every write is fire-and-log-on-error, never throw — a job-tracking failure must not abort the underlying ingest.

### `restaurantiq-backend/src/services/scheduler/retry.ts` (new — pure backoff policy)
No I/O — just the math. `nextRetryDelayMs(retryCount)` returns the delay from a fixed schedule `[0, 1m, 5m, 15m, 60m]` (clamped to the last entry), or `null` once `retryCount` exceeds the budget. `isPermanent(state)` returns true for `disconnected`, `token_expired`, and the sentinel `'exhausted'`. `maxSyncRetries()` reads `MAX_SYNC_RETRIES` **at call time** (default 5) — and the comment spells out exactly why: module-level imports execute before `dotenv.config()`, so reading `process.env` at module load would lock in the default and silently ignore any `.env` override. `MAX_SYNC_RETRIES` is also exported as a static value for display/back-compat, but runtime budget decisions go through the function.

### `restaurantiq-backend/src/services/scheduler/metrics.ts` (new — aggregator for the dashboard)
`getRestaurantSyncMetrics(restaurantId)` scans a restaurant's `sync_jobs` and computes `total_syncs` (terminal statuses only, so `running` rows aren't double-counted), `successful_syncs`, `failed_syncs`, `success_rate` (a float 0..1 — the comment flags it as the *one sanctioned float* in the codebase, since it's a ratio, not money), `average_duration_ms` (integer, rounded, computed only over successful syncs), `retry_count`, `active_sync_count`, and last-success/last-failed timestamps. `getRecentJobs` returns the newest 20 rows. `getProviderRetryInfo` finds the most recent `pending_retry` row per provider to surface its `retry_count`/`next_retry_at`. All zero-value-defaulted on error so the dashboard never hard-fails.

### `restaurantiq-backend/src/services/scheduler/logger.ts` (new — structured event log)
`logEvent(event, fields)` emits one JSON line to **stderr** (`console.error`, per the no-`console.log` convention) with a fixed `event` name and ISO `ts`, plus arbitrary fields. The `SchedulerEvent` union is the vocabulary that makes distributed execution diagnosable across instances: `LEADER_ACQUIRED`/`LEADER_LOST`, `SCHEDULER_TICK`, `SYNC_STARTED`/`SYNC_COMPLETED`/`SYNC_FAILED`, `RETRY_SCHEDULED`/`RETRY_EXECUTED`, `LOCK_ACQUIRED`/`LOCK_RELEASED`. JSON lines mean a log aggregator (Railway, Datadog) can filter on `event` and `instanceId` without regex.

### `restaurantiq-backend/src/services/syncScheduler.ts` (modified — now the per-integration EXECUTOR)
Sprint L's `syncIntegration` was already the shared "sync one integration with lock + status" unit. Sprint L+ keeps that and layers durable job tracking on top. The signature gained two params: `syncIntegration(row, provider, source, retryCount = 0, existingJobId = null)`. On every attempt it now creates (or *continues*) a `sync_jobs` row: `markRunning` once the lock is held, `markSuccess` with ingest counts on success, and on failure it branches — an auth/credential error (`isAuthError`) is `markFailedOrRetry(..., nextRetryAt: null)` → `failed_permanently` (retrying a dead token is pointless), while a transient error computes `nextRetryDelayMs(retryCount + 1)` and either schedules a `pending_retry` (emitting `RETRY_SCHEDULED`) or, once the budget is spent, lands `failed_permanently`. The `discoverActiveIntegrations`, `classifyIntegration`, `acquireLock`/`releaseLock` per-restaurant mutex, the 90s timeout race, and `runScheduledSync` are all carried forward from Sprint L. (`runScheduledSync` still exists and still fans out with `allSettled`; the new `index.ts` tick is the path the distributed scheduler actually drives, but the two share the same executor.)

### `restaurantiq-backend/src/routes/integrations/syncStatus.ts` (modified — adds `GET /sync-metrics`)
Keeps the Sprint L `GET /sync-status` endpoint and adds `GET /api/integrations/sync-metrics` behind `authMiddleware`. It scopes to the caller's restaurant by `user_id = req.user.sub` (tenant safety at the route, never trusting a client-supplied id), then fires seven reads in parallel via `Promise.all`: status rows, the `scheduler_state` singleton, `getRestaurantSyncMetrics`, `getRecentJobs(20)`, per-provider retry info for Square and DoorDash, and `countPendingRetries`. It assembles a `{ scheduler, metrics, integrations: { square, doordash }, recent_jobs }` payload in the standard `{ data, error }` envelope. The header comment warns: the frontend is built against this exact shape — don't reorder or rename without updating the frontend.

### `restaurantiq-backend/src/server.ts` (modified)
Now imports `startScheduler`/`stopScheduler` from `./services/scheduler` (the new module) and calls `startScheduler()` inside the `app.listen` callback. Adds graceful-shutdown handlers: `SIGTERM`/`SIGINT` → log a `SHUTDOWN` event → `await stopScheduler()` (which releases the advisory lock) → `process.exit(0)`. The point of releasing on shutdown is failover speed: a standby can grab the lock immediately instead of waiting out the stale window during a rolling deploy.

### `restaurantiq-frontend/src/pages/SyncHealth.tsx` (new — the ops dashboard)
The `/sync-health` page. Four sections, all fed by `GET /api/integrations/sync-metrics`: **Scheduler Health** (leader vs standby pill, leader instance id, leader-since, last tick, jobs last tick, pending retries highlighted yellow when > 0), **Metrics Overview** (stat tiles: total/successful/failed syncs, success rate as a percent, avg duration, active syncs, total retries, last success/failure), **Integration Health** (per-provider rows with status pill, last-success/last-attempted relative times, and — only when failed/expired/errored — the error text, retry count, and next-retry time), and **Recent Jobs** (a 20-row table: provider, trigger, status pill, started, duration, retries, error). Polls every 30s and is best-effort on the poll path — a failed poll keeps the prior data rather than blanking the UI; errors only surface on the initial load.

### `restaurantiq-frontend/src/App.tsx` & `src/components/Sidebar.tsx` (modified)
`App.tsx` adds the `/sync-health` route inside the authenticated `AppLayout`. `Sidebar.tsx` adds the "Sync Health" nav item.

### Tests (new)
- `scheduler/__tests__/leaderElection.test.ts` — mocks `pg.Client`; proves leadership granted when the lock returns true, denied when false, denied + `isLeader=false` on connect failure, the sole-leader fallback never constructs a `pg.Client` when `DATABASE_URL` is unset, the `'end'` event drops leadership, and `verifyLeadership` heartbeats with `SELECT 1`.
- `scheduler/__tests__/retry.test.ts` — pure-function tests of the exact backoff schedule (0/1m/5m/15m/60m), `null` past the budget, and `isPermanent`.
- `scheduler/__tests__/syncJobs.test.ts` — chainable-builder mock; verifies each write sends the right payload and that `markFailedOrRetry` flips between `pending_retry` (non-null `next_retry_at`, `completed_at` null) and `failed_permanently` (null `next_retry_at`, `completed_at` set).
- `scheduler/__tests__/schedulerTick.test.ts` — fully mocks leader election + executor + jobs; proves a non-leader dispatches nothing, a leader calls `findDueRetryJobs` every tick, discovers and dispatches, returns the processed count, and still runs discovery even when retries are present.
- `services/__tests__/syncScheduler.test.ts` (retry-pipeline regression block) — the two QA bugs (below), pinned: a transient failure schedules a real `pending_retry`; an auth failure goes straight to `failed_permanently`; budget exhaustion lands `failed_permanently`; and a dispatched retry **reuses its own job row** (zero new inserts, row flipped to `running` then `success`).

## Key technical decisions

### Why a dedicated `pg.Client` for leader election, not `supabase-js`
- **Context:** with multiple instances we need exactly one to run the tick. Postgres advisory locks are the natural primitive.
- **Decision:** open one long-lived `pg.Client` per process and take a *session-level* `pg_try_advisory_lock(987654321)` over it.
- **Why:** an *advisory lock* is a lock Postgres tracks for you but attaches no meaning to — *you* decide that "holding key 987654321 means I'm the scheduler leader." A **session-level** advisory lock lives exactly as long as the database session that took it. `supabase-js` has no persistent session — it's PostgREST over HTTP through a pooler, so the connection returns to the pool after every query and the lock would release instantly. The only way to hold the lock is to hold one `pg` connection open for the process lifetime. That's why this is the one place in the codebase that bypasses `supabase-js` and talks raw `pg`.
- **Why exactly one instance wins:** `pg_try_advisory_lock` is atomic inside Postgres. The first session to call it for key `987654321` gets `true`; every other session calling it gets `false` until the holder releases or disconnects. The `try` variant returns immediately rather than blocking, so standbys don't pile up in a wait queue — they just learn "not me" and move on.
- **The 987654321 key:** an arbitrary 64-bit integer, but it must be **identical across all instances** — they're all contending for the *same* named lock. Changing it while a lock is held orphans the old lock (harmless on next boot).
- **Failover:** the `pg` client's `'error'`/`'end'` handlers set `isLeader = false` and null the client the moment the connection drops. If the leader process crashes, Postgres notices the session is gone and releases the lock automatically; the surviving instances' next tick calls `acquireLeadership()` and one of them wins. `verifyLeadership()`'s `SELECT 1` heartbeat catches a half-dead session before a tick relies on it.
- **Sole-leader fallback:** no `DATABASE_URL` → skip the pg layer entirely, log once, and behave as permanent leader. Dev and mock-mode work exactly as in Sprint L with zero new setup.

### Two tables: `sync_jobs` (append-only) alongside `integration_sync_status` (mutable snapshot)
- **Context:** Sprint L's `integration_sync_status` already holds the lock and the current health snapshot per `(restaurant, provider)`.
- **Decision:** add a *second* table, `sync_jobs`, append-only, one row per attempt — rather than cramming history into the existing one.
- **Why:** the two have fundamentally different lifecycles. `integration_sync_status` is a **mutable current-state** row — it's overwritten in place, and crucially it's where the per-restaurant **lock** lives (`locked_at`), so it must stay small and hot. `sync_jobs` is an **immutable event log** — it grows forever, carries full retry history and durable `pending_retry` state, and is what aggregate metrics and the recent-jobs feed read from. Forcing history into a single-row-per-pair table would mean either losing history on every update or inventing a fake key to keep multiple rows — which is just `sync_jobs` with extra steps. Snapshot vs. log is a clean separation: the lock table answers "what's true right now?", the job log answers "what happened, and what should happen next?"

### Durable retry/backoff with no `setTimeout` and no in-memory queue
- **Context:** transient failures (provider 5xx, timeout, network) should retry; but a server restart or deploy must not lose pending retries.
- **Decision:** retry state — `status='pending_retry'`, `next_retry_at`, `retry_count` — lives in `sync_jobs`. The scheduler **discovers due retries by querying the table each tick** (`findDueRetryJobs`), rather than holding any in-memory timer.
- **Why:** an in-process `setTimeout`-based queue dies with the process. A deploy mid-backoff, a crash, an OOM — and every pending retry silently vanishes. By making Postgres the source of truth and the tick a stateless poller, retries are durable by construction: whichever instance is leader on the next tick picks up whatever is due, regardless of which instance scheduled it. Backoff schedule is 0/1/5/15/60 minutes; exhaustion → `failed_permanently`.
- **Why auth/disconnected/expired are never retried:** those need a human to reconnect the integration. Retrying just hammers a credential we already know is dead and buries the actionable "reconnect required" signal under noise. `isPermanent` short-circuits them straight to `failed_permanently`.

### The retry-consumption subtlety (QA-caught bug)
- **Context:** when the tick dispatches a due retry, it must *continue that retry's existing job row*, not start a fresh one.
- **Decision:** `syncIntegration` takes an `existingJobId`; the tick passes `job.id`, and `markRunning(existingJobId)` flips the row out of `pending_retry` into `running`.
- **Why — the bug:** the first cut created a **new** `sync_jobs` row for each retry attempt. The original `pending_retry` row was never touched, so its `next_retry_at` stayed in the past — meaning `findDueRetryJobs` returned it again on *every* tick, re-dispatching forever and spawning a new row each time. The fix is that the retry consumes its own row: `markRunning` moves it to `running`, so `findDueRetryJobs` (which filters `status = 'pending_retry'`) no longer returns it. The regression test "a dispatched retry reuses its own job row instead of creating a new one" asserts **zero** new inserts and the existing row transitioning `running` → `success`.
- **The second bug in the same block:** an earlier permanent-failure branch was effectively tautological — it marked *every* failure `failed_permanently`, killing the retry path entirely. The "schedules a backoff retry for a transient failure" test pins that a transient error produces a real `pending_retry` with a non-null `next_retry_at` and is *not* marked permanently failed.

### Reading config at call time, not module load
- **Context:** `MAX_SYNC_RETRIES`, `SYNC_BATCH_SIZE`, etc.
- **Decision:** read them inside functions (`maxSyncRetries()`, `batchSize()`), not as top-level `const`s.
- **Why:** Node resolves all `import`s before any module body runs, and `dotenv.config()` runs in `server.ts`'s body. So a top-level `const x = Number(process.env.MAX_SYNC_RETRIES)` reads `undefined` and bakes in the default forever — an operator's `.env` override would be silently ignored. Reading inside the function defers the lookup until after dotenv has populated `process.env`.

## Patterns and concepts you used
- **Leader election via a lease/lock.** Exactly one of N instances does the coordinating work. Here the "lease" is a session-level advisory lock held by a live connection; it's released the instant the holder dies, which gives automatic failover. The general pattern (etcd, ZooKeeper, Consul, Kubernetes leases) is the same shape — a single contended resource that proves leadership.
- **Postgres advisory locks.** Application-defined locks keyed by an integer, not tied to any row. Session-scoped (held for the connection's life) vs. transaction-scoped (`pg_try_advisory_xact_lock`, auto-released at commit). We need session scope so the lock outlives any single query.
- **Heartbeat / liveness check.** `verifyLeadership`'s `SELECT 1` is a heartbeat: cheap proof the session — and therefore the lock — is still alive before a tick depends on it.
- **Durable work queue / outbox.** `sync_jobs` is a database-backed queue: state lives in rows, workers poll for due work. The classic competing-consumers pattern would add `FOR UPDATE SKIP LOCKED` (see punted work); under a single leader we don't need it yet.
- **Exponential backoff.** Retry delays grow (0/1/5/15/60m) so a struggling provider isn't hammered. We don't add jitter yet (single leader, low contention).
- **Append-only audit log vs. mutable snapshot.** Two tables, two lifecycles — event sourcing's "log of facts" next to a "current state" projection.
- **Bounded concurrency.** `concurrentMap` caps in-flight work so a tick can't open 200 provider connections at once. `Promise.allSettled` semantics keep failures isolated.
- **Graceful shutdown / lock handoff.** Releasing the lock on `SIGTERM` turns a slow stale-timeout failover into an instant one — important during rolling deploys.

## What you should be able to explain in an interview

**Q: How do you make sure only one of several backend instances runs the scheduler?**
We use a Postgres session-level advisory lock. On boot each instance tries `pg_try_advisory_lock` with a fixed key — 987654321 — and exactly one gets `true`; that one is the leader and the only one that dispatches syncs. The subtle part is that we *can't* take this lock through our normal Supabase client, because that's PostgREST over HTTP with no persistent session — the lock would release the moment the query returned. So leader election is the one place we open a raw `pg` connection and hold it open for the whole process lifetime. The lock lives as long as that session, which gives us free failover: if the leader crashes, Postgres drops its session, the lock releases automatically, and on the next tick a standby acquires it.

**Q: What happens to in-progress retries if you deploy or the server crashes?**
Nothing's lost, because retries don't live in memory. When a sync fails transiently we write the retry state into the `sync_jobs` row — status `pending_retry`, a `next_retry_at`, and an incremented `retry_count`. There's no `setTimeout`. Every scheduler tick just queries "give me pending_retry rows whose next_retry_at is in the past" and runs them. So whichever instance is leader after a deploy picks up exactly what's due. The backoff is 0, 1, 5, 15, 60 minutes, and once we blow the budget the row goes to `failed_permanently`.

**Q: Why two tables for sync state instead of one?**
They have different lifecycles. `integration_sync_status` is the current snapshot — one row per restaurant-and-provider, updated in place, and it's where the per-restaurant lock lives, so it stays small and hot. `sync_jobs` is an append-only log — one row per attempt, kept forever, carrying retry history and durable retry state. Metrics and the recent-jobs feed read the log; the lock and "is it healthy right now" read the snapshot. Cramming history into the snapshot table would mean either destroying history on every update or faking a multi-row key, which is just the log table with extra steps.

**Q: There was a bug where retries looped forever. What was it?**
When the tick dispatched a due retry, the first version created a brand-new `sync_jobs` row for the attempt and never touched the original `pending_retry` row. That row's `next_retry_at` stayed in the past, so the discovery query returned it again every single tick — re-dispatching forever and leaking a new row each time. The fix was to pass the existing job id into `syncIntegration` so the retry continues its own row: `markRunning` flips it from `pending_retry` to `running`, and since the discovery query filters on `pending_retry`, it's no longer due. We pinned it with a test that asserts zero new inserts and the original row transitioning to running then success.

**Q: You have a per-restaurant lock AND leader election AND job rows. Don't those overlap?**
They're three different layers solving three different problems. Leader election decides *which process* gets to schedule at all — one coordinator across the fleet. The per-restaurant lock (`locked_at`, from Sprint L) prevents two *syncs* for the same restaurant overlapping, even across a manual click, a scheduled run, and a retry. And the `sync_jobs` row is the durable *record* of one attempt plus its retry state. They compose: the leader is the only one dispatching; when it dispatches, the per-restaurant lock still guards against a manual sync racing it; and whatever happens is written to a job row. Even with a single leader the per-restaurant lock still matters, because a user can hit "Run sync" by hand at any moment.

**Q: Why is the advisory lock session-scoped and held in its own connection?**
A session-level advisory lock is released exactly when the database session ends. That's the property we want — it makes failover automatic, because a dead leader's session dies and the lock frees itself. But it means the lock is only valid as long as we keep that one session alive, which is why leader election owns a dedicated long-lived `pg.Client` instead of borrowing a pooled connection that comes and goes per query.

## What to look up if you want to go deeper
- **Postgres advisory locks** — the official "Advisory Locks" section of the Postgres docs. Compare `pg_advisory_lock` (session, blocking), `pg_try_advisory_lock` (session, non-blocking — what we use), and `pg_advisory_xact_lock` (transaction-scoped). Understand why session scope is required here.
- **`SELECT … FOR UPDATE SKIP LOCKED`** — the canonical multi-worker queue claim. "What is SKIP LOCKED for in PostgreSQL 9.5" (2ndQuadrant) is the classic write-up. This is the upgrade path for `findDueRetryJobs` once more than one instance processes retries.
- **Leader election** — read how Kubernetes implements leader election via the Lease API, and skim the Raft paper's intro on why a single leader simplifies coordination. Our advisory-lock approach is a lightweight version of the same idea.
- **Exponential backoff and jitter** — "Exponential Backoff And Jitter" (AWS Architecture Blog). We use plain exponential backoff; the article explains when jitter matters (it does once many clients retry against one struggling service).
- **The outbox / durable-queue pattern** — Kleppmann, *Designing Data-Intensive Applications*, ch. 11 (stream processing) and ch. 7 (transactions). Connects directly to "state in rows, workers poll."
- **`pg` (node-postgres)** — read the `Client` vs `Pool` docs and the connection lifecycle/`error` event semantics; that's the foundation of our failover handlers.
- **Graceful shutdown in Node** — the Node `process` signal docs (`SIGTERM`/`SIGINT`) and how Railway/Docker send `SIGTERM` on deploy, so you understand why releasing the lock on shutdown speeds failover.

## Things we punted (named technical debt)
- **`findDueRetryJobs` has no atomic claim (`FOR UPDATE SKIP LOCKED`).** Today it `SELECT`s due rows without locking them. Safe *only* because exactly one leader runs it — there's no second consumer to double-claim a row. The moment we let multiple instances process retries (or split retry processing off the leader), two workers could grab the same job. The fix is a `FOR UPDATE SKIP LOCKED` claim or an atomic status flip.
- **`getRestaurantSyncMetrics` scans the entire job history with no time window.** It reads *all* of a restaurant's `sync_jobs` to compute aggregates. Fine now; as the append-only log grows to tens of thousands of rows per restaurant, this read gets expensive. Add a trailing window (e.g. last 30 days) — the `(restaurant_id, provider, created_at DESC)` index already supports it.
- **30s dashboard poll, best-effort.** No websocket/SSE push; a `running`/`syncing` state is only visible if a poll lands mid-sync. Carried over from Sprint L.
- **`token_expired` still inferred via error-message regex.** `isAuthError` pattern-matches strings like `/disconnect|reconnect|401|unauthor|token/i`. A provider phrasing an auth failure differently would be miscategorized as transient and retried. A structured error type from the ingest layer would be robust. Carried over from Sprint L.
- **`scheduler_state` is a denormalized mirror, not the source of truth.** Leadership truth is the advisory lock; `scheduler_state` is written fire-and-forget. A failed write means the dashboard can briefly show a stale leader even though election is correct. Acceptable for an ops view; don't build logic on top of it.

## Architecture diagram

```
                       Railway (N instances behind one process model / rolling deploys)
        ┌───────────────────────┐   ┌───────────────────────┐   ┌───────────────────────┐
        │   Instance A (pg)     │   │   Instance B (pg)     │   │   Instance C (pg)     │
        │  pg_try_advisory_lock │   │  pg_try_advisory_lock │   │  pg_try_advisory_lock │
        │      (987654321)      │   │      (987654321)      │   │      (987654321)      │
        └───────────┬───────────┘   └───────────┬───────────┘   └───────────┬───────────┘
                    │  TRUE                      │  FALSE                     │  FALSE
                    ▼                            ▼                            ▼
              ╔═════════════╗               (standby)                   (standby)
              ║   LEADER    ║   ← holds session-level advisory lock for process lifetime
              ╚══════╤══════╝     crash/disconnect → lock auto-released → standby re-elects
                     │
                     │ runSchedulerTick()  (every SYNC_INTERVAL_MINUTES)
                     │   1. verify/acquire leadership
                     │   2. findDueRetryJobs(now) ──┐
                     │   3. discoverActiveIntegrations
                     │   4. recordTick → scheduler_state
                     ▼                              │
        ┌──────────────────────────────────────────▼──────────────┐
        │   sync_jobs   (append-only durable job / retry queue)    │
        │   pending → running → success                            │
        │                     ↘ failed → pending_retry → … →       │
        │                                  failed_permanently      │
        │                     ↘ skipped (not syncable)             │
        └───────────────────────────┬──────────────────────────────┘
                                     │ syncIntegration() per (restaurant, provider)
                                     │  ← per-restaurant lock (integration_sync_status.locked_at)
                                     ▼
                         ┌───────────────────────┐
                         │  ingestSquare /        │   ← Square Node SDK / DoorDash API
                         │  ingestDoorDash        │      (90s timeout race)
                         └───────────┬───────────┘
                                     ▼
                    orders / order_items / menu_items  →  daily_summaries (pre-aggregation)
                                     ▼
                              Analytics / Dashboard
                                     ▲
                                     │ GET /api/integrations/sync-metrics (polls 30s)
                              Sync Health page (/sync-health)
```
