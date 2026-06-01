import { Router, Request, Response } from 'express';
import { JWTPayload } from 'jose';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { analyzeMargins, MarginAnalysisError } from '../services/marginAnalysisService';

interface AuthRequest extends Request {
  user?: JWTPayload;
}

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

// ---------------------------------------------------------------------------
// GET /api/analytics/dashboard
// Returns revenueTrend, topItems, and hourlyDistribution for the last 30 days.
// All aggregation is done in TypeScript after fetching from Supabase.
// ---------------------------------------------------------------------------
router.get('/dashboard', async (req: AuthRequest, res: Response) => {
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

  // Fetch daily_summaries with embedded menu_items for the last 30 days.
  const { data: summaries, error: sErr } = await supabase
    .from('daily_summaries')
    .select('menu_item_id, date, total_quantity, total_revenue_cents, total_orders, menu_items(name, category)')
    .eq('restaurant_id', restaurant.id)
    .gte('date', sinceStr)
    .order('date', { ascending: true });

  if (sErr) {
    return res.status(500).json({ data: null, error: 'Failed to fetch daily summaries' });
  }

  // Fetch orders for the last 30 days — only the two columns we need.
  const { data: orders, error: oErr } = await supabase
    .from('orders')
    .select('ordered_at, total_cents')
    .eq('restaurant_id', restaurant.id)
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
router.get('/margins', async (req: AuthRequest, res: Response) => {
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

  try {
    const data = await analyzeMargins(restaurant.id);
    return res.json({ data, error: null });
  } catch (err) {
    const message =
      err instanceof MarginAnalysisError ? err.message : 'Failed to analyze margins';
    return res.status(500).json({ data: null, error: message });
  }
});

export default router;
