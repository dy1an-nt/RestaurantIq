import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { validateBody } from '../middleware/validate';

const router = Router();

router.use(authMiddleware);

// Editable fields on a menu item. Every field is optional, but at least one
// must be present, and each is normalized to exactly what the DB should store
// (trim name; empty category → null; cost_cents a non-negative integer or null).
// This replaces ~60 lines of hand-rolled per-field validation in the handler.
const updateMenuItemSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'name cannot be empty')
      .max(200, 'name must be 200 characters or fewer')
      .optional(),
    category: z
      .string()
      .max(100, 'category must be 100 characters or fewer')
      .nullable()
      .optional()
      .transform((v) => {
        if (v === undefined || v === null) return v;
        const t = v.trim();
        return t.length === 0 ? null : t;
      }),
    cost_cents: z
      .number()
      .finite('cost_cents must be a finite number')
      .int('cost_cents must be an integer (no decimals)')
      .min(0, 'cost_cents must be zero or greater')
      .max(100000000, 'cost_cents must not exceed 100000000 ($1,000,000)')
      .nullable()
      .optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined || b.category !== undefined || b.cost_cents !== undefined,
    { message: 'No fields to update' },
  );

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

router.patch(
  '/:restaurantId/menu-items/:itemId',
  validateBody(updateMenuItemSchema),
  async (req: Request, res: Response) => {
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

  // Body is already validated + normalized by updateMenuItemSchema; build the
  // update payload from exactly the fields the client supplied.
  const { name, category, cost_cents } = req.body as z.infer<typeof updateMenuItemSchema>;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (category !== undefined) updates.category = category;
  if (cost_cents !== undefined) updates.cost_cents = cost_cents;

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
  },
);

export default router;
