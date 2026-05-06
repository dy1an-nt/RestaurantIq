import { Router, Request, Response } from 'express';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';

const router = Router();

router.use(authMiddleware);

router.get('/:restaurantId/menu-items', async (req: Request, res: Response) => {
  const { restaurantId } = req.params;

  const { data: items, error: itemsErr } = await supabase
    .from('menu_items')
    .select('id, name, category, price_cents, cost_cents, source')
    .eq('restaurant_id', restaurantId);

  if (itemsErr) {
    console.error(itemsErr);
    return res.status(500).json({ data: null, error: 'Failed to fetch menu items' });
  }

  const today = new Date();
  const start30 = new Date(today);
  start30.setDate(start30.getDate() - 30);
  const start14 = new Date(today);
  start14.setDate(start14.getDate() - 14);
  const iso = (d: Date) => d.toISOString().split('T')[0];

  const { data: summaries, error: sumErr } = await supabase
    .from('daily_summaries')
    .select('menu_item_id, date, total_quantity, total_revenue_cents, total_orders')
    .eq('restaurant_id', restaurantId)
    .gte('date', iso(start30));

  if (sumErr) {
    console.error(sumErr);
    return res.status(500).json({ data: null, error: 'Failed to fetch summaries' });
  }

  const byItem = new Map<string, { rev: number; ord: number; recentRev: number; priorRev: number }>();
  for (const s of summaries ?? []) {
    const key = s.menu_item_id as string;
    const bucket = byItem.get(key) ?? { rev: 0, ord: 0, recentRev: 0, priorRev: 0 };
    bucket.rev += s.total_revenue_cents ?? 0;
    bucket.ord += s.total_orders ?? 0;
    if (new Date(s.date) >= start14) bucket.recentRev += s.total_revenue_cents ?? 0;
    else bucket.priorRev += s.total_revenue_cents ?? 0;
    byItem.set(key, bucket);
  }

  const trendOf = (recent: number, prior: number): 'up' | 'down' | 'flat' => {
    if (prior === 0) return recent > 0 ? 'up' : 'flat';
    const change = (recent - prior) / prior;
    if (change >= 0.2) return 'up';
    if (change <= -0.2) return 'down';
    return 'flat';
  };

  const data = (items ?? []).map((item) => {
    const stats = byItem.get(item.id) ?? { rev: 0, ord: 0, recentRev: 0, priorRev: 0 };
    return {
      ...item,
      revenue_30d_cents: stats.rev,
      orders_30d: stats.ord,
      trend: trendOf(stats.recentRev, stats.priorRev),
    };
  });

  return res.json({ data, error: null });
});

export default router;
