import { Router, Request, Response } from 'express';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { requireRestaurant } from '../middleware/requireRestaurant';

const router = Router();
router.use(authMiddleware);
// Every route below operates on the caller's own restaurant, so resolve it once
// here (sets req.restaurantId / 404s if absent) instead of per-handler.
router.use(requireRestaurant());

// ---------------------------------------------------------------------------
// GET /api/alerts
// Returns the 50 most recent alerts for the authenticated user's restaurant.
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response) => {
  try {
    const { data: alerts, error } = await supabase
      .from('alerts')
      .select('*')
      .eq('restaurant_id', req.restaurantId!)
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
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('alerts')
      .update({ is_read: true })
      .eq('restaurant_id', req.restaurantId!)
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
router.post('/:id/read', async (req: Request, res: Response) => {
  const alertId = req.params.id;

  try {
    // Ownership is folded into the UPDATE itself — one statement, and 404 for
    // both "doesn't exist" and "belongs to another tenant". The previous
    // fetch-then-update shape returned 403 for foreign alerts and 404 for
    // missing ones, telling an attacker which alert UUIDs exist (review L1).
    const { data: updated, error: updateErr } = await supabase
      .from('alerts')
      .update({ is_read: true })
      .eq('id', alertId)
      .eq('restaurant_id', req.restaurantId!)
      .select('id')
      .maybeSingle();

    if (updateErr) {
      // 22P02 = invalid uuid syntax — a malformed :id is a 404, not a 500.
      if ((updateErr as { code?: string }).code === '22P02') {
        return res.status(404).json({ data: null, error: 'Alert not found' });
      }
      console.error('[alerts] POST /:id/read update failed:', updateErr.message);
      return res.status(500).json({ data: null, error: 'Failed to update alert' });
    }
    if (!updated) {
      return res.status(404).json({ data: null, error: 'Alert not found' });
    }

    return res.json({ data: { id: alertId }, error: null });
  } catch (err) {
    console.error('[alerts] POST /:id/read unexpected error:', (err as Error).message);
    return res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

export default router;
