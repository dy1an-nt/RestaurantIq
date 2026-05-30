import { Router, Request, Response } from 'express';
import { JWTPayload } from 'jose';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';

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
    console.error('[analytics] daily_summaries query failed:', sErr.message);
    return res.status(500).json({ data: null, error: 'Failed to fetch daily summaries' });
  }

  // Fetch orders for the last 30 days — only the two columns we need.
  const { data: orders, error: oErr } = await supabase
    .from('orders')
    .select('ordered_at, total_cents')
    .eq('restaurant_id', restaurant.id)
    .gte('ordered_at', since.toISOString());

  if (oErr) {
    console.error('[analytics] orders query failed:', oErr.message);
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
// ---------------------------------------------------------------------------

interface MarginItem {
  id: string;
  name: string;
  category: string;
  price_cents: number;
  cost_cents: number;
  profit_cents: number;
  margin_percent: number;
  orders_30d: number;
  revenue_30d_cents: number;
  profit_30d_cents: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return (sorted[lo] + sorted[hi]) / 2;
}

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

  const { data: menuItems, error: mErr } = await supabase
    .from('menu_items')
    .select('id, name, category, price_cents, cost_cents')
    .eq('restaurant_id', restaurant.id);

  if (mErr) {
    console.error('[analytics] menu_items query failed:', mErr.message);
    return res.status(500).json({ data: null, error: 'Failed to fetch menu items' });
  }

  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];

  const { data: summaries, error: sErr } = await supabase
    .from('daily_summaries')
    .select('menu_item_id, total_quantity, total_revenue_cents, total_orders')
    .eq('restaurant_id', restaurant.id)
    .gte('date', sinceStr);

  if (sErr) {
    console.error('[analytics] daily_summaries query failed (margins):', sErr.message);
    return res.status(500).json({ data: null, error: 'Failed to fetch daily summaries' });
  }

  const velocityMap = new Map<string, { orders: number; quantity: number; revenue_cents: number }>();
  for (const s of summaries ?? []) {
    if (!s.menu_item_id) continue;
    const cur = velocityMap.get(s.menu_item_id) ?? { orders: 0, quantity: 0, revenue_cents: 0 };
    cur.orders += s.total_orders ?? 0;
    cur.quantity += s.total_quantity ?? 0;
    cur.revenue_cents += s.total_revenue_cents ?? 0;
    velocityMap.set(s.menu_item_id, cur);
  }

  const enriched = (menuItems ?? []).map(item => {
    const cost_known = item.cost_cents != null && item.price_cents > 0;
    const cost_cents = item.cost_cents ?? 0;
    const profit_cents = cost_known ? item.price_cents - cost_cents : 0;
    const margin_percent = cost_known
      ? Math.round((profit_cents / item.price_cents) * 10000) / 100
      : 0;
    const vel = velocityMap.get(item.id) ?? { orders: 0, quantity: 0, revenue_cents: 0 };
    const profit_30d_cents = cost_known ? profit_cents * vel.quantity : 0;
    return {
      id: item.id,
      name: item.name,
      category: item.category ?? '',
      price_cents: item.price_cents,
      cost_cents,
      profit_cents,
      margin_percent,
      orders_30d: vel.orders,
      revenue_30d_cents: vel.revenue_cents,
      profit_30d_cents,
      cost_known,
    };
  });

  const withKnownCost = enriched.filter(i => i.cost_known);

  // Quartile thresholds are computed only from profitable cost-known items.
  // Require at least 3 to produce meaningful quartiles; below that all
  // velocity/margin buckets stay empty (not enough data to rank relatively).
  const calculable = withKnownCost.filter(i => i.profit_cents > 0);
  const hasEnoughData = calculable.length >= 3;
  const sortedMargins = calculable.map(i => i.margin_percent).sort((a, b) => a - b);
  const sortedOrders = enriched.map(i => i.orders_30d).sort((a, b) => a - b);
  const marginP25 = hasEnoughData ? percentile(sortedMargins, 0.25) : 0;
  const marginP75 = hasEnoughData ? percentile(sortedMargins, 0.75) : 0;
  const ordersP25 = hasEnoughData ? percentile(sortedOrders, 0.25) : 0;
  const ordersP75 = hasEnoughData ? percentile(sortedOrders, 0.75) : 0;

  // Negative: cost_known AND cost >= price (includes break-even at 0% margin)
  const negativeMarginItems: MarginItem[] = withKnownCost
    .filter(i => i.cost_cents >= i.price_cents)
    .sort((a, b) => a.margin_percent - b.margin_percent);

  const negativeIds = new Set(negativeMarginItems.map(i => i.id));

  // Velocity/margin buckets only meaningful with enough data for quartile thresholds
  const repricingCandidates: MarginItem[] = hasEnoughData
    ? withKnownCost
        .filter(
          i =>
            !negativeIds.has(i.id) &&
            i.margin_percent <= marginP25 &&
            i.orders_30d >= ordersP75
        )
        .sort((a, b) => b.orders_30d - a.orders_30d)
    : [];

  const repricingIds = new Set(repricingCandidates.map(i => i.id));

  const lowVelocityPremiumItems: MarginItem[] = hasEnoughData
    ? withKnownCost
        .filter(
          i =>
            !negativeIds.has(i.id) &&
            !repricingIds.has(i.id) &&
            i.margin_percent >= marginP75 &&
            i.orders_30d <= ordersP25
        )
        .sort((a, b) => b.margin_percent - a.margin_percent)
    : [];

  const lowVelocityIds = new Set(lowVelocityPremiumItems.map(i => i.id));

  const healthyPerformers: MarginItem[] = hasEnoughData
    ? withKnownCost
        .filter(
          i =>
            !negativeIds.has(i.id) &&
            !repricingIds.has(i.id) &&
            !lowVelocityIds.has(i.id) &&
            i.margin_percent >= marginP75 &&
            i.orders_30d >= ordersP75
        )
        .sort((a, b) => b.margin_percent - a.margin_percent)
    : [];

  // Summary uses only cost_known items so unknown-cost items don't skew the average.
  // totalProfitCents is true net (includes losses from negative-margin items).
  const averageMarginPercent =
    withKnownCost.length > 0
      ? Math.round(
          (withKnownCost.reduce((sum, i) => sum + i.margin_percent, 0) / withKnownCost.length) * 100
        ) / 100
      : 0;
  const totalProfitCents = withKnownCost.reduce((sum, i) => sum + i.profit_30d_cents, 0);
  const sortedByMargin = [...withKnownCost].sort((a, b) => a.margin_percent - b.margin_percent);
  const worstItem =
    sortedByMargin[0]
      ? { name: sortedByMargin[0].name, margin_percent: sortedByMargin[0].margin_percent }
      : null;
  const bestItem =
    sortedByMargin[sortedByMargin.length - 1]
      ? {
          name: sortedByMargin[sortedByMargin.length - 1].name,
          margin_percent: sortedByMargin[sortedByMargin.length - 1].margin_percent,
        }
      : null;

  return res.json({
    data: {
      summary: { averageMarginPercent, totalProfitCents, worstItem, bestItem },
      negativeMarginItems,
      repricingCandidates,
      lowVelocityPremiumItems,
      healthyPerformers,
    },
    error: null,
  });
});

export default router;
