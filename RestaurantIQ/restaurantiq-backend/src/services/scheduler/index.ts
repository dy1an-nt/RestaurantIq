/**
 * Distributed sync scheduler — tick driver and lifecycle (Sprint L+).
 *
 * This module coordinates the scheduler loop for the leader instance. On every
 * tick it:
 *   1. Verifies (or acquires) the Postgres advisory lock — only the leader runs.
 *   2. Processes due retry jobs (pending_retry rows whose next_retry_at <= now).
 *   3. Discovers all active integrations and dispatches fresh syncs, skipping
 *      any (restaurant, provider) already synced by step 2 this tick, and
 *      taking the least-recently-attempted first so the batch cap rotates.
 *   4. Records tick metadata in scheduler_state for health observability.
 *
 * Concurrency:
 *   - SYNC_MAX_CONCURRENCY (default 5) limits how many integrations run in
 *     parallel per tick so we don't hammer the DB or provider APIs.
 *   - SYNC_BATCH_SIZE (default 50) caps how many integrations/retries we pick
 *     up in a single tick.
 *
 * server.ts should call startScheduler() once after the HTTP listener is up,
 * and stopScheduler() on SIGTERM/SIGINT for graceful shutdown. This module is
 * the only scheduler entry point; syncScheduler.ts owns executing one sync,
 * not deciding when syncs happen.
 */

import { supabase } from '../../db';
import {
  discoverActiveIntegrations,
  syncIntegration,
} from '../syncScheduler';
import {
  isLeader,
  acquireLeadership,
  verifyLeadership,
  releaseLeadership,
  INSTANCE_ID,
} from './leaderElection';
import { logEvent } from './logger';
import { findDueRetryJobs } from './syncJobs';

// ── Config (read inside functions, not at module load — env not set yet) ──────

const batchSize = (): number => {
  const n = Number(process.env.SYNC_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? n : 50;
};

const maxConcurrency = (): number => {
  const n = Number(process.env.SYNC_MAX_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? n : 5;
};

const intervalMs = (): number => {
  const minutes = Number(process.env.SYNC_INTERVAL_MINUTES);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
  return safe * 60 * 1000;
};

// ── Concurrency limiter ───────────────────────────────────────────────────────

/**
 * Run `tasks` with at most `limit` in-flight at a time. Returns all settled
 * results in the original order (Promise.allSettled semantics).
 */
async function concurrentMap<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let nextIdx = 0;

  const worker = async () => {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      try {
        results[idx] = { status: 'fulfilled', value: await tasks[idx]() };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Tick ─────────────────────────────────────────────────────────────────────

/** Identity of one syncable integration, for per-tick de-duplication. */
const pairKey = (restaurantId: string, provider: string): string =>
  `${restaurantId}:${provider}`;

/**
 * Order integrations least-recently-attempted first.
 *
 * Discovery returns every integration in whatever order Postgres hands back,
 * and the tick then keeps only the first SYNC_BATCH_SIZE of them. Past that
 * many integrations the tail was not merely delayed, it was never selected at
 * all. Sorting by last attempt turns a fixed prefix into a rotation: whoever
 * has waited longest goes first, and an integration that has never synced
 * sorts ahead of every integration that has.
 *
 * Best effort. If the status lookup fails the tick still runs, just in the
 * unordered discovery order it used before.
 */
const prioritizeByStaleness = async <
  T extends { row: { id: string }; provider: string },
>(
  integrations: T[],
): Promise<T[]> => {
  if (integrations.length === 0) return integrations;

  const { data, error } = await supabase
    .from('integration_sync_status')
    .select('restaurant_id, provider, last_attempted_at');

  if (error) {
    logEvent('SCHEDULER_PRIORITY_UNAVAILABLE', { error: error.message });
    return integrations;
  }

  const lastAttempt = new Map<string, number>();
  for (const r of (data ?? []) as Array<{
    restaurant_id: string;
    provider: string;
    last_attempted_at: string | null;
  }>) {
    lastAttempt.set(
      pairKey(r.restaurant_id, r.provider),
      r.last_attempted_at ? new Date(r.last_attempted_at).getTime() : 0,
    );
  }

  // Missing row means never attempted, which sorts first.
  return [...integrations].sort(
    (a, b) =>
      (lastAttempt.get(pairKey(a.row.id, a.provider)) ?? 0) -
      (lastAttempt.get(pairKey(b.row.id, b.provider)) ?? 0),
  );
};

let ticking = false;

/** Update scheduler_state with last-tick metadata. Fire-and-forget. */
const recordTick = async (jobsProcessed: number, durationMs: number): Promise<void> => {
  const { error } = await supabase.from('scheduler_state').upsert(
    {
      id: 1,
      leader_instance_id: INSTANCE_ID,
      last_tick_at: new Date().toISOString(),
      last_tick_jobs_processed: jobsProcessed,
      last_tick_duration_ms: durationMs,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) {
    console.error(
      JSON.stringify({
        event: 'SCHEDULER_STATE_TICK_FAILED',
        ts: new Date().toISOString(),
        error: error.message,
      }),
    );
  }
};

/**
 * One complete scheduler tick. Safe to call directly in tests.
 * Returns the count of jobs processed (retries + fresh syncs dispatched).
 */
export const runSchedulerTick = async (): Promise<number> => {
  if (ticking) {
    logEvent('SCHEDULER_TICK', { skipped: true, reason: 'previous tick still running' });
    return 0;
  }
  ticking = true;
  const tickStart = Date.now();

  try {
    // ── 1. Leadership check ────────────────────────────────────────────────
    const leader = isLeader() ? await verifyLeadership() : await acquireLeadership();
    if (!leader) {
      logEvent('SCHEDULER_TICK', { leader: false, instanceId: INSTANCE_ID });
      return 0;
    }

    let jobsProcessed = 0;
    const limit = batchSize();
    const concurrency = maxConcurrency();
    /** (restaurant, provider) pairs already dispatched by the retry phase. */
    const syncedThisTick = new Set<string>();

    // ── 2. Retry processing ────────────────────────────────────────────────
    const now = new Date();
    const retryJobs = await findDueRetryJobs(now, limit);

    if (retryJobs.length > 0) {
      // We need the restaurant row to call syncIntegration. Fetch all at once.
      const retryRestaurantIds = [...new Set(retryJobs.map((j) => j.restaurant_id))];
      const { data: retryRestaurantRows } = await supabase
        .from('restaurants')
        .select(
          'id, pos_connected, square_location_id, square_access_token, square_refresh_token, square_token_expires_at, delivery_connected, doordash_store_id, doordash_access_token, doordash_refresh_token, doordash_token_expires_at',
        )
        .in('id', retryRestaurantIds);

      const rowById = new Map(
        ((retryRestaurantRows ?? []) as Array<{ id: string } & Record<string, any>>).map(
          (r) => [r.id, r],
        ),
      );

      const retryTasks = retryJobs.map((job) => async () => {
        const row = rowById.get(job.restaurant_id);
        if (!row) return;
        // Claim this pair so discovery below does not sync it a second time
        // in the same tick. Claimed before the await, not after, so a retry
        // that fails still counts as this tick's attempt for the pair rather
        // than being immediately re-run as a fresh scheduled sync.
        syncedThisTick.add(pairKey(job.restaurant_id, job.provider));
        logEvent('RETRY_EXECUTED', {
          restaurantId: job.restaurant_id,
          provider: job.provider,
          retryCount: job.retry_count,
          jobId: job.id,
        });
        // Pass job.id so the retry continues THIS row (markRunning flips it out
        // of pending_retry) instead of spawning a new one and leaving the
        // original perpetually due.
        await syncIntegration(row as any, job.provider as any, 'retry', job.retry_count, job.id);
        jobsProcessed++;
      });

      await concurrentMap(retryTasks, concurrency);
    }

    // ── 3. Discovery + dispatch ────────────────────────────────────────────
    // A retry that just ran released its lock, so without this filter the same
    // integration would sync twice in one tick and burn double provider quota.
    const discovered = (await discoverActiveIntegrations()).filter(
      ({ row, provider }) => !syncedThisTick.has(pairKey(row.id, provider)),
    );
    const integrations = await prioritizeByStaleness(discovered);
    const batch = integrations.slice(0, limit);

    // Truncation is normal once there are more integrations than one tick's
    // budget, but it must be visible: silently dropping the tail is how the
    // batch cap looked like a working scheduler while starving the tail.
    if (integrations.length > batch.length) {
      logEvent('SCHEDULER_BATCH_TRUNCATED', {
        discovered: integrations.length,
        dispatched: batch.length,
        deferred: integrations.length - batch.length,
        limit,
      });
    }

    const freshTasks = batch.map(({ row, provider }) => async () => {
      await syncIntegration(row, provider, 'scheduled');
      jobsProcessed++;
    });

    await concurrentMap(freshTasks, concurrency);

    // ── 4. Record tick metadata ────────────────────────────────────────────
    const durationMs = Date.now() - tickStart;
    await recordTick(jobsProcessed, durationMs);
    logEvent('SCHEDULER_TICK', {
      leader: true,
      instanceId: INSTANCE_ID,
      jobsProcessed,
      retries: retryJobs.length,
      integrations: batch.length,
      ms: durationMs,
    });

    return jobsProcessed;
  } finally {
    ticking = false;
  }
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;

/**
 * Start the recurring scheduler. Idempotent — a second call is a no-op.
 * Kicks an initial tick ~5 s after boot, then settles into the configured
 * cadence. The timer is unref()'d so it doesn't keep the process alive.
 * Disable entirely with SYNC_SCHEDULER_ENABLED=false.
 */
export const startScheduler = (): void => {
  if (timer) return;
  if (process.env.SYNC_SCHEDULER_ENABLED === 'false') {
    console.error(
      JSON.stringify({
        event: 'SCHEDULER_DISABLED',
        ts: new Date().toISOString(),
        reason: 'SYNC_SCHEDULER_ENABLED=false',
      }),
    );
    return;
  }

  const ms = intervalMs();
  console.error(
    JSON.stringify({
      event: 'SCHEDULER_STARTING',
      ts: new Date().toISOString(),
      intervalMs: ms,
      instanceId: INSTANCE_ID,
    }),
  );

  // Small initial delay so the HTTP listener is fully up before first tick.
  // unref()'d and tracked so it can't keep the process alive or fire during
  // a graceful shutdown that lands inside the 5 s window.
  bootTimer = setTimeout(() => void runSchedulerTick(), 5_000);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();

  timer = setInterval(() => void runSchedulerTick(), ms);
  if (typeof timer.unref === 'function') timer.unref();
};

/**
 * Stop the scheduler and release the leader lock (graceful shutdown).
 * Called by SIGTERM/SIGINT handlers in server.ts.
 */
export const stopScheduler = async (): Promise<void> => {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await releaseLeadership();
};
