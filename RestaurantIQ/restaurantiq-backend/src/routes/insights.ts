import { Router, Request, Response } from 'express';
import { JWTPayload } from 'jose';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { createAiRateLimiter } from '../middleware/rateLimit';
import { generateInsights, SummaryRow } from '../services/anthropicService';

interface AuthRequest extends Request {
  user?: JWTPayload;
}

const router = Router();
// Authenticate first so the rate limiter can key on the user id, then cap how
// often this Claude-powered endpoint can be called (cost protection — Sprint N).
router.use(authMiddleware);
router.use(createAiRateLimiter());

router.get('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const { data: restaurant, error: rErr } = await supabase
    .from('restaurants')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (rErr || !restaurant) {
    return res.status(404).json({ data: null, error: 'Restaurant not found' });
  }

  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];

  const { data: summaries, error: sErr } = await supabase
    .from('daily_summaries')
    .select('menu_item_id, date, total_quantity, total_revenue_cents, total_orders, menu_items(name, category)')
    .eq('restaurant_id', restaurant.id)
    .gte('date', sinceStr)
    .order('date', { ascending: true });

  if (sErr) {
    console.error('[insights] Supabase query failed:', sErr.message);
    return res.status(500).json({ data: null, error: 'Failed to fetch summaries' });
  }

  try {
    const result = await generateInsights(summaries as SummaryRow[]);
    return res.json({ data: result, error: null });
  } catch {
    return res.status(502).json({ data: null, error: 'AI insights unavailable — try again shortly' });
  }
});

export default router;
