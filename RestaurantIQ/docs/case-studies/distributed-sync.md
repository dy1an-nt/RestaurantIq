# Case Study: Making Integration Sync Durable

## The problem

RestaurantIQ originally depended on a restaurant owner pressing a sync button. That was acceptable while proving the Square and DoorDash ingestion paths, but it was not a reliable operating model. Once I automated syncs, I also had to prevent a scheduled run, a retry, and a manual request from processing the same restaurant at the same time.

The problem became harder when I considered multiple Railway instances. An in-memory lock would protect only one Node process and would disappear during a restart. I needed coordination that survived deploys and worked across processes.

## What I chose

I split coordination into three layers:

1. A PostgreSQL session-level advisory lock elects one scheduler leader.
2. A conditional update on `integration_sync_status.locked_at` prevents overlapping work for the same restaurant and provider.
3. A `sync_jobs` row records each attempt, its outcome, and any scheduled retry.

The leader lock requires a persistent database session, so I used a dedicated [`pg.Client`](../../restaurantiq-backend/src/services/scheduler/leaderElection.ts). Supabase's PostgREST API cannot safely hold a session-level advisory lock because separate HTTP requests may use different pooled database connections.

The per-integration lock is a compare-and-set operation. The update succeeds only when `locked_at` is empty or stale. This keeps the check and state change in one database operation instead of creating a read-then-write race.

## Making retries survive restarts

I kept retry state in PostgreSQL rather than `setTimeout` callbacks. [`syncJobs.ts`](../../restaurantiq-backend/src/services/scheduler/syncJobs.ts) stores `pending_retry`, `next_retry_at`, and `retry_count`. Each scheduler tick queries for due jobs and resumes them.

The backoff policy is deterministic and isolated in [`retry.ts`](../../restaurantiq-backend/src/services/scheduler/retry.ts). Transient failures progress through bounded delays. Authentication and disconnected-integration failures become permanent immediately because retrying a credential that needs human action only adds noise and provider traffic.

One failure exposed an important queue invariant. The first retry implementation created a new row but left the original row in `pending_retry`, so the same original job remained eligible forever. I changed retries to continue their existing row and move it to `running` before work begins. The diagnosis is recorded in [bug 10](../bugs.md#10-infinite-retry-loop-in-the-sync-scheduler).

## Tradeoffs

- Without `DATABASE_URL`, the scheduler treats the process as the only leader. That keeps local development simple but is safe only for a single backend instance.
- The scheduler is still an in-process timer. PostgreSQL makes its state durable, but an external queue or managed scheduler would provide stronger operational isolation at larger scale.
- `sync_jobs` provides a useful audit trail, but it needs a retention policy before the table grows indefinitely.

## Evidence

- [`leaderElection.ts`](../../restaurantiq-backend/src/services/scheduler/leaderElection.ts): persistent-session leader election and failover
- [`index.ts`](../../restaurantiq-backend/src/services/scheduler/index.ts): bounded-concurrency scheduler tick
- [`syncJobs.ts`](../../restaurantiq-backend/src/services/scheduler/syncJobs.ts): durable job state
- [`019_sync_jobs.sql`](../../restaurantiq-backend/migrations/019_sync_jobs.sql): job lifecycle and indexes
- [`schedulerTick.test.ts`](../../restaurantiq-backend/src/services/scheduler/__tests__/schedulerTick.test.ts): retry and dispatch behavior
- Historical sources: [Sprint L](../archive/sprint-notes/week-L.md) and [Sprint L+](../archive/sprint-notes/week-L-plus.md)
