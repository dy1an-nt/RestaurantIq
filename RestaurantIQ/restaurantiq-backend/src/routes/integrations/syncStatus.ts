import { Router, Request, Response } from 'express';
import { supabase } from '../../db';
import { authMiddleware } from '../../middleware/auth';
import { Provider, SyncStatus } from '../../services/syncScheduler';
import { isLeader, INSTANCE_ID } from '../../services/scheduler/leaderElection';
import {
  getRestaurantSyncMetrics,
  getRecentJobs,
  getProviderRetryInfo,
} from '../../services/scheduler/metrics';
import { countPendingRetries } from '../../services/scheduler/syncJobs';

const router = Router();

router.use(authMiddleware);

interface ProviderHealth {
  provider: Provider;
  connected: boolean;
  status: SyncStatus;
  last_success_at: string | null;
  last_attempted_at: string | null;
  last_error: string | null;
  retry_count: number;
  next_retry_at: string | null;
}

/**
 * GET /api/integrations/sync-status
 *
 * Returns per-provider sync health for the calling user's restaurant so the
 * Integrations page can show whether data is current, when it last refreshed,
 * and whether intervention is required (Sprint L, Goal 3).
 *
 * Connection state is derived from the restaurant row; the rest comes from the
 * integration_sync_status table the scheduler maintains. A provider with no
 * status row yet falls back to connected/disconnected based on the row.
 */
router.get('/sync-status', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const { data: restaurant, error: restErr } = await supabase
    .from('restaurants')
    .select('id, pos_connected, square_location_id, delivery_connected, doordash_store_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (restErr) {
    console.error('[sync-status] restaurant lookup failed:', restErr.message);
    return res.status(500).json({ data: null, error: 'Failed to load integration health' });
  }
  if (!restaurant) {
    return res.status(404).json({ data: null, error: 'No restaurant for this user' });
  }

  const { data: statusRows, error: statusErr } = await supabase
    .from('integration_sync_status')
    .select('provider, status, last_success_at, last_attempted_at, last_error')
    .eq('restaurant_id', restaurant.id);

  if (statusErr) {
    console.error('[sync-status] status lookup failed:', statusErr.message);
    return res.status(500).json({ data: null, error: 'Failed to load integration health' });
  }

  const byProvider = new Map<string, any>(
    (statusRows ?? []).map((r: any) => [r.provider, r]),
  );

  const build = (provider: Provider, connected: boolean): ProviderHealth => {
    const row = byProvider.get(provider);
    return {
      provider,
      connected,
      status: (row?.status as SyncStatus) ?? (connected ? 'connected' : 'disconnected'),
      last_success_at: row?.last_success_at ?? null,
      last_attempted_at: row?.last_attempted_at ?? null,
      last_error: row?.last_error ?? null,
      retry_count: 0,
      next_retry_at: null,
    };
  };

  const data: Record<Provider, ProviderHealth> = {
    square: build('square', !!restaurant.pos_connected && !!restaurant.square_location_id),
    doordash: build(
      'doordash',
      !!restaurant.delivery_connected && !!restaurant.doordash_store_id,
    ),
  };

  return res.json({ data, error: null });
});

/**
 * GET /api/integrations/sync-metrics
 *
 * Full scheduler + sync health for the calling user's restaurant (Sprint L+).
 * Includes:
 *   - scheduler: leader identity + last-tick metadata (global, from scheduler_state)
 *   - metrics: aggregate counts/rates scoped to this restaurant's sync_jobs
 *   - integrations: per-provider health with retry state
 *   - recent_jobs: last 20 sync job rows for this restaurant
 *
 * The frontend is built against the exact shape below — do not reorder or
 * rename fields without also updating the frontend contract.
 */
router.get('/sync-metrics', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  // ── Tenant lookup ──────────────────────────────────────────────────────────
  const { data: restaurant, error: restErr } = await supabase
    .from('restaurants')
    .select('id, pos_connected, square_location_id, delivery_connected, doordash_store_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (restErr) {
    console.error('[sync-metrics] restaurant lookup failed:', restErr.message);
    return res.status(500).json({ data: null, error: 'Failed to load sync metrics' });
  }
  if (!restaurant) {
    return res.status(404).json({ data: null, error: 'No restaurant for this user' });
  }

  const restaurantId = (restaurant as any).id as string;

  // ── Parallel data fetch ────────────────────────────────────────────────────
  const [
    statusRowsResult,
    schedulerStateResult,
    metrics,
    recentJobs,
    squareRetry,
    doordashRetry,
    pendingRetries,
  ] = await Promise.all([
    supabase
      .from('integration_sync_status')
      .select('provider, status, last_success_at, last_attempted_at, last_error')
      .eq('restaurant_id', restaurantId),
    supabase.from('scheduler_state').select('*').eq('id', 1).maybeSingle(),
    getRestaurantSyncMetrics(restaurantId),
    getRecentJobs(restaurantId, 20),
    getProviderRetryInfo(restaurantId, 'square'),
    getProviderRetryInfo(restaurantId, 'doordash'),
    countPendingRetries(restaurantId),
  ]);

  if (statusRowsResult.error) {
    console.error('[sync-metrics] status lookup failed:', statusRowsResult.error.message);
    return res.status(500).json({ data: null, error: 'Failed to load sync metrics' });
  }

  const byProvider = new Map<string, any>(
    ((statusRowsResult.data ?? []) as any[]).map((r: any) => [r.provider, r]),
  );

  const schedulerRow: any = schedulerStateResult.data ?? null;

  const buildProvider = (
    provider: Provider,
    connected: boolean,
    retry: { retry_count: number; next_retry_at: string | null },
  ): ProviderHealth => {
    const row = byProvider.get(provider);
    return {
      provider,
      connected,
      status: (row?.status as SyncStatus) ?? (connected ? 'connected' : 'disconnected'),
      last_success_at: row?.last_success_at ?? null,
      last_attempted_at: row?.last_attempted_at ?? null,
      last_error: row?.last_error ?? null,
      retry_count: retry.retry_count,
      next_retry_at: retry.next_retry_at,
    };
  };

  const responseData = {
    scheduler: {
      is_leader: isLeader(),
      leader_instance_id: schedulerRow?.leader_instance_id ?? null,
      leader_acquired_at: schedulerRow?.leader_acquired_at ?? null,
      last_tick_at: schedulerRow?.last_tick_at ?? null,
      last_tick_jobs_processed: schedulerRow?.last_tick_jobs_processed ?? 0,
      pending_retries: pendingRetries,
    },
    metrics,
    integrations: {
      square: buildProvider(
        'square',
        !!(restaurant as any).pos_connected && !!(restaurant as any).square_location_id,
        squareRetry,
      ),
      doordash: buildProvider(
        'doordash',
        !!(restaurant as any).delivery_connected && !!(restaurant as any).doordash_store_id,
        doordashRetry,
      ),
    },
    recent_jobs: recentJobs,
  };

  return res.json({ data: responseData, error: null });
});

export default router;
