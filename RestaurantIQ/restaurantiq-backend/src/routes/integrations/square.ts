import { Router, Request, Response } from 'express';
import { supabase } from '../../db';
import { authMiddleware } from '../../middleware/auth';
import { isMockMode } from '../../services/square/squareClient';
import { encryptToken } from '../../lib/tokenCrypto';
import { syncIntegration } from '../../services/syncScheduler';

const SQUARE_CREDS_SELECT =
  'id, pos_connected, square_location_id, square_access_token, square_refresh_token, square_token_expires_at, delivery_connected, doordash_store_id, doordash_access_token, doordash_refresh_token, doordash_token_expires_at';

const router = Router();

/**
 * GET /api/integrations/square/status
 * Quick health probe — no auth required so the frontend can call it pre-login.
 */
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    data: {
      mock: isMockMode(),
      environment: process.env.SQUARE_ENVIRONMENT ?? 'sandbox',
    },
    error: null,
  });
});

router.use(authMiddleware);

/**
 * POST /api/integrations/square/connect
 * Body: { restaurant_id: string, location_id: string, access_token: string }
 *
 * Persists the Square location + access token onto the restaurant row. Tokens
 * are AES-GCM encrypted at rest (lib/tokenCrypto). The optional refresh_token /
 * expires_in enable the automatic refresh flow (Sprint K) — sandbox PAT-style
 * tokens won't have them, in which case the integration behaves as before.
 */
router.post('/connect', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const { restaurant_id, location_id, access_token, refresh_token, expires_in } = req.body ?? {};

  if (!restaurant_id || !location_id || !access_token) {
    return res.status(400).json({
      data: null,
      error: 'restaurant_id, location_id, and access_token are required',
    });
  }

  const updates: Record<string, unknown> = {
    square_location_id: location_id,
    square_access_token: encryptToken(access_token),
    pos_connected: true,
  };
  if (refresh_token) updates.square_refresh_token = encryptToken(refresh_token);
  if (expires_in) {
    updates.square_token_expires_at = new Date(
      Date.now() + Number(expires_in) * 1000,
    ).toISOString();
  }

  const { data, error } = await supabase
    .from('restaurants')
    .update(updates)
    .eq('id', restaurant_id)
    .eq('user_id', userId)
    .select('id, square_location_id, pos_connected')
    .maybeSingle();

  if (error) {
    console.error(error);
    return res.status(500).json({ data: null, error: 'Failed to connect Square' });
  }
  if (!data) {
    return res.status(403).json({ data: null, error: 'Restaurant not found or access denied' });
  }

  return res.json({ data, error: null });
});

/**
 * POST /api/integrations/square/sync
 * Body: { restaurant_id: string }
 *
 * Manually triggers a catalog + orders pull. Routed through the SHARED
 * syncIntegration path (services/syncScheduler) so a manual press obeys the same
 * per-restaurant lock and status bookkeeping as the scheduler — it can never
 * duplicate an in-flight scheduled run (returns 409 instead). In USE_MOCK mode
 * the ingest is a no-op that resolves immediately.
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
    .select(SQUARE_CREDS_SELECT)
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

  const outcome = await syncIntegration(owned as any, 'square', 'manual');

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
          ? 'Square access expired — reconnect required.'
          : 'Square is not connected.',
    });
  }
  if (!outcome.ok) {
    return res.status(502).json({ data: null, error: outcome.error ?? 'Square sync failed' });
  }

  return res.json({
    data: {
      ok: true,
      catalogCount: outcome.catalogCount ?? 0,
      orderCount: outcome.orderCount ?? 0,
    },
    error: null,
  });
});

export default router;
