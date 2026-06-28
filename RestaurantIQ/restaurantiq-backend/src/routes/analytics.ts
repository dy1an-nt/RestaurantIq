import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { requireRestaurant } from '../middleware/requireRestaurant';
import { validateBody } from '../middleware/validate';
import { analyzeMargins, MarginAnalysisError } from '../services/marginAnalysisService';
import {
  analyzeChannelMargins,
  ChannelMarginError,
} from '../services/channelMarginService';

// PostgREST returns embedded many-to-one relations as arrays even for single
// FK relationships. Typing as an array and unwrapping with [0] is required.
// menu_item_id is nullable — ON DELETE SET NULL means deleted items leave null rows.
interface DailySummaryRow {
  menu_item_id: string | null;
  date: string;
  total_quantity: number;
  total_revenue_cents: number;
  total_orders: number;
  menu_items: { name: string; category: string }[] | null;
}

interface OrderRow {
  ordered_at: string;
  total_cents: number;
}

const router = Router();
router.use(authMiddleware);
// Resolve the caller's restaurant once for every analytics route. The DoorDash
// economics columns are pulled in the same query so /channel-margins doesn't
// re-fetch the row it already resolved.
router.use(
  requireRestaurant('id, doordash_commission_bps, doordash_flat_fee_cents'),
);

// Body schema for the only write route in this router. `.strict()` rejects
// unknown fields (preserving the route's prior hand-rolled behavior); the
// refinement enforces "at least one field present".
const deliveryEconomicsSchema = z
  .object({
    doordash_commission_bps: z.number().int().min(0).max(5000).optional(),
    doordash_flat_fee_cents: z.number().int().min(0).max(2000).optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.doordash_commission_bps !== undefined ||
      b.doordash_flat_fee_cents !== undefined,
    {
      message:
        'At least one of doordash_commission_bps or doordash_flat_fee_cents is required',
    },
  );

// ---------------------------------------------------------------------------
// GET /api/analytics/dashboard
// Returns revenueTrend, topItems, and hourlyDistribution for the last 30 days.
// All aggregation is done in TypeScript after fetching from Supabase.
// ---------------------------------------------------------------------------
router.get('/dashboard', async (req: Request, res: Response) => {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];

  // Fetch daily_summaries with embedded menu_items for the last 30 days.
  const { data: summaries, error: sErr } = await supabase
    .from('daily_summaries')
    .select('menu_item_id, date, total_quantity, total_revenue_cents, total_orders, menu_items(name, category)')
    .eq('restaurant_id', req.restaurantId!)
    .gte('date', sinceStr)
    .order('date', { ascending: true });

  if (sErr) {
    return res.status(500).json({ data: null, error: 'Failed to fetch daily summaries' });
  }

  // Fetch orders for the last 30 days — only the two columns we need.
  const { data: orders, error: oErr } = await supabase
    .from('orders')
    .select('ordered_at, total_cents')
    .eq('restaurant_id', req.restaurantId!)
    .gte('ordered_at', since.toISOString());

  if (oErr) {
    return res.status(500).json({ data: null, error: 'Failed to fetch orders' });
  }

  const rows = (summaries ?? []) as DailySummaryRow[];
  const orderRows = (orders ?? []) as OrderRow[];

  // --- revenueTrend: group by date, sum total_revenue_cents ----------------
  const trendMap = new Map<string, number>();
  for (const row of rows) {
    trendMap.set(row.date, (trendMap.get(row.date) ?? 0) + row.total_revenue_cents);
  }
  // Map is insertion-ordered and rows are already sorted ascending by date,
  // so the resulting array preserves chronological order.
  const revenueTrend = Array.from(trendMap.entries()).map(([date, revenue_cents]) => ({
    date,
    revenue_cents,
  }));

  // --- topItems: group by menu_item_id, sum revenue + orders, top 10 ------
  const itemMap = new Map<
    string,
    { name: string; category: string; revenue_cents: number; orders: number }
  >();
  for (const row of rows) {
    // Skip orphaned rows left behind by ON DELETE SET NULL on menu_items FK.
    if (row.menu_item_id === null) continue;
    const existing = itemMap.get(row.menu_item_id);
    // Unwrap PostgREST array embed — use first element, fall back to blanks.
    const menuItem = row.menu_items?.[0];
    if (existing) {
      existing.revenue_cents += row.total_revenue_cents;
      existing.orders += row.total_orders;
    } else {
      itemMap.set(row.menu_item_id, {
        name: menuItem?.name ?? '',
        category: menuItem?.category ?? '',
        revenue_cents: row.total_revenue_cents,
        orders: row.total_orders,
      });
    }
  }
  const topItems = Array.from(itemMap.entries())
    .map(([item_id, v]) => ({ item_id, ...v }))
    .sort((a, b) => b.revenue_cents - a.revenue_cents)
    .slice(0, 10);

  // --- hourlyDistribution: aggregate by (day, hour) -----------------------
  const heatMap = new Map<string, { day: number; hour: number; revenue_cents: number; orders: number }>();
  for (const order of orderRows) {
    const d = new Date(order.ordered_at);
    const day = d.getUTCDay();   // 0 = Sunday … 6 = Saturday
    const hour = d.getUTCHours(); // 0–23
    const key = `${day}:${hour}`;
    const existing = heatMap.get(key);
    if (existing) {
      existing.revenue_cents += order.total_cents;
      existing.orders += 1;
    } else {
      heatMap.set(key, { day, hour, revenue_cents: order.total_cents, orders: 1 });
    }
  }
  // Only emit cells that have at least 1 order (the Map only contains them).
  const hourlyDistribution = Array.from(heatMap.values());

  return res.json({
    data: { revenueTrend, topItems, hourlyDistribution },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/analytics/margins
// Returns margin classification buckets for all menu items in the restaurant,
// enriched with 30-day velocity data from daily_summaries.
//
// Thin route: auth, restaurant lookup, delegate to marginAnalysisService, and
// return the response. All math/classification lives in the service.
// ---------------------------------------------------------------------------
router.get('/margins', async (req: Request, res: Response) => {
  try {
    const data = await analyzeMargins(req.restaurantId!);
    return res.json({ data, error: null });
  } catch (err) {
    const message =
      err instanceof MarginAnalysisError ? err.message : 'Failed to analyze margins';
    return res.status(500).json({ data: null, error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/analytics/channel-margins
// Cross-channel per-item margin breakdown: in-house (Square/Toast/manual) vs
// DoorDash delivery after platform commission and flat fee.
//
// The restaurant row must include doordash_commission_bps and
// doordash_flat_fee_cents (added in migration 025). Those values are passed
// directly to the service — the route does no margin math itself.
// ---------------------------------------------------------------------------
router.get('/channel-margins', async (req: Request, res: Response) => {
  const restaurant = req.restaurant as {
    id: string;
    doordash_commission_bps: number;
    doordash_flat_fee_cents: number;
  };

  try {
    const data = await analyzeChannelMargins(
      restaurant.id,
      restaurant.doordash_commission_bps,
      restaurant.doordash_flat_fee_cents,
    );
    return res.json({ data, error: null });
  } catch (err) {
    const message =
      err instanceof ChannelMarginError ? err.message : 'Failed to analyze channel margins';
    return res.status(500).json({ data: null, error: message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/analytics/delivery-economics
// Update the calling restaurant's DoorDash commission and/or flat-fee settings.
//
// Body (at least one field required):
//   doordash_commission_bps  — integer, 0–5000
//   doordash_flat_fee_cents  — integer, 0–2000
//
// Returns the updated economics values (both fields, even if only one changed).
// ---------------------------------------------------------------------------
router.patch(
  '/delivery-economics',
  validateBody(deliveryEconomicsSchema),
  async (req: Request, res: Response) => {
  const { doordash_commission_bps, doordash_flat_fee_cents } = req.body as z.infer<
    typeof deliveryEconomicsSchema
  >;

  // Build the update payload from only the validated fields that were provided.
  const updates: Record<string, number> = {};
  if (doordash_commission_bps !== undefined) updates.doordash_commission_bps = doordash_commission_bps;
  if (doordash_flat_fee_cents !== undefined) updates.doordash_flat_fee_cents = doordash_flat_fee_cents;

  const { data: updated, error: uErr } = await supabase
    .from('restaurants')
    .update(updates)
    .eq('id', req.restaurantId!)
    .select('doordash_commission_bps, doordash_flat_fee_cents')
    .single();

  if (uErr || !updated) {
    console.error('[delivery-economics] update failed:', uErr?.message);
    return res.status(500).json({ data: null, error: 'Failed to update delivery economics' });
  }

  return res.json({ data: updated, error: null });
  },
);

export default router;
