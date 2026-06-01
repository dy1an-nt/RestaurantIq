/**
 * Automated integration sync scheduler (Sprint L).
 *
 * Before this, analytics only refreshed when a user pressed "Run sync". This
 * service makes synchronization automatic, observable, and resilient while
 * keeping SCHEDULING concerns separate from provider INGESTION logic — the
 * actual Square/DoorDash pulls still live in their own services. This module
 * only decides *when*, *whether*, and *one-at-a-time* a sync should run, and
 * records the outcome.
 *
 * Responsibilities:
 *   - discover active integrations across all restaurants
 *   - classify each integration's state (skip disconnected / token-expired)
 *   - acquire a per-restaurant/provider lock so two syncs never overlap
 *   - dispatch the provider-specific ingest handler
 *   - persist sync status metadata (status, timestamps, last error)
 *   - isolate failures so one restaurant can never break another
 *
 * Lock & status state live in the integration_sync_status table (migration 018).
 * Per-attempt audit rows live in sync_jobs (migration 019).
 */
import { supabase } from '../db';
import { OrderSource } from './ingestion/types';
import { ingestSquare } from './square/ingestSquare';
import { ingestDoorDash } from './doordash/ingestDoorDash';
import { isMockMode as squareMock } from './square/squareClient';
import { isMockMode as doordashMock } from './doordash/doordashClient';
import { logEvent } from './scheduler/logger';
import {
  createJob,
  markRunning,
  markSuccess,
  markFailedOrRetry,
  markSkipped,
  JobTrigger,
} from './scheduler/syncJobs';
import { nextRetryDelayMs } from './scheduler/retry';

export type Provider = OrderSource; // 'square' | 'doordash'

export type SyncStatus =
  | 'connected'
  | 'syncing'
  | 'success'
  | 'failed'
  | 'disconnected'
  | 'token_expired';

/** Why an integration was not synced (or that it was). */
export type IntegrationState = 'syncable' | 'disconnected' | 'token_expired';

export interface SyncOutcome {
  restaurantId: string;
  provider: Provider;
  /** Final state recorded for this attempt. */
  status: SyncStatus;
  /** True only when an ingest actually ran and succeeded. */
  ok: boolean;
  /** Set when the attempt was skipped before ingest (locked / not syncable). */
  skipped?: boolean;
  reason?: 'locked' | IntegrationState;
  error?: string;
  catalogCount?: number;
  orderCount?: number;
}

/** How long before a held lock is considered stale and may be reclaimed. */
export const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

/** Hard cap on a single ingest so a hung pull can't hold the lock forever. */
export const SYNC_TIMEOUT_MS = 90 * 1000; // 90 seconds

/** Default cadence when SYNC_INTERVAL_MINUTES is unset. */
const DEFAULT_INTERVAL_MINUTES = 15;

// ── Restaurant credential shape needed to discover + classify ────────────────
interface RestaurantRow {
  id: string;
  pos_connected: boolean | null;
  square_location_id: string | null;
  square_access_token: string | null;
  square_refresh_token: string | null;
  square_token_expires_at: string | null;
  delivery_connected: boolean | null;
  doordash_store_id: string | null;
  doordash_access_token: string | null;
  doordash_refresh_token: string | null;
  doordash_token_expires_at: string | null;
}

const isMockMode = (provider: Provider): boolean =>
  provider === 'square' ? squareMock() : doordashMock();

const ingestFor = (provider: Provider, restaurantId: string) =>
  provider === 'square' ? ingestSquare(restaurantId) : ingestDoorDash(restaurantId);

/**
 * Decide whether a provider on a restaurant can be synced right now. This is the
 * pre-flight that lets the scheduler SKIP integrations that cannot be synced
 * (Goal 5) instead of hammering the provider with a dead token.
 *
 * In mock mode the ingest generates its own data and ignores tokens, so a
 * connected integration is always syncable.
 */
export const classifyIntegration = (
  row: RestaurantRow,
  provider: Provider,
): IntegrationState => {
  const connected =
    provider === 'square'
      ? !!row.pos_connected && !!row.square_location_id
      : !!row.delivery_connected && !!row.doordash_store_id;

  if (!connected) return 'disconnected';
  if (isMockMode(provider)) return 'syncable';

  const accessToken =
    provider === 'square' ? row.square_access_token : row.doordash_access_token;
  if (!accessToken) return 'disconnected'; // connected flag set but no credential

  const expiresAtRaw =
    provider === 'square'
      ? row.square_token_expires_at
      : row.doordash_token_expires_at;
  const refreshToken =
    provider === 'square' ? row.square_refresh_token : row.doordash_refresh_token;

  if (expiresAtRaw) {
    const expired = new Date(expiresAtRaw).getTime() <= Date.now();
    // Expired AND no refresh token to recover with → cannot sync, needs re-auth.
    if (expired && !refreshToken) return 'token_expired';
  }

  return 'syncable';
};

/**
 * Which (restaurant, provider) pairs have an integration worth touching. We
 * include anything that has ever been connected (id present OR connected flag)
 * so that disconnected / expired states still get a fresh status row + are
 * surfaced in the UI, rather than silently vanishing.
 */
export const discoverActiveIntegrations = async (): Promise<
  Array<{ row: RestaurantRow; provider: Provider }>
> => {
  const { data, error } = await supabase
    .from('restaurants')
    .select(
      'id, pos_connected, square_location_id, square_access_token, square_refresh_token, square_token_expires_at, delivery_connected, doordash_store_id, doordash_access_token, doordash_refresh_token, doordash_token_expires_at',
    );

  if (error) {
    console.error('[sync] failed to discover integrations:', error.message);
    return [];
  }

  const out: Array<{ row: RestaurantRow; provider: Provider }> = [];
  for (const row of (data ?? []) as RestaurantRow[]) {
    if (row.pos_connected || row.square_location_id) out.push({ row, provider: 'square' });
    if (row.delivery_connected || row.doordash_store_id) {
      out.push({ row, provider: 'doordash' });
    }
  }
  return out;
};

/**
 * Ensure a status row exists for (restaurant, provider) without disturbing an
 * existing one. ignoreDuplicates means a concurrent/held lock is never clobbered.
 */
const ensureStatusRow = async (restaurantId: string, provider: Provider) => {
  const { error } = await supabase.from('integration_sync_status').upsert(
    {
      restaurant_id: restaurantId,
      provider,
      status: 'connected',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'restaurant_id,provider', ignoreDuplicates: true },
  );
  if (error) console.error('[sync] ensureStatusRow failed:', error.message);
};

/** Write a terminal status without acquiring the lock (used for skips). */
const setStatus = async (
  restaurantId: string,
  provider: Provider,
  status: SyncStatus,
  error?: string | null,
) => {
  const { error: dbErr } = await supabase
    .from('integration_sync_status')
    .update({
      status,
      last_error: error ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('restaurant_id', restaurantId)
    .eq('provider', provider);
  if (dbErr) console.error('[sync] setStatus failed:', dbErr.message);
};

/**
 * Atomically acquire the per-restaurant/provider sync lock.
 *
 * This is ONE conditional UPDATE: it only matches a row whose lock is free
 * (locked_at IS NULL) or stale (older than LOCK_STALE_MS). Postgres serializes
 * concurrent updaters of the same row, so exactly one acquires the lock and the
 * loser's WHERE no longer matches → it gets back zero rows. That is the mutex
 * that prevents overlapping syncs (Goal 4) — whether the contenders are two
 * scheduler ticks or a scheduled run racing a manual one.
 *
 * Returns true if the lock was acquired.
 */
export const acquireLock = async (
  restaurantId: string,
  provider: Provider,
): Promise<boolean> => {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - LOCK_STALE_MS).toISOString();

  const { data, error } = await supabase
    .from('integration_sync_status')
    .update({
      status: 'syncing',
      locked_at: now.toISOString(),
      last_attempted_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('restaurant_id', restaurantId)
    .eq('provider', provider)
    .or(`locked_at.is.null,locked_at.lt.${staleCutoff}`)
    .select('id');

  if (error) {
    console.error('[sync] acquireLock failed:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
};

/** Release the lock and record the terminal status of the attempt. */
const releaseLock = async (
  restaurantId: string,
  provider: Provider,
  status: SyncStatus,
  error?: string | null,
) => {
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    status,
    locked_at: null,
    last_error: error ?? null,
    updated_at: now,
  };
  if (status === 'success') updates.last_success_at = now;

  const { error: dbErr } = await supabase
    .from('integration_sync_status')
    .update(updates)
    .eq('restaurant_id', restaurantId)
    .eq('provider', provider);
  if (dbErr) console.error('[sync] releaseLock failed:', dbErr.message);
};

/**
 * A refresh failure surfaces as a thrown error from the ingest path. Square's
 * ingest throws "...disconnected — reconnect required." and DoorDash falls back
 * to a dead token that yields a 401. Map those to token_expired so the UI can
 * tell "needs re-auth" apart from a transient failure.
 */
const isAuthError = (message: string): boolean =>
  /disconnect|reconnect|re-auth|401|unauthor|token/i.test(message);

/**
 * Sync a single integration end-to-end with locking + status tracking. Shared by
 * the scheduler AND the manual /sync routes, so a manual press can never
 * duplicate an in-flight scheduled run (it just gets reason: 'locked').
 *
 * Never throws — every failure is captured into the returned outcome and the
 * status table, so a caller iterating many integrations is fully isolated.
 *
 * Sprint L+ additions:
 *   - Creates a sync_jobs row for every attempt (audit trail + retry state).
 *   - Computes retry backoff for transient failures (not auth/disconnect).
 *   - Accepts retryCount so retry dispatches increment the counter correctly.
 *   - Accepts existingJobId so a dispatched retry CONTINUES its own sync_jobs
 *     row rather than spawning a new one. This is what lets a retry leave the
 *     pending_retry state: markRunning(existingJobId) flips the row to running,
 *     so findDueRetryJobs no longer returns it. Without this the same retry row
 *     stays "due" forever and re-dispatches on every tick.
 */
export const syncIntegration = async (
  row: RestaurantRow,
  provider: Provider,
  source: 'scheduled' | 'manual' | 'retry' = 'scheduled',
  retryCount = 0,
  existingJobId: string | null = null,
): Promise<SyncOutcome> => {
  const restaurantId = row.id;
  await ensureStatusRow(restaurantId, provider);

  // 1. Respect integration state — skip anything not syncable.
  const state = classifyIntegration(row, provider);
  if (state !== 'syncable') {
    await setStatus(restaurantId, provider, state);
    // A dispatched retry whose integration is now disconnected/expired must
    // CONSUME its existing row (markSkipped → leaves pending_retry); otherwise
    // create a fresh audit row.
    const jobId =
      existingJobId ?? (await createJob({ restaurantId, provider, trigger: source as JobTrigger }));
    if (jobId) {
      // Permanent skips (disconnected/token_expired) are marked permanently failed.
      await markSkipped(jobId, { reason: state });
    }
    logEvent('SYNC_FAILED', { restaurantId, provider, source, reason: state, permanent: true });
    return { restaurantId, provider, status: state, ok: false, skipped: true, reason: state };
  }

  // 2. Acquire the lock — prevents overlapping runs.
  const locked = await acquireLock(restaurantId, provider);
  if (!locked) {
    logEvent('SYNC_FAILED', { restaurantId, provider, source, reason: 'locked' });
    return { restaurantId, provider, status: 'syncing', ok: false, skipped: true, reason: 'locked' };
  }
  logEvent('LOCK_ACQUIRED', { restaurantId, provider, source });

  // Continue the dispatched retry's own row, or create a fresh one now that the
  // lock is held. markRunning flips a reused pending_retry row to running, so a
  // consumed retry job no longer appears in findDueRetryJobs.
  const jobId =
    existingJobId ?? (await createJob({ restaurantId, provider, trigger: source as JobTrigger }));
  if (jobId) await markRunning(jobId);
  logEvent('SYNC_STARTED', { restaurantId, provider, source, retryCount, jobId });

  // 3. Run the provider ingest under a hard timeout; release the lock no matter what.
  const startedAt = Date.now();
  try {
    const result = await Promise.race([
      ingestFor(provider, restaurantId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Sync timed out')), SYNC_TIMEOUT_MS),
      ),
    ]);
    const durationMs = Date.now() - startedAt;
    await releaseLock(restaurantId, provider, 'success', null);
    logEvent('LOCK_RELEASED', { restaurantId, provider, source, status: 'success' });
    if (jobId) {
      await markSuccess(jobId, {
        durationMs,
        catalogCount: result.catalogCount,
        orderCount: result.orderCount,
      });
    }
    logEvent('SYNC_COMPLETED', {
      restaurantId,
      provider,
      source,
      ms: durationMs,
      catalogCount: result.catalogCount,
      orderCount: result.orderCount,
      jobId,
    });
    return {
      restaurantId,
      provider,
      status: 'success',
      ok: true,
      catalogCount: result.catalogCount,
      orderCount: result.orderCount,
    };
  } catch (err: any) {
    const message = err?.message ?? 'Sync failed';
    const durationMs = Date.now() - startedAt;
    const authFail = isAuthError(message);
    const status: SyncStatus = authFail ? 'token_expired' : 'failed';
    await releaseLock(restaurantId, provider, status, message);
    logEvent('LOCK_RELEASED', { restaurantId, provider, source, status });

    if (jobId) {
      // The integration was 'syncable' at pre-flight, so a failure here is
      // either an auth/credential failure that surfaced mid-sync (permanent —
      // needs human re-auth, retrying would just hammer a dead token) or a
      // transient error (provider 5xx, timeout, network) that should back off
      // and retry until the budget is spent.
      if (authFail) {
        await markFailedOrRetry(jobId, {
          retryCount: retryCount + 1,
          error: message,
          nextRetryAt: null, // permanent — no automatic retry
        });
      } else {
        const nextAttempt = retryCount + 1;
        const delayMs = nextRetryDelayMs(nextAttempt);
        const nextRetryAt = delayMs !== null ? new Date(Date.now() + delayMs) : null;
        await markFailedOrRetry(jobId, {
          retryCount: nextAttempt,
          error: message,
          nextRetryAt, // null once the budget is exhausted → failed_permanently
        });
        if (nextRetryAt) {
          logEvent('RETRY_SCHEDULED', {
            restaurantId,
            provider,
            source,
            retryCount: nextAttempt,
            nextRetryAt: nextRetryAt.toISOString(),
            delayMs,
            jobId,
          });
        }
      }
    }

    logEvent('SYNC_FAILED', {
      restaurantId,
      provider,
      source,
      ms: durationMs,
      status,
      error: message,
      jobId,
    });
    return { restaurantId, provider, status, ok: false, error: message };
  }
};

let running = false;

/**
 * One scheduler tick: discover every active integration and sync each one
 * independently. Promise.allSettled + the never-throwing syncIntegration mean a
 * single restaurant's failure cannot stop the others or abort the run (Goal 6).
 *
 * Guarded so two ticks can't overlap at the dispatcher level even before the
 * per-restaurant locks come into play.
 */
export const runScheduledSync = async (): Promise<SyncOutcome[]> => {
  if (running) {
    console.error('[sync] tick skipped — previous run still in progress');
    return [];
  }
  running = true;
  const startedAt = Date.now();
  try {
    const integrations = await discoverActiveIntegrations();
    const settled = await Promise.allSettled(
      integrations.map(({ row, provider }) => syncIntegration(row, provider, 'scheduled')),
    );
    const outcomes = settled
      .filter((s): s is PromiseFulfilledResult<SyncOutcome> => s.status === 'fulfilled')
      .map((s) => s.value);

    const summary = outcomes.reduce(
      (acc, o) => {
        if (o.ok) acc.synced += 1;
        else if (o.skipped) acc.skipped += 1;
        else acc.failed += 1;
        return acc;
      },
      { synced: 0, skipped: 0, failed: 0 },
    );
    console.error(
      `[sync] tick complete ${JSON.stringify({
        integrations: integrations.length,
        ...summary,
        ms: Date.now() - startedAt,
      })}`,
    );
    return outcomes;
  } finally {
    running = false;
  }
};

let timer: NodeJS.Timeout | null = null;

const intervalMs = (): number => {
  const minutes = Number(process.env.SYNC_INTERVAL_MINUTES);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_INTERVAL_MINUTES;
  return safe * 60 * 1000;
};

/**
 * Start the recurring scheduler. Called once from server.ts after the HTTP
 * listener is up, so connected integrations stay current with zero user
 * interaction. Idempotent — a second call is a no-op.
 *
 * Disable with SYNC_SCHEDULER_ENABLED=false (e.g. for one-off scripts).
 */
export const startSyncScheduler = (): void => {
  if (timer) return;
  if (process.env.SYNC_SCHEDULER_ENABLED === 'false') {
    console.error('[sync] scheduler disabled via SYNC_SCHEDULER_ENABLED=false');
    return;
  }

  const ms = intervalMs();
  console.error(`[sync] scheduler starting — interval ${ms / 60000} min`);

  // Kick an initial run shortly after boot so data is fresh immediately, then
  // settle into the configured cadence. Errors are swallowed by runScheduledSync.
  setTimeout(() => void runScheduledSync(), 5_000);

  timer = setInterval(() => void runScheduledSync(), ms);
  // Don't keep the event loop alive solely for the scheduler.
  if (typeof timer.unref === 'function') timer.unref();
};

/** Stop the scheduler (tests / graceful shutdown). */
export const stopSyncScheduler = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
