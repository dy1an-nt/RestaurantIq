import { supabase } from '../db';

export interface ForecastItem {
  menu_item_id: string;
  name: string;
  category: string;
  projected_units_next_7d: number;
  projected_revenue_next_7d_cents: number;
  actual_units_last_7d: number;
  actual_revenue_last_7d_cents: number;
  trend_direction: 'up' | 'down' | 'flat';
  percent_change: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface InsufficientItem {
  menu_item_id: string;
  name: string;
  days_of_data: number;
}

export interface ForecastResult {
  items: ForecastItem[];
  insufficient_history_items: InsufficientItem[];
  trailing_days: number;
  projection_days: number;
}

interface SummaryRow {
  menu_item_id: string | null;
  date: string;
  total_quantity: number;
  total_revenue_cents: number;
}

interface MenuItemRow {
  id: string;
  name: string;
  category: string | null;
}

export interface ForecastInputs {
  menuItems: MenuItemRow[];
  summaries: SummaryRow[];
}

export async function fetchForecastInputs(restaurantId: string): Promise<ForecastInputs> {
  const since = new Date();
  since.setDate(since.getDate() - 56); // fetch up to 56 days to support custom trailingDays
  const sinceStr = since.toISOString().split('T')[0];

  const { data: menuItems, error: mErr } = await supabase
    .from('menu_items')
    .select('id, name, category')
    .eq('restaurant_id', restaurantId);

  if (mErr) throw new Error('Failed to fetch menu items');

  const { data: summaries, error: sErr } = await supabase
    .from('daily_summaries')
    .select('menu_item_id, date, total_quantity, total_revenue_cents')
    .eq('restaurant_id', restaurantId)
    .gte('date', sinceStr)
    .not('menu_item_id', 'is', null)
    .order('date', { ascending: true });

  if (sErr) throw new Error('Failed to fetch daily summaries');

  return {
    menuItems: (menuItems ?? []) as MenuItemRow[],
    summaries: (summaries ?? []) as SummaryRow[],
  };
}

// Simple linear regression: returns slope of y over x indices.
function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumXY = values.reduce((acc, y, i) => acc + i * y, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

export function buildForecast(
  inputs: ForecastInputs,
  trailingDays = 28,
  projectionDays = 7,
): ForecastResult {
  const { menuItems, summaries } = inputs;

  // Build per-item daily quantity/revenue maps
  const itemDays = new Map<string, Map<string, { qty: number; rev: number }>>();
  for (const s of summaries) {
    if (!s.menu_item_id) continue;
    if (!itemDays.has(s.menu_item_id)) itemDays.set(s.menu_item_id, new Map());
    itemDays.get(s.menu_item_id)!.set(s.date, {
      qty: s.total_quantity,
      rev: s.total_revenue_cents,
    });
  }

  // Build date arrays for trailing window
  const today = new Date();
  const trailingDates: string[] = [];
  for (let i = trailingDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    trailingDates.push(d.toISOString().split('T')[0]);
  }
  const last7Dates = trailingDates.slice(-7);

  const items: ForecastItem[] = [];
  const insufficient_history_items: InsufficientItem[] = [];

  for (const mi of menuItems) {
    const dayMap = itemDays.get(mi.id);
    if (!dayMap) {
      insufficient_history_items.push({ menu_item_id: mi.id, name: mi.name, days_of_data: 0 });
      continue;
    }

    const daysWithData = trailingDates.filter((d) => dayMap.has(d)).length;

    if (daysWithData < 14) {
      insufficient_history_items.push({
        menu_item_id: mi.id,
        name: mi.name,
        days_of_data: daysWithData,
      });
      continue;
    }

    // Confidence based on days of history
    const confidence: 'high' | 'medium' | 'low' =
      daysWithData >= 28 ? 'high' : daysWithData >= 21 ? 'medium' : 'low';

    // Trailing window quantities (0 for missing days)
    const trailingQty = trailingDates.map((d) => dayMap.get(d)?.qty ?? 0);
    const trailingRev = trailingDates.map((d) => dayMap.get(d)?.rev ?? 0);

    // Averages over trailing window
    const avgDailyQty = trailingQty.reduce((a, b) => a + b, 0) / trailingDays;
    const avgDailyRev = trailingRev.reduce((a, b) => a + b, 0) / trailingDays;

    // Trend slope (units per day)
    const slope = linearSlope(trailingQty);
    const midpoint = trailingDays / 2;
    // Project from midpoint + half projection window out
    const projectedDailyQty = avgDailyQty + slope * (midpoint + projectionDays / 2);
    const projectedDailyRev = avgDailyRev > 0 && avgDailyQty > 0
      ? (avgDailyRev / avgDailyQty) * Math.max(0, projectedDailyQty)
      : 0;

    // Last 7d actuals
    const actual_units_last_7d = last7Dates.reduce((sum, d) => sum + (dayMap.get(d)?.qty ?? 0), 0);
    const actual_revenue_last_7d_cents = last7Dates.reduce(
      (sum, d) => sum + (dayMap.get(d)?.rev ?? 0),
      0,
    );

    // Raw projections for next 7d
    let projected_units_next_7d = Math.round(Math.max(0, projectedDailyQty * projectionDays));
    let projected_revenue_next_7d_cents = Math.round(Math.max(0, projectedDailyRev * projectionDays));

    // Cap swing at ±50% vs last 7d actual to prevent wild extrapolation
    if (actual_units_last_7d > 0) {
      const cap = actual_units_last_7d * 1.5;
      const floor = Math.round(actual_units_last_7d * 0.5);
      projected_units_next_7d = Math.min(Math.max(projected_units_next_7d, floor), Math.round(cap));
    }
    if (actual_revenue_last_7d_cents > 0) {
      const revCap = actual_revenue_last_7d_cents * 1.5;
      const revFloor = Math.round(actual_revenue_last_7d_cents * 0.5);
      projected_revenue_next_7d_cents = Math.min(
        Math.max(projected_revenue_next_7d_cents, revFloor),
        Math.round(revCap),
      );
    }

    // Percent change vs last 7d
    const percent_change =
      actual_units_last_7d > 0
        ? Math.round(
            ((projected_units_next_7d - actual_units_last_7d) / actual_units_last_7d) * 1000,
          ) / 10
        : 0;

    const trend_direction: 'up' | 'down' | 'flat' =
      percent_change > 3 ? 'up' : percent_change < -3 ? 'down' : 'flat';

    items.push({
      menu_item_id: mi.id,
      name: mi.name,
      category: mi.category ?? '',
      projected_units_next_7d,
      projected_revenue_next_7d_cents,
      actual_units_last_7d,
      actual_revenue_last_7d_cents,
      trend_direction,
      percent_change,
      confidence,
    });
  }

  // Sort by projected revenue descending
  items.sort((a, b) => b.projected_revenue_next_7d_cents - a.projected_revenue_next_7d_cents);

  return { items, insufficient_history_items, trailing_days: trailingDays, projection_days: projectionDays };
}
