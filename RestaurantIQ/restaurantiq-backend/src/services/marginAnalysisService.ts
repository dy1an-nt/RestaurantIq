import { supabase } from '../db';

// ---------------------------------------------------------------------------
// Margin Analysis Service
//
// Owns all margin/profit math, item classification, and summary generation for
// GET /api/analytics/margins. Routes stay thin: auth, restaurant lookup, call
// analyzeMargins(), return the result. All monetary values are integer cents.
// ---------------------------------------------------------------------------

export interface MarginItem {
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
  cost_known: boolean;
}

// Items without cost data are surfaced separately so incomplete coverage is
// visible, but they are never classified or included in profit calculations.
export interface MissingCostItem {
  id: string;
  name: string;
  price_cents: number;
}

export interface MarginSummary {
  averageMarginPercent: number;
  totalProfitCents: number;
  worstItem: { name: string; margin_percent: number } | null;
  bestItem: { name: string; margin_percent: number } | null;
  analyzedItems: number;
  missingCosts: number;
  negativeMarginItems: number;
  healthyItems: number;
}

export interface MarginAnalysisResult {
  summary: MarginSummary;
  negativeMarginItems: MarginItem[];
  repricingCandidates: MarginItem[];
  lowVelocityPremiumItems: MarginItem[];
  healthyPerformers: MarginItem[];
  missingCostItems: MissingCostItem[];
}

// Thrown for upstream (Supabase) failures so the route can map to a 500 with a
// stable, client-safe message instead of leaking internals.
export class MarginAnalysisError extends Error {}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return (sorted[lo] + sorted[hi]) / 2;
}

interface MenuItemRow {
  id: string;
  name: string;
  category: string | null;
  price_cents: number;
  cost_cents: number | null;
}

interface VelocityRow {
  menu_item_id: string | null;
  total_quantity: number | null;
  total_revenue_cents: number | null;
  total_orders: number | null;
}

/**
 * Fetches the restaurant's menu items and 30-day velocity, then computes margin
 * classification buckets, missing-cost items, and summary metrics.
 *
 * @throws {MarginAnalysisError} when an upstream Supabase query fails.
 */
export async function analyzeMargins(restaurantId: string): Promise<MarginAnalysisResult> {
  const { data: menuItems, error: mErr } = await supabase
    .from('menu_items')
    .select('id, name, category, price_cents, cost_cents')
    .eq('restaurant_id', restaurantId);

  if (mErr) {
    throw new MarginAnalysisError('Failed to fetch menu items');
  }

  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];

  const { data: summaries, error: sErr } = await supabase
    .from('daily_summaries')
    .select('menu_item_id, total_quantity, total_revenue_cents, total_orders')
    .eq('restaurant_id', restaurantId)
    .gte('date', sinceStr);

  if (sErr) {
    throw new MarginAnalysisError('Failed to fetch daily summaries');
  }

  return buildMarginAnalysis((menuItems ?? []) as MenuItemRow[], (summaries ?? []) as VelocityRow[]);
}

/**
 * Pure transform: given menu items and velocity rows, produce the full analysis
 * result. Kept separate from data access so the math is trivial to reason about.
 */
export function buildMarginAnalysis(
  menuItems: MenuItemRow[],
  summaries: VelocityRow[]
): MarginAnalysisResult {
  const velocityMap = new Map<string, { orders: number; quantity: number; revenue_cents: number }>();
  for (const s of summaries) {
    if (!s.menu_item_id) continue;
    const cur = velocityMap.get(s.menu_item_id) ?? { orders: 0, quantity: 0, revenue_cents: 0 };
    cur.orders += s.total_orders ?? 0;
    cur.quantity += s.total_quantity ?? 0;
    cur.revenue_cents += s.total_revenue_cents ?? 0;
    velocityMap.set(s.menu_item_id, cur);
  }

  const enriched: MarginItem[] = menuItems.map(item => {
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

  // Items without cost data: surfaced separately, never classified or counted
  // in profitability. Minimal shape — name + price are all the UI needs.
  const missingCostItems: MissingCostItem[] = enriched
    .filter(i => !i.cost_known)
    .map(i => ({ id: i.id, name: i.name, price_cents: i.price_cents }));

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

  // Negative: cost_known AND margin strictly below 0%. Break-even (0% margin,
  // cost === price) is NOT negative — it is left unclassified.
  const negativeMarginItems: MarginItem[] = withKnownCost
    .filter(i => i.margin_percent < 0)
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
  const worstItem = sortedByMargin[0]
    ? { name: sortedByMargin[0].name, margin_percent: sortedByMargin[0].margin_percent }
    : null;
  const bestItem = sortedByMargin[sortedByMargin.length - 1]
    ? {
        name: sortedByMargin[sortedByMargin.length - 1].name,
        margin_percent: sortedByMargin[sortedByMargin.length - 1].margin_percent,
      }
    : null;

  const summary: MarginSummary = {
    averageMarginPercent,
    totalProfitCents,
    worstItem,
    bestItem,
    analyzedItems: withKnownCost.length,
    missingCosts: missingCostItems.length,
    negativeMarginItems: negativeMarginItems.length,
    healthyItems: healthyPerformers.length,
  };

  return {
    summary,
    negativeMarginItems,
    repricingCandidates,
    lowVelocityPremiumItems,
    healthyPerformers,
    missingCostItems,
  };
}
