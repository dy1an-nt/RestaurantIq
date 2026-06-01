/**
 * Sync metrics aggregator (Sprint L+).
 *
 * Aggregates data from sync_jobs for a single restaurant. Called by the
 * sync-metrics API route — all results are scoped to the calling user's
 * restaurant (tenant safety enforced at the route layer, not here).
 *
 * All counts are integers. success_rate is a float 0..1 (the only float in
 * the entire codebase — it is a ratio, not money, so the cents rule does not
 * apply). average_duration_ms is an integer (rounded).
 */

import { supabase } from '../../db';
import { SyncJob } from './syncJobs';
import { Provider } from '../syncScheduler';

export interface SyncMetrics {
  total_syncs: number;
  successful_syncs: number;
  failed_syncs: number;
  /** Ratio 0..1 (not a cent — this is the one sanctioned float in the system). */
  success_rate: number;
  average_duration_ms: number;
  retry_count: number;
  active_sync_count: number;
  last_successful_sync_at: string | null;
  last_failed_sync_at: string | null;
}

export interface ProviderRetryInfo {
  retry_count: number;
  next_retry_at: string | null;
}

/**
 * Compute aggregate sync metrics for a restaurant from the sync_jobs table.
 * Returns sensible zero-value defaults if the restaurant has no jobs yet.
 */
export const getRestaurantSyncMetrics = async (
  restaurantId: string,
): Promise<SyncMetrics> => {
  const { data, error } = await supabase
    .from('sync_jobs')
    .select(
      'status, duration_ms, retry_count, completed_at',
    )
    .eq('restaurant_id', restaurantId);

  if (error) {
    console.error('[metrics] getRestaurantSyncMetrics failed:', error.message);
    return {
      total_syncs: 0,
      successful_syncs: 0,
      failed_syncs: 0,
      success_rate: 0,
      average_duration_ms: 0,
      retry_count: 0,
      active_sync_count: 0,
      last_successful_sync_at: null,
      last_failed_sync_at: null,
    };
  }

  const rows = (data ?? []) as Array<{
    status: string;
    duration_ms: number | null;
    retry_count: number;
    completed_at: string | null;
  }>;

  // Terminal statuses only count toward total_syncs so "running" rows aren't
  // double-counted. pending/pending_retry are still in-flight.
  const terminal = rows.filter((r) =>
    ['success', 'failed', 'failed_permanently', 'skipped'].includes(r.status),
  );
  const successful = rows.filter((r) => r.status === 'success');
  const failed = rows.filter((r) =>
    r.status === 'failed' || r.status === 'failed_permanently',
  );
  const active = rows.filter((r) => r.status === 'running');

  const totalSyncs = terminal.length;
  const successfulSyncs = successful.length;
  const failedSyncs = failed.length;
  const successRate = totalSyncs > 0 ? successfulSyncs / totalSyncs : 0;

  const durationsMs = successful
    .map((r) => r.duration_ms)
    .filter((d): d is number => d !== null);
  const avgDurationMs =
    durationsMs.length > 0
      ? Math.round(durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length)
      : 0;

  const totalRetries = rows.reduce((sum, r) => sum + (r.retry_count ?? 0), 0);

  // Last timestamps — find the most recent completed_at for each terminal class.
  const lastSuccess = successful
    .map((r) => r.completed_at)
    .filter(Boolean)
    .sort()
    .reverse()[0] ?? null;
  const lastFailed = failed
    .map((r) => r.completed_at)
    .filter(Boolean)
    .sort()
    .reverse()[0] ?? null;

  return {
    total_syncs: totalSyncs,
    successful_syncs: successfulSyncs,
    failed_syncs: failedSyncs,
    success_rate: successRate,
    average_duration_ms: avgDurationMs,
    retry_count: totalRetries,
    active_sync_count: active.length,
    last_successful_sync_at: lastSuccess,
    last_failed_sync_at: lastFailed,
  };
};

/**
 * Fetch the most recent N sync jobs for a restaurant (up to 20), ordered
 * newest-first. Used to populate the recent_jobs feed in sync-metrics.
 */
export const getRecentJobs = async (
  restaurantId: string,
  limit = 20,
): Promise<SyncJob[]> => {
  const { data, error } = await supabase
    .from('sync_jobs')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[metrics] getRecentJobs failed:', error.message);
    return [];
  }
  return (data ?? []) as SyncJob[];
};

/**
 * Per-provider retry stats for a restaurant (used in the integrations section
 * of the sync-metrics response to give the frontend a per-provider retry_count
 * and next_retry_at).
 */
export const getProviderRetryInfo = async (
  restaurantId: string,
  provider: Provider,
): Promise<ProviderRetryInfo> => {
  // The most recent pending_retry row for this provider gives us the
  // current retry_count + next_retry_at.
  const { data, error } = await supabase
    .from('sync_jobs')
    .select('retry_count, next_retry_at')
    .eq('restaurant_id', restaurantId)
    .eq('provider', provider)
    .eq('status', 'pending_retry')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[metrics] getProviderRetryInfo failed:', error.message);
    return { retry_count: 0, next_retry_at: null };
  }
  if (!data) return { retry_count: 0, next_retry_at: null };
  return {
    retry_count: (data as any).retry_count ?? 0,
    next_retry_at: (data as any).next_retry_at ?? null,
  };
};
