import { Router, Request, Response } from 'express';
import { JWTPayload } from 'jose';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';

interface AuthRequest extends Request {
  user?: JWTPayload;
}

const router = Router();
router.use(authMiddleware);

/**
 * Look up the restaurant that belongs to a given Supabase user.
 * Returns null if not found.
 */
const getRestaurantByUserId = async (
  userId: string,
): Promise<{ id: string } | null> => {
  const { data, error } = await supabase
    .from('restaurants')
    .select('id')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data as { id: string };
};

// ---------------------------------------------------------------------------
// GET /api/alerts
// Returns the 50 most recent alerts for the authenticated user's restaurant.
// ---------------------------------------------------------------------------
router.get('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const restaurant = await getRestaurantByUserId(userId);
  if (!restaurant) {
    return res.status(404).json({ data: null, error: 'Restaurant not found' });
  }

  try {
    const { data: alerts, error } = await supabase
      .from('alerts')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[alerts] GET / query failed:', error.message);
      return res.status(500).json({ data: null, error: 'Failed to fetch alerts' });
    }

    return res.json({ data: alerts, error: null });
  } catch (err) {
    console.error('[alerts] GET / unexpected error:', (err as Error).message);
    return res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/alerts/read-all
// Marks every unread alert for the restaurant as read.
// MUST be registered before /:id/read to prevent Express matching "read-all"
// as the :id param.
// ---------------------------------------------------------------------------
router.post('/read-all', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const restaurant = await getRestaurantByUserId(userId);
  if (!restaurant) {
    return res.status(404).json({ data: null, error: 'Restaurant not found' });
  }

  try {
    const { data, error } = await supabase
      .from('alerts')
      .update({ is_read: true })
      .eq('restaurant_id', restaurant.id)
      .eq('is_read', false)
      .select('id');

    if (error) {
      console.error('[alerts] POST /read-all update failed:', error.message);
      return res.status(500).json({ data: null, error: 'Failed to mark alerts as read' });
    }

    return res.json({ data: { updated: (data ?? []).length }, error: null });
  } catch (err) {
    console.error('[alerts] POST /read-all unexpected error:', (err as Error).message);
    return res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/alerts/:id/read
// Marks a single alert as read. Verifies the alert belongs to the
// authenticated user's restaurant before updating (no cross-tenant leakage).
// ---------------------------------------------------------------------------
router.post('/:id/read', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const alertId = req.params.id;

  const restaurant = await getRestaurantByUserId(userId);
  if (!restaurant) {
    return res.status(404).json({ data: null, error: 'Restaurant not found' });
  }

  try {
    // Fetch the alert first so we can verify tenant ownership before updating.
    const { data: existing, error: fetchErr } = await supabase
      .from('alerts')
      .select('id, restaurant_id')
      .eq('id', alertId)
      .maybeSingle();

    if (fetchErr) {
      console.error('[alerts] POST /:id/read fetch failed:', fetchErr.message);
      return res.status(500).json({ data: null, error: 'Failed to fetch alert' });
    }

    if (!existing) {
      return res.status(404).json({ data: null, error: 'Alert not found' });
    }

    // Tenant guard: the alert must belong to the calling user's restaurant.
    if ((existing as { id: string; restaurant_id: string }).restaurant_id !== restaurant.id) {
      return res.status(403).json({ data: null, error: 'Forbidden' });
    }

    const { error: updateErr } = await supabase
      .from('alerts')
      .update({ is_read: true })
      .eq('id', alertId);

    if (updateErr) {
      console.error('[alerts] POST /:id/read update failed:', updateErr.message);
      return res.status(500).json({ data: null, error: 'Failed to update alert' });
    }

    return res.json({ data: { id: alertId }, error: null });
  } catch (err) {
    console.error('[alerts] POST /:id/read unexpected error:', (err as Error).message);
    return res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

export default router;
