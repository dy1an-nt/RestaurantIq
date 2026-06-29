import { Router, Request, Response } from 'express';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { requireRestaurant } from '../middleware/requireRestaurant';
import { createAiRateLimiter } from '../middleware/rateLimit';
import { generateInsights, SummaryRow } from '../services/anthropicService';

const router = Router();
// Authenticate first so the rate limiter can key on the user id, then cap how
// often this Claude-powered endpoint can be called (cost protection — Sprint N),
// then resolve the caller's restaurant once for the handler.
router.use(authMiddleware);
router.use(createAiRateLimiter());
router.use(requireRestaurant());

router.get('/', async (req: Request, res: Response) => {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];

  const { data: summaries, error: sErr } = await supabase
    .from('daily_summaries')
    .select('menu_item_id, date, total_quantity, total_revenue_cents, total_orders, menu_items(name, category)')
    .eq('restaurant_id', req.restaurantId!)
    .gte('date', sinceStr)
    .order('date', { ascending: true });

  if (sErr) {
    console.error('[insights] Supabase query failed:', sErr.message);
    return res.status(500).json({ data: null, error: 'Failed to fetch summaries' });
  }

  const rows = (summaries ?? []) as unknown as SummaryRow[];

  // Explainability metadata (Sprint T4): tell the owner exactly what the AI
  // looked at — period, volume, and freshness — so the recommendations feel
  // transparent rather than magical. Derived from the same rows we send to Claude.
  const distinctDays = new Set(rows.map((r) => r.date)).size;
  const distinctItems = new Set(rows.map((r) => r.menu_item_id).filter(Boolean)).size;
  const ordersAnalyzed = rows.reduce((sum, r) => sum + (r.total_orders ?? 0), 0);

  // Confidence reflects how much history backed the analysis. Demand/trend
  // signals stabilise with more days of data, so we key off distinct days.
  const confidence: 'high' | 'medium' | 'low' =
    distinctDays >= 21 ? 'high' : distinctDays >= 10 ? 'medium' : 'low';

  const meta = {
    generatedAt: new Date().toISOString(),
    periodDays: 30,
    rangeStart: sinceStr,
    rangeEnd: new Date().toISOString().split('T')[0],
    daysWithData: distinctDays,
    itemsAnalyzed: distinctItems,
    ordersAnalyzed,
    confidence,
    source: 'Square + DoorDash sales',
  };

  try {
    const result = await generateInsights(rows);
    return res.json({ data: { ...result, meta }, error: null });
  } catch {
    return res.status(502).json({ data: null, error: 'AI insights unavailable — try again shortly' });
  }
});

export default router;
