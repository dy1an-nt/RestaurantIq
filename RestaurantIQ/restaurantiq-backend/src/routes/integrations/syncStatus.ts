import { Router, Request, Response } from 'express';
import { supabase } from '../../db';
import { authMiddleware } from '../../middleware/auth';
import { Provider, SyncStatus } from '../../services/syncScheduler';

const router = Router();

router.use(authMiddleware);

interface ProviderHealth {
  provider: Provider;
  connected: boolean;
  status: SyncStatus;
  last_success_at: string | null;
  last_attempted_at: string | null;
  last_error: string | null;
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

export default router;
