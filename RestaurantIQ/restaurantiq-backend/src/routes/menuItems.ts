import { Router, Request, Response } from 'express';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';

const router = Router();

router.use(authMiddleware);

router.get('/:restaurantId/menu-items', async (req: Request, res: Response) => {
  const { restaurantId } = req.params;
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const { data: owned, error: ownerErr } = await supabase
    .from('restaurants')
    .select('id')
    .eq('id', restaurantId)
    .eq('user_id', userId)
    .maybeSingle();

  if (ownerErr) {
    console.error(ownerErr);
    return res.status(500).json({ data: null, error: 'Failed to verify restaurant ownership' });
  }
  if (!owned) {
    return res.status(403).json({ data: null, error: 'Restaurant not found or access denied' });
  }

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
    if (!s.menu_item_id) continue;
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

router.patch('/:restaurantId/menu-items/:itemId', async (req: Request, res: Response) => {
  const { restaurantId, itemId } = req.params;
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  // Verify ownership
  const { data: owned, error: ownerErr } = await supabase
    .from('restaurants')
    .select('id')
    .eq('id', restaurantId)
    .eq('user_id', userId)
    .maybeSingle();

  if (ownerErr) {
    console.error(ownerErr);
    return res.status(500).json({ data: null, error: 'Failed to verify restaurant ownership' });
  }
  if (!owned) {
    return res.status(403).json({ data: null, error: 'Restaurant not found or access denied' });
  }

  const { name, category, cost_cents } = req.body;

  // At least one field must be present
  if (name === undefined && category === undefined && cost_cents === undefined) {
    return res.status(400).json({ data: null, error: 'No fields to update' });
  }

  const updates: Record<string, unknown> = {};

  // Validate and build name
  if (name !== undefined) {
    if (typeof name !== 'string') {
      return res.status(400).json({ data: null, error: 'name must be a string' });
    }
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      return res.status(400).json({ data: null, error: 'name cannot be empty' });
    }
    if (trimmedName.length > 200) {
      return res.status(400).json({ data: null, error: 'name must be 200 characters or fewer' });
    }
    updates.name = trimmedName;
  }

  // Validate and build category
  if (category !== undefined) {
    if (category !== null && typeof category !== 'string') {
      return res.status(400).json({ data: null, error: 'category must be a string or null' });
    }
    if (typeof category === 'string') {
      if (category.length > 100) {
        return res.status(400).json({ data: null, error: 'category must be 100 characters or fewer' });
      }
      const trimmedCategory = category.trim();
      updates.category = trimmedCategory.length === 0 ? null : trimmedCategory;
    } else {
      updates.category = null;
    }
  }

  // Validate and build cost_cents
  if (cost_cents !== undefined) {
    if (cost_cents !== null) {
      if (typeof cost_cents !== 'number') {
        return res.status(400).json({ data: null, error: 'cost_cents must be an integer number or null' });
      }
      if (!Number.isFinite(cost_cents)) {
        return res.status(400).json({ data: null, error: 'cost_cents must be a finite number' });
      }
      if (!Number.isInteger(cost_cents)) {
        return res.status(400).json({ data: null, error: 'cost_cents must be an integer (no decimals)' });
      }
      if (cost_cents < 0) {
        return res.status(400).json({ data: null, error: 'cost_cents must be zero or greater' });
      }
      if (cost_cents > 100000000) {
        return res.status(400).json({ data: null, error: 'cost_cents must not exceed 100000000 ($1,000,000)' });
      }
    }
    updates.cost_cents = cost_cents;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('menu_items')
    .update(updates)
    .eq('id', itemId)
    .eq('restaurant_id', restaurantId)
    .select('id, name, category, price_cents, cost_cents, source')
    .maybeSingle();

  if (updateErr) {
    console.error(updateErr);
    return res.status(500).json({ data: null, error: 'Failed to update menu item' });
  }
  if (!updated) {
    return res.status(404).json({ data: null, error: 'Menu item not found' });
  }

  return res.status(200).json({ data: updated, error: null });
});

export default router;
