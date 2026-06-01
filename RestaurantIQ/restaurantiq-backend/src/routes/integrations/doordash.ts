import { Router, Request, Response } from 'express';
import { supabase } from '../../db';
import { authMiddleware } from '../../middleware/auth';
import { isMockMode } from '../../services/doordash/doordashClient';
import { encryptToken } from '../../lib/tokenCrypto';
import { syncIntegration } from '../../services/syncScheduler';

const DOORDASH_CREDS_SELECT =
  'id, pos_connected, square_location_id, square_access_token, square_refresh_token, square_token_expires_at, delivery_connected, doordash_store_id, doordash_access_token, doordash_refresh_token, doordash_token_expires_at';

const router = Router();

/**
 * GET /api/integrations/doordash/status
 * Quick health probe — mirrors the Square status endpoint. No auth required so
 * the frontend can render mode/environment before the connect flow completes.
 */
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    data: {
      mock: isMockMode(),
      environment: process.env.DOORDASH_ENVIRONMENT ?? 'sandbox',
    },
    error: null,
  });
});

router.use(authMiddleware);

/**
 * POST /api/integrations/doordash/connect
 * Body: { restaurant_id, store_id, access_token, refresh_token?, expires_in? }
 *
 * Persists the DoorDash store id + encrypted OAuth tokens onto the restaurant
 * row, exactly as the Square connect persists square_location_id +
 * square_access_token. Tokens are AES-GCM encrypted at rest (lib/tokenCrypto).
 * refresh_token / expires_in are optional and enable the proactive refresh flow.
 */
router.post('/connect', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const { restaurant_id, store_id, access_token, refresh_token, expires_in } = req.body ?? {};

  if (!restaurant_id || !store_id || !access_token) {
    return res.status(400).json({
      data: null,
      error: 'restaurant_id, store_id, and access_token are required',
    });
  }

  const updates: Record<string, unknown> = {
    doordash_store_id: store_id,
    doordash_access_token: encryptToken(access_token),
    delivery_connected: true,
  };
  if (refresh_token) updates.doordash_refresh_token = encryptToken(refresh_token);
  if (expires_in) {
    updates.doordash_token_expires_at = new Date(
      Date.now() + Number(expires_in) * 1000,
    ).toISOString();
  }

  const { data, error } = await supabase
    .from('restaurants')
    .update(updates)
    .eq('id', restaurant_id)
    .eq('user_id', userId)
    .select('id, doordash_store_id, delivery_connected')
    .maybeSingle();

  if (error) {
    console.error(error);
    return res.status(500).json({ data: null, error: 'Failed to connect DoorDash' });
  }
  if (!data) {
    return res.status(403).json({ data: null, error: 'Restaurant not found or access denied' });
  }

  return res.json({ data, error: null });
});

/**
 * POST /api/integrations/doordash/disconnect
 * Body: { restaurant_id }
 *
 * Clears stored DoorDash credentials. (Square has no disconnect yet, but the
 * sprint's connect/disconnect UI mirror needs a backing endpoint.) Existing
 * DoorDash orders/summaries are intentionally left in place.
 */
router.post('/disconnect', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const { restaurant_id } = req.body ?? {};
  if (!restaurant_id) {
    return res.status(400).json({ data: null, error: 'restaurant_id is required' });
  }

  const { data, error } = await supabase
    .from('restaurants')
    .update({
      doordash_store_id: null,
      doordash_access_token: null,
      doordash_refresh_token: null,
      doordash_token_expires_at: null,
      delivery_connected: false,
    })
    .eq('id', restaurant_id)
    .eq('user_id', userId)
    .select('id, doordash_store_id, delivery_connected')
    .maybeSingle();

  if (error) {
    console.error(error);
    return res.status(500).json({ data: null, error: 'Failed to disconnect DoorDash' });
  }
  if (!data) {
    return res.status(403).json({ data: null, error: 'Restaurant not found or access denied' });
  }

  return res.json({ data, error: null });
});

/**
 * POST /api/integrations/doordash/sync
 * Body: { restaurant_id }
 *
 * Manually triggers a catalog + orders pull. Routed through the SHARED
 * syncIntegration path (services/syncScheduler) so a manual press obeys the same
 * per-restaurant lock and status bookkeeping as the scheduler — it can never
 * duplicate an in-flight scheduled run (returns 409 instead).
 */
router.post('/sync', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const { restaurant_id } = req.body ?? {};
  if (!restaurant_id) {
    return res.status(400).json({ data: null, error: 'restaurant_id is required' });
  }

  const { data: owned, error: ownerErr } = await supabase
    .from('restaurants')
    .select(DOORDASH_CREDS_SELECT)
    .eq('id', restaurant_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (ownerErr) {
    console.error(ownerErr);
    return res.status(500).json({ data: null, error: 'Failed to verify restaurant ownership' });
  }
  if (!owned) {
    return res.status(403).json({ data: null, error: 'Restaurant not found or access denied' });
  }

  const outcome = await syncIntegration(owned as any, 'doordash', 'manual');

  if (outcome.skipped && outcome.reason === 'locked') {
    return res
      .status(409)
      .json({ data: null, error: 'A sync is already in progress for this integration.' });
  }
  if (outcome.skipped) {
    return res.status(409).json({
      data: null,
      error:
        outcome.reason === 'token_expired'
          ? 'DoorDash access expired — reconnect required.'
          : 'DoorDash is not connected.',
    });
  }
  if (!outcome.ok) {
    return res.status(502).json({ data: null, error: outcome.error ?? 'DoorDash sync failed' });
  }

  return res.json({
    data: {
      ok: true,
      mock: isMockMode(),
      catalogCount: outcome.catalogCount ?? 0,
      orderCount: outcome.orderCount ?? 0,
    },
    error: null,
  });
});

export default router;
