import { Router, Request, Response } from 'express';
import { supabase } from '../../db';
import { authMiddleware } from '../../middleware/auth';
import { ingestSquare } from '../../services/square/ingestSquare';
import { isMockMode } from '../../services/square/squareClient';

const router = Router();

router.use(authMiddleware);

/**
 * POST /api/integrations/square/connect
 * Body: { restaurant_id: string, location_id: string, access_token: string }
 *
 * Persists the Square location + access token onto the restaurant row.
 * Production should encrypt access_token at rest — out of scope for MVP.
 */
router.post('/connect', async (req: Request, res: Response) => {
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
      square_access_token: access_token,
      pos_connected: true,
    })
    .eq('id', restaurant_id)
    .select('id, square_location_id, pos_connected')
    .single();

  if (error) {
    console.error(error);
    return res.status(500).json({ data: null, error: 'Failed to connect Square' });
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
  const { restaurant_id } = req.body ?? {};
  if (!restaurant_id) {
    return res.status(400).json({ data: null, error: 'restaurant_id is required' });
  }

  try {
    const result = await ingestSquare(restaurant_id);
    return res.json({ data: result, error: null });
  } catch (err: any) {
    console.error('Square sync failed:', err);
    return res
      .status(500)
      .json({ data: null, error: err.message ?? 'Square sync failed' });
  }
});

/**
 * GET /api/integrations/square/status
 * Quick health probe — useful for the frontend to know whether ingestion is
 * available without leaking credentials.
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

export default router;
