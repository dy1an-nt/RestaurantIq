import { Router, Request, Response } from 'express';
import { JWTPayload } from 'jose';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { generateMarketingCopy } from '../services/marketingService';

interface AuthRequest extends Request {
  user?: JWTPayload;
}

const router = Router();
router.use(authMiddleware);

// ---------------------------------------------------------------------------
// POST /api/marketing/generate
// Generates social media captions, hashtags, and promo ideas for a menu item.
// Tenant scoping: restaurant resolved from req.user.sub — no client-supplied
// restaurantId is accepted.
// ---------------------------------------------------------------------------
router.post('/generate', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const { menuItemId, tone, platform } = req.body as {
    menuItemId?: unknown;
    tone?: unknown;
    platform?: unknown;
  };

  // Validate: all three fields must be present non-empty strings.
  if (
    typeof menuItemId !== 'string' ||
    menuItemId.trim() === '' ||
    typeof tone !== 'string' ||
    tone.trim() === '' ||
    typeof platform !== 'string' ||
    platform.trim() === ''
  ) {
    return res
      .status(400)
      .json({ data: null, error: 'menuItemId, tone, and platform are required' });
  }

  // Resolve the restaurant that belongs to this JWT user.
  const { data: restaurant, error: rErr } = await supabase
    .from('restaurants')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (rErr || !restaurant) {
    return res.status(404).json({ data: null, error: 'Restaurant not found' });
  }

  // Verify the requested menu item belongs to this tenant.
  const { data: item, error: iErr } = await supabase
    .from('menu_items')
    .select('id, name, category, price_cents, cost_cents')
    .eq('id', menuItemId)
    .eq('restaurant_id', restaurant.id)
    .single();

  if (iErr || !item) {
    return res.status(404).json({ data: null, error: 'Menu item not found' });
  }

  // Gather last-30-days performance data for this specific item.
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];

  const { data: summaries, error: sErr } = await supabase
    .from('daily_summaries')
    .select('date, total_quantity, total_revenue_cents, total_orders')
    .eq('restaurant_id', restaurant.id)
    .eq('menu_item_id', menuItemId)
    .gte('date', sinceStr)
    .order('date', { ascending: true });

  if (sErr) {
    console.error('[marketing] daily_summaries query failed:', sErr.message);
    return res.status(500).json({ data: null, error: 'Failed to fetch performance data' });
  }

  // Gather recent alerts for this item (up to 3, newest first).
  const { data: alerts, error: aErr } = await supabase
    .from('alerts')
    .select('type, severity, title, message')
    .eq('restaurant_id', restaurant.id)
    .eq('menu_item_id', menuItemId)
    .order('created_at', { ascending: false })
    .limit(3);

  if (aErr) {
    console.error('[marketing] alerts query failed:', aErr.message);
    return res.status(500).json({ data: null, error: 'Failed to fetch alert data' });
  }

  try {
    const result = await generateMarketingCopy({
      item: {
        name: (item as { name: string; category: string; price_cents: number }).name,
        category: (item as { name: string; category: string; price_cents: number }).category,
        price_cents: (item as { name: string; category: string; price_cents: number }).price_cents,
      },
      tone,
      platform,
      summaries: (summaries ?? []) as Array<{
        date: string;
        total_quantity: number;
        total_revenue_cents: number;
        total_orders: number;
      }>,
      alerts: (alerts ?? []) as Array<{
        type: string;
        severity: string;
        title: string;
        message: string;
      }>,
    });

    return res.json({ data: result, error: null });
  } catch {
    return res.status(502).json({ data: null, error: 'Marketing copy generation unavailable — try again shortly' });
  }
});

export default router;
