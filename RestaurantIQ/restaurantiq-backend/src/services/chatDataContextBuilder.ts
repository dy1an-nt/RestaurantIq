import { supabase } from '../db';

export interface ChatContextMeta {
  summaries_count: number;
  orders_count: number;
  menu_items_count: number;
  date_range: { from: string; to: string };
}

export interface ChatContext {
  restaurant: { name: string };
  date_range: { from: string; to: string };
  daily_revenue: Array<{ date: string; revenue_cents: number; orders: number }>;
  top_items_by_revenue_30d: Array<{ name: string; category: string; revenue_cents: number; units: number }>;
  bottom_items_by_revenue_30d: Array<{ name: string; category: string; revenue_cents: number; units: number }>;
  category_breakdown_30d: Array<{ category: string; revenue_cents: number; units: number; item_count: number }>;
  recent_alerts: Array<{ type: string; created_at: string }>;
}

export async function buildChatContext(
  restaurantId: string,
  restaurantName: string,
): Promise<{ context: ChatContext; meta: ChatContextMeta }> {
  const today = new Date();
  const since = new Date(today);
  since.setDate(since.getDate() - 28);
  const sinceStr = since.toISOString().split('T')[0];
  const todayStr = today.toISOString().split('T')[0];

  const since30 = new Date(today);
  since30.setDate(since30.getDate() - 30);
  const since30Str = since30.toISOString().split('T')[0];

  // Daily revenue (28 days)
  const { data: dailySummaries, error: dsErr } = await supabase
    .from('daily_summaries')
    .select('date, total_revenue_cents, total_orders')
    .eq('restaurant_id', restaurantId)
    .gte('date', sinceStr)
    .order('date', { ascending: true });

  if (dsErr) throw new Error('Failed to fetch daily summaries');

  // Item-level aggregations for top/bottom (30 days)
  const { data: itemSummaries, error: isErr } = await supabase
    .from('daily_summaries')
    .select('menu_item_id, total_revenue_cents, total_quantity, menu_items(name, category)')
    .eq('restaurant_id', restaurantId)
    .gte('date', since30Str)
    .not('menu_item_id', 'is', null);

  if (isErr) throw new Error('Failed to fetch item summaries');

  // Aggregate per item
  const itemMap = new Map<string, { name: string; category: string; revenue: number; units: number }>();
  for (const row of itemSummaries ?? []) {
    if (!row.menu_item_id) continue;
    const miRaw = row.menu_items as unknown;
    const mi = Array.isArray(miRaw) ? (miRaw[0] as { name: string; category: string } | undefined) : (miRaw as { name: string; category: string } | null);
    if (!mi) continue;
    const existing = itemMap.get(row.menu_item_id) ?? {
      name: mi.name,
      category: mi.category ?? '',
      revenue: 0,
      units: 0,
    };
    existing.revenue += row.total_revenue_cents ?? 0;
    existing.units += row.total_quantity ?? 0;
    itemMap.set(row.menu_item_id, existing);
  }

  const allItems = Array.from(itemMap.values()).map((i) => ({
    name: i.name,
    category: i.category,
    revenue_cents: i.revenue,
    units: i.units,
  }));

  const sortedByRevenue = [...allItems].sort((a, b) => b.revenue_cents - a.revenue_cents);
  const top_items = sortedByRevenue.slice(0, 15);
  const bottom_items = sortedByRevenue.slice(-10).reverse();

  // Category breakdown
  const catMap = new Map<string, { revenue: number; units: number; item_count: Set<string> }>();
  for (const row of itemSummaries ?? []) {
    const miRaw2 = row.menu_items as unknown;
    const mi2 = Array.isArray(miRaw2) ? (miRaw2[0] as { name: string; category: string } | undefined) : (miRaw2 as { name: string; category: string } | null);
    const cat = mi2?.category ?? 'Uncategorized';
    const existing = catMap.get(cat) ?? { revenue: 0, units: 0, item_count: new Set() };
    existing.revenue += row.total_revenue_cents ?? 0;
    existing.units += row.total_quantity ?? 0;
    if (row.menu_item_id) existing.item_count.add(row.menu_item_id);
    catMap.set(cat, existing);
  }
  const category_breakdown = Array.from(catMap.entries())
    .map(([category, v]) => ({
      category,
      revenue_cents: v.revenue,
      units: v.units,
      item_count: v.item_count.size,
    }))
    .sort((a, b) => b.revenue_cents - a.revenue_cents);

  // Recent alerts
  const { data: alerts } = await supabase
    .from('alerts')
    .select('type, created_at')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false })
    .limit(10);

  // Aggregate daily revenue
  const dailyRevMap = new Map<string, { revenue: number; orders: number }>();
  for (const row of dailySummaries ?? []) {
    const existing = dailyRevMap.get(row.date) ?? { revenue: 0, orders: 0 };
    existing.revenue += row.total_revenue_cents ?? 0;
    existing.orders += row.total_orders ?? 0;
    dailyRevMap.set(row.date, existing);
  }
  const daily_revenue = Array.from(dailyRevMap.entries())
    .map(([date, v]) => ({ date, revenue_cents: v.revenue, orders: v.orders }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const context: ChatContext = {
    restaurant: { name: restaurantName },
    date_range: { from: sinceStr, to: todayStr },
    daily_revenue,
    top_items_by_revenue_30d: top_items,
    bottom_items_by_revenue_30d: bottom_items,
    category_breakdown_30d: category_breakdown,
    recent_alerts: (alerts ?? []).map((a) => ({ type: a.type, created_at: a.created_at })),
  };

  const meta: ChatContextMeta = {
    summaries_count: dailySummaries?.length ?? 0,
    orders_count: daily_revenue.reduce((sum, d) => sum + d.orders, 0),
    menu_items_count: itemMap.size,
    date_range: { from: sinceStr, to: todayStr },
  };

  return { context, meta };
}
