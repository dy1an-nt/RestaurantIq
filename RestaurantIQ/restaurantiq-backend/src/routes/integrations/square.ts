import { Router, Request, Response } from 'express';
import { supabase } from '../../db';
import { authMiddleware } from '../../middleware/auth';
import { ingestSquare } from '../../services/square/ingestSquare';
import { isMockMode } from '../../services/square/squareClient';
import { encryptToken } from '../../lib/tokenCrypto';

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
 * Persists the Square location + access token onto the restaurant row.
 * Production should encrypt access_token at rest — out of scope for MVP.
 */
router.post('/connect', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const { restaurant_id, location_id, access_token } = req.body ?? {};

  if (!restaurant_id || !location_id || !access_token) {
    return res.status(400).json({
      data: null,
      error: 'restaurant_id, location_id, and access_token are required',
    });
  }

  const { data, error } = await supabase
    .from('restaurants')
    .update({
      square_location_id: location_id,
      square_access_token: encryptToken(access_token),
      pos_connected: true,
    })
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
 * Triggers a catalog + orders pull for the given restaurant. Returns a count
 * summary. In USE_MOCK mode this is a no-op that resolves immediately.
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
    .select('id')
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

  try {
    const result = await Promise.race([
      ingestSquare(restaurant_id),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Sync timed out — try again')),
          60_000,
        ),
      ),
    ]);
    return res.json({ data: result, error: null });
  } catch (err: any) {
    const timedOut = (err.message as string | undefined)?.includes('timed out') ?? false;
    console.error(`Square sync ${timedOut ? 'timed out' : 'failed'}:`, err.message);
    return res.status(timedOut ? 504 : 500).json({
      data: null,
      error: err.message ?? 'Square sync failed',
    });
  }
});

export default router;
