/**
 * Repository over the sync_jobs table (Sprint L+).
 *
 * sync_jobs is an append-only audit log — one row per sync attempt. This
 * module exposes typed helpers that hide the raw Supabase calls from the
 * scheduler and executor. Every function follows the "money = cents, no
 * floats" convention (not directly applicable here, but durations are integers
 * in ms). All writes are fire-and-mostly-forget: failures are logged with
 * console.error but never thrown, since a job-tracking write failing must not
 * abort the underlying ingest.
 */

import { supabase } from '../../db';
import { Provider } from '../syncScheduler';

export type JobTrigger = 'scheduled' | 'manual' | 'retry';

export type JobStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'pending_retry'
  | 'failed_permanently'
  | 'skipped';

export interface SyncJob {
  id: string;
  restaurant_id: string;
  provider: Provider;
  trigger: JobTrigger;
  status: JobStatus;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  retry_count: number;
  last_error: string | null;
  next_retry_at: string | null;
  catalog_count: number | null;
  order_count: number | null;
  created_at: string;
  updated_at: string;
}

// ── Write helpers ────────────────────────────────────────────────────────────

/**
 * Insert a new pending job row. Returns the new job id so subsequent calls
 * can update it. Returns null on insert failure (caller can still proceed
 * without job tracking — the ingest is not blocked).
 */
export const createJob = async (params: {
  restaurantId: string;
  provider: Provider;
  trigger: JobTrigger;
}): Promise<string | null> => {
  const { data, error } = await supabase
    .from('sync_jobs')
    .insert({
      restaurant_id: params.restaurantId,
      provider: params.provider,
      trigger: params.trigger,
      status: 'pending',
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    console.error('[syncJobs] createJob failed:', error.message);
    return null;
  }
  return (data as { id: string }).id;
};

/** Mark the job as actively running (lock acquired, ingest starting). */
export const markRunning = async (jobId: string): Promise<void> => {
  const { error } = await supabase
    .from('sync_jobs')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  if (error) console.error('[syncJobs] markRunning failed:', error.message);
};

/** Mark the job as successfully completed with ingest counts. */
export const markSuccess = async (
  jobId: string,
  params: { durationMs: number; catalogCount?: number; orderCount?: number },
): Promise<void> => {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('sync_jobs')
    .update({
      status: 'success',
      completed_at: now,
      duration_ms: params.durationMs,
      catalog_count: params.catalogCount ?? null,
      order_count: params.orderCount ?? null,
      last_error: null,
      updated_at: now,
    })
    .eq('id', jobId);

  if (error) console.error('[syncJobs] markSuccess failed:', error.message);
};

/**
 * Mark a failed job as either pending_retry (if nextRetryAt is set and retry
 * count is within budget) or failed_permanently (if the budget is exhausted
 * or the failure is permanent). Sets completed_at only on terminal statuses.
 */
export const markFailedOrRetry = async (
  jobId: string,
  params: {
    retryCount: number;
    error: string;
    nextRetryAt: Date | null;
  },
): Promise<void> => {
  const now = new Date().toISOString();
  const isTerminal = params.nextRetryAt === null;
  const { error: dbErr } = await supabase
    .from('sync_jobs')
    .update({
      status: isTerminal ? 'failed_permanently' : 'pending_retry',
      retry_count: params.retryCount,
      last_error: params.error,
      next_retry_at: params.nextRetryAt ? params.nextRetryAt.toISOString() : null,
      completed_at: isTerminal ? now : null,
      updated_at: now,
    })
    .eq('id', jobId);

  if (dbErr) console.error('[syncJobs] markFailedOrRetry failed:', dbErr.message);
};

/** Mark a job as skipped (integration not syncable, or lock already held). */
export const markSkipped = async (
  jobId: string,
  params: { reason: string },
): Promise<void> => {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('sync_jobs')
    .update({
      status: 'skipped',
      completed_at: now,
      last_error: params.reason,
      updated_at: now,
    })
    .eq('id', jobId);

  if (error) console.error('[syncJobs] markSkipped failed:', error.message);
};

// ── Query helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch retry jobs whose next_retry_at is due. The scheduler calls this at
 * the start of every tick to recover durable retry state across restarts.
 *
 * @param now   - cutoff timestamp (jobs with next_retry_at <= now are returned)
 * @param limit - max rows to return (SYNC_BATCH_SIZE)
 */
export const findDueRetryJobs = async (
  now: Date,
  limit: number,
): Promise<SyncJob[]> => {
  const { data, error } = await supabase
    .from('sync_jobs')
    .select('*')
    .eq('status', 'pending_retry')
    .lte('next_retry_at', now.toISOString())
    .order('next_retry_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[syncJobs] findDueRetryJobs failed:', error.message);
    return [];
  }
  return (data ?? []) as SyncJob[];
};

/** Count pending_retry jobs for a restaurant (used in sync-metrics). */
export const countPendingRetries = async (restaurantId: string): Promise<number> => {
  const { count, error } = await supabase
    .from('sync_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .eq('status', 'pending_retry');

  if (error) {
    console.error('[syncJobs] countPendingRetries failed:', error.message);
    return 0;
  }
  return count ?? 0;
};

/** Count actively running jobs for a restaurant (prevents double-dispatch). */
export const countActive = async (restaurantId: string): Promise<number> => {
  const { count, error } = await supabase
    .from('sync_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .eq('status', 'running');

  if (error) {
    console.error('[syncJobs] countActive failed:', error.message);
    return 0;
  }
  return count ?? 0;
};
