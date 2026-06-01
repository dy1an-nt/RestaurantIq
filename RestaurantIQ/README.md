# RestaurantIQ

Restaurant analytics and marketing SaaS. Syncs with POS systems (Square) and delivery apps (DoorDash), surfaces menu analytics, and generates AI-powered marketing copy.

- **Frontend:** React + Tailwind + Recharts + Vite (`restaurantiq-frontend/`)
- **Backend:** Node.js + Express (`restaurantiq-backend/`)
- **Database:** PostgreSQL (Supabase)
- **AI:** Anthropic Claude API
- **Hosting:** Vercel (frontend) + Railway (backend)

See `CLAUDE.md` for project scope/conventions and `docs/weekly-summary/` for sprint-by-sprint deep dives.

## Distributed Synchronization Architecture

RestaurantIQ keeps every connected restaurant's POS/delivery data fresh by syncing in the background — no human pressing "Run sync." The backend is designed to run as **multiple instances at once** (Railway replicas, rolling deploys) without two of them duplicating work or dropping it. This section documents how that coordination works: how one instance is elected to do the scheduling, how every sync attempt is recorded and retried durably, and how overlapping syncs are prevented.

There are **three independent coordination layers**, and it's worth keeping them straight:

| Layer | Question it answers | Mechanism |
|-------|---------------------|-----------|
| **Leader election** | Which *instance* gets to schedule at all? | Postgres session-level advisory lock |
| **Per-restaurant lock** | Can two *syncs* for the same restaurant overlap? | `integration_sync_status.locked_at` conditional UPDATE |
| **Job rows** | What happened on each attempt, and what should happen next? | `sync_jobs` append-only table |

### Leader election (advisory-lock based)

On startup every instance opens **one dedicated `pg.Client`** and calls:

```sql
SELECT pg_try_advisory_lock(987654321);
```

Exactly one instance gets `true` and becomes the **leader** — the only instance that dispatches syncs. Every other instance gets `false` and runs as a **standby**.

Two non-obvious but critical design points:

1. **We do not use the `supabase-js` client for this.** `supabase-js` talks to Postgres through PostgREST over HTTP — each query is a stateless round-trip through a connection pooler. A *session-level* advisory lock is bound to a single Postgres session and is released the moment that session returns to the pool. So a lock taken over `supabase-js` would release immediately. Leader election is therefore the one place in the codebase that opens a raw `pg` connection and holds it open for the entire process lifetime; that single connection is what holds the lock.

2. **The lock key (987654321) must be identical across all instances** — they are all contending for the same named lock. It's an arbitrary 64-bit integer with no meaning beyond "holding it means I'm the scheduler leader."

The leader records itself into the `scheduler_state` singleton row (`leader_instance_id`, `leader_acquired_at`) for observability, and runs a `SELECT 1` heartbeat each tick (`verifyLeadership`) to confirm its session — and therefore its lock — is still alive.

### Failover behavior

- **Leader crashes / loses its connection:** Postgres notices the session is gone and **automatically releases** the advisory lock. The `pg` client's `'error'`/`'end'` handlers also set `isLeader = false` locally. On the next scheduler tick, a standby calls `acquireLeadership()` and one of them wins the now-free lock.
- **Graceful shutdown (deploy / SIGTERM / SIGINT):** the leader calls `pg_advisory_unlock` and closes its session *before* exiting, so a standby takes over within one tick instead of waiting out a stale-lock timeout. This is what keeps rolling deploys seamless.
- **No `DATABASE_URL` (local dev, mock mode):** the pg layer is skipped entirely, a one-time warning is logged, and the instance behaves as a permanent sole leader — preserving the single-instance development experience with zero extra setup.

### The sync job lifecycle

Every sync attempt (scheduled, manual, or retry) is one row in the append-only `sync_jobs` table. The `status` column moves through this lifecycle:

```
                          ┌──────────────┐
                          │   pending    │  (row created)
                          └──────┬───────┘
                                 │ lock acquired, ingest starts
                          ┌──────▼───────┐
                          │   running    │
                          └──────┬───────┘
              success ┌──────────┼──────────┐ failure
                      ▼          │          ▼
              ┌──────────────┐   │   ┌───────────────────────────┐
              │   success    │   │   │  transient?  vs  permanent?│
              └──────────────┘   │   └───────┬───────────────┬───┘
                                 │           │ transient     │ auth / disconnected / expired
                                 │           ▼               ▼
                                 │   ┌────────────────┐  ┌──────────────────────┐
                                 │   │ pending_retry  │  │  failed_permanently  │
                                 │   │ (next_retry_at)│  └──────────────────────┘
                                 │   └───────┬────────┘
                                 │           │ next_retry_at due → re-dispatched
                                 │           │ (continues THIS row, → running)
                                 │           │ budget exhausted → failed_permanently
                  not syncable   │
                  at dispatch ───┴──► skipped
```

- **`pending`** — row created, not yet started.
- **`running`** — per-restaurant lock acquired, provider ingest in progress.
- **`success`** — completed; `duration_ms`, `catalog_count`, `order_count` recorded.
- **`pending_retry`** — transient failure; `next_retry_at` and incremented `retry_count` set; will be re-dispatched.
- **`failed_permanently`** — auth/disconnected/expired failure, or retry budget exhausted; terminal.
- **`skipped`** — integration not syncable at dispatch time (disconnected / token expired before any provider call).

### Retry strategy (durable, no in-memory queue)

Retry state lives **entirely in Postgres** — there are no `setTimeout`s and no in-memory queues, so retries survive restarts, deploys, and crashes. Each scheduler tick queries for `pending_retry` rows whose `next_retry_at <= now` and re-dispatches them. Whichever instance is leader at that moment picks up whatever is due.

**Backoff schedule** (by attempt number):

| Attempt | Delay |
|---------|-------|
| 1 | immediate (0 ms) |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 15 minutes |
| 5 | 60 minutes |
| beyond `MAX_SYNC_RETRIES` | → `failed_permanently` |

**Permanent failures are never retried.** Auth errors, disconnected integrations, and expired tokens require a human to reconnect — retrying just hammers a dead credential and buries the actionable signal. These go straight to `failed_permanently`.

**Important implementation detail:** a dispatched retry **continues its own job row** rather than creating a new one. The tick passes the existing `job.id` into the executor, which calls `markRunning` to flip the row from `pending_retry` to `running`. Because the due-retry query filters on `status = 'pending_retry'`, the row is no longer returned once it's running. (An earlier version created a fresh row per retry and left the original perpetually "due," causing an infinite re-dispatch loop — now covered by a regression test.)

### Per-restaurant locking strategy

Independent of leader election, no two syncs for the same `(restaurant, provider)` may overlap — even across a scheduled run, a retry, and a user clicking "Run sync." This is enforced by a single atomic conditional UPDATE on `integration_sync_status.locked_at` (from the prior sprint): the update only matches a row whose lock is free or stale, and the number of affected rows tells you whether you won. A held lock older than 10 minutes is reclaimable (crash recovery), and a 90-second timeout race around each ingest releases a hung pull far sooner.

Even with a single leader this layer still matters, because a user can trigger a manual sync at any moment — the lock is what makes the manual button and the scheduler safe to coexist.

### Bounded concurrency

A tick processes due retries and freshly discovered integrations through a bounded-concurrency pool: at most `SYNC_MAX_CONCURRENCY` tasks run in flight at once, and at most `SYNC_BATCH_SIZE` integrations/retries are picked up per tick. Failures are isolated (`Promise.allSettled` semantics) so one broken restaurant never sinks the batch.

### Observability

- Structured JSON logs to stderr with a fixed event vocabulary: `LEADER_ACQUIRED`/`LEADER_LOST`, `SCHEDULER_TICK`, `SYNC_STARTED`/`SYNC_COMPLETED`/`SYNC_FAILED`, `RETRY_SCHEDULED`/`RETRY_EXECUTED`, `LOCK_ACQUIRED`/`LOCK_RELEASED`. Every line carries `event` and `ts` (and usually `instanceId`) so logs correlate across instances.
- `GET /api/integrations/sync-metrics` (auth-scoped to the caller's restaurant) returns `{ scheduler, metrics, integrations, recent_jobs }`, surfaced in the **Sync Health** dashboard at `/sync-health`: leader identity and last-tick info, aggregate success rate / durations / pending retries, per-provider failure detail, and the last 20 job rows. The page polls every 30 seconds.

### Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `DATABASE_URL` | _(unset)_ | Postgres connection string for the leader-election `pg.Client`. **Unset → sole-leader fallback** (single-instance dev/mock mode, no distributed coordination). Set it to enable advisory-lock leader election across instances. |
| `INSTANCE_ID` | `${hostname}-${pid}` | Human-readable identity recorded as the leader and shown in the dashboard. |
| `SYNC_INTERVAL_MINUTES` | `15` | Scheduler tick cadence. |
| `SYNC_BATCH_SIZE` | `50` | Max integrations/retries picked up per tick. |
| `SYNC_MAX_CONCURRENCY` | `5` | Max syncs running in parallel within a tick. |
| `MAX_SYNC_RETRIES` | `5` | Retry budget before a transient failure becomes `failed_permanently`. (Read at runtime so `.env` overrides are honored.) |
| `SYNC_SCHEDULER_ENABLED` | `true` | Set `false` to disable the scheduler entirely (one-off scripts / CI). |

### Architecture diagram

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
                     │ scheduler tick  (every SYNC_INTERVAL_MINUTES)
                     │   1. verify/acquire leadership
                     │   2. find due retry jobs
                     │   3. discover active integrations
                     │   4. record tick → scheduler_state
                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │   sync_jobs   (append-only durable job / retry queue)     │
        │   pending → running → success                             │
        │                     ↘ failed → pending_retry → … →        │
        │                                  failed_permanently       │
        │                     ↘ skipped (not syncable)              │
        └───────────────────────────┬──────────────────────────────┘
                                     │ per (restaurant, provider)
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
