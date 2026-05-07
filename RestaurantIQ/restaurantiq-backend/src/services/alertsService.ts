import { supabase } from '../db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertType = 'no_sales' | 'trending_down' | 'new_top_performer';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertInsert {
  restaurant_id: string;
  menu_item_id: string | null;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  dedup_key: string;
}

// Candidates produced by evaluateAlerts before restaurant_id and dedup_key are stamped.
type AlertCandidate = Omit<AlertInsert, 'restaurant_id' | 'dedup_key'>;

// ---------------------------------------------------------------------------
// Internal types for query results
// ---------------------------------------------------------------------------

interface DailySummaryRow {
  menu_item_id: string;
  date: string;
  total_quantity: number;
  total_revenue_cents: number;
  // PostgREST returns embedded relations as arrays even for many-to-one FKs.
  menu_items: { name: string }[] | null;
}

interface RecentAlertRow {
  type: string;
  menu_item_id: string | null;
}

interface ItemStats {
  menuItemId: string;
  name: string;
  currentRevenue: number;  // integer cents
  priorRevenue: number;    // integer cents
  currentQty: number;
  priorQty: number;
}

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------

/**
 * Fetch daily_summaries joined with menu_items(name) for the last 14 days.
 * Returns two windows:
 *   current week  = days 0–6  from today (inclusive, UTC)
 *   prior week    = days 7–13 from today (inclusive, UTC)
 */
const fetchItemStats = async (restaurantId: string): Promise<ItemStats[]> => {
  // Compute window boundaries in UTC
  const now = new Date();

  // current window: today back to 6 days ago  (0 <= age <= 6)
  const currentStart = new Date(now);
  currentStart.setUTCDate(currentStart.getUTCDate() - 6);

  // prior window: 7 days ago back to 13 days ago  (7 <= age <= 13)
  const priorStart = new Date(now);
  priorStart.setUTCDate(priorStart.getUTCDate() - 13);

  const currentStartDate = currentStart.toISOString().split('T')[0];
  const priorStartDate = priorStart.toISOString().split('T')[0];
  const todayDate = now.toISOString().split('T')[0];

  // prior window ends the day before current window starts
  const priorEndDate = new Date(currentStart);
  priorEndDate.setUTCDate(priorEndDate.getUTCDate() - 1);
  const priorEndDateStr = priorEndDate.toISOString().split('T')[0];

  const { data: rows, error } = await supabase
    .from('daily_summaries')
    .select('menu_item_id, date, total_quantity, total_revenue_cents, menu_items(name)')
    .eq('restaurant_id', restaurantId)
    .gte('date', priorStartDate)
    .lte('date', todayDate);

  if (error) throw new Error(`daily_summaries fetch failed: ${error.message}`);

  // Group by menu_item_id and accumulate into two windows
  const statsMap = new Map<string, ItemStats>();

  for (const row of (rows ?? []) as unknown as DailySummaryRow[]) {
    const itemId = row.menu_item_id;
    const name = row.menu_items?.[0]?.name ?? itemId;
    const date = row.date;

    if (!statsMap.has(itemId)) {
      statsMap.set(itemId, {
        menuItemId: itemId,
        name,
        currentRevenue: 0,
        priorRevenue: 0,
        currentQty: 0,
        priorQty: 0,
      });
    }

    const stats = statsMap.get(itemId)!;

    if (date >= currentStartDate && date <= todayDate) {
      // current week: days 0–6
      stats.currentRevenue += row.total_revenue_cents;
      stats.currentQty += row.total_quantity;
    } else if (date >= priorStartDate && date <= priorEndDateStr) {
      // prior week: days 7–13
      stats.priorRevenue += row.total_revenue_cents;
      stats.priorQty += row.total_quantity;
    }
  }

  return Array.from(statsMap.values());
};

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Fetch all alerts for this restaurant of the relevant types created within
 * the last 7 days in ONE query. Returns a Set of deduplication keys
 * formatted as `${type}|${menu_item_id ?? ''}`.
 */
const fetchRecentAlertKeys = async (restaurantId: string): Promise<Set<string>> => {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);

  const { data, error } = await supabase
    .from('alerts')
    .select('type, menu_item_id')
    .eq('restaurant_id', restaurantId)
    .in('type', ['no_sales', 'trending_down', 'new_top_performer'] as AlertType[])
    .gte('created_at', sevenDaysAgo.toISOString());

  if (error) throw new Error(`alerts dedup fetch failed: ${error.message}`);

  const keys = new Set<string>();
  for (const row of (data ?? []) as RecentAlertRow[]) {
    keys.add(`${row.type}|${row.menu_item_id ?? ''}`);
  }
  return keys;
};

const dedupKey = (type: AlertType, menuItemId: string | null): string =>
  `${type}|${menuItemId ?? ''}`;

// ---------------------------------------------------------------------------
// Alert rule evaluation
// ---------------------------------------------------------------------------

const evaluateAlerts = (items: ItemStats[]): AlertCandidate[] => {
  const alerts: AlertCandidate[] = [];

  // Pre-sort by current revenue descending for top-performer ranking
  const byCurrentRevenue = [...items].sort((a, b) => b.currentRevenue - a.currentRevenue);
  const byPriorRevenue = [...items].sort((a, b) => b.priorRevenue - a.priorRevenue);

  // Build prior-week top-3 set (by index, 0-based)
  const priorTop3Ids = new Set(byPriorRevenue.slice(0, 3).map((i) => i.menuItemId));

  for (const item of items) {
    const { menuItemId, name, currentRevenue, priorRevenue, currentQty, priorQty } = item;

    // ------------------------------------------------------------------
    // Rule: no_sales — severity: warning
    // Fired when an item had meaningful sales last week but zero this week.
    // Threshold: priorQty > 0 AND currentQty === 0 AND priorRevenue > 500 cents
    // ($5 minimum avoids noise from $0.01 test items).
    // ------------------------------------------------------------------
    if (priorQty > 0 && currentQty === 0 && priorRevenue > 500) {
      alerts.push({
        menu_item_id: menuItemId,
        type: 'no_sales',
        severity: 'warning',
        title: `${name} has zero sales this week`,
        message: `${name} sold ${priorQty} units last week but has had no sales in the past 7 days.`,
        metadata: { priorQty, priorRevenueCents: priorRevenue },
        is_read: false,
      });
    }

    // ------------------------------------------------------------------
    // Rule: trending_down — severity: warning
    // Fired when week-over-week revenue drops by more than 20%.
    // Both windows must exceed noise floors: priorRevenue > 1000 cents ($10)
    // and currentRevenue > 0 (item is still selling, just less).
    // Threshold uses integer arithmetic (5 * current < 4 * prior) to avoid
    // float multiplication on money values (0.80 is not exactly representable
    // in IEEE 754).
    // ------------------------------------------------------------------
    if (priorRevenue > 1000 && currentRevenue > 0 && 5 * currentRevenue < 4 * priorRevenue) {
      // Integer percentage, rounded down (conservative display)
      const pct = Math.floor(((priorRevenue - currentRevenue) / priorRevenue) * 100);
      alerts.push({
        menu_item_id: menuItemId,
        type: 'trending_down',
        severity: 'warning',
        title: `${name} revenue down ${pct}% this week`,
        message:
          `${name} brought in $${(currentRevenue / 100).toFixed(2)} this week vs ` +
          `$${(priorRevenue / 100).toFixed(2)} last week — a ${pct}% decline.`,
        metadata: {
          currentRevenueCents: currentRevenue,
          priorRevenueCents: priorRevenue,
          declinePercent: pct,
        },
        is_read: false,
      });
    }
  }

  // ------------------------------------------------------------------
  // Rule: new_top_performer — severity: info
  // An item is in the current week's top 3 by revenue but was NOT in
  // the prior week's top 3. Minimum current revenue: > 5000 cents ($50)
  // to suppress noise from low-volume weeks.
  // ------------------------------------------------------------------
  for (let rank = 0; rank < Math.min(3, byCurrentRevenue.length); rank++) {
    const item = byCurrentRevenue[rank];
    if (item.currentRevenue > 5000 && !priorTop3Ids.has(item.menuItemId)) {
      alerts.push({
        menu_item_id: item.menuItemId,
        type: 'new_top_performer',
        severity: 'info',
        title: `${item.name} is a new top performer`,
        message:
          `${item.name} is now a top-3 revenue item this week with ` +
          `$${(item.currentRevenue / 100).toFixed(2)} — up from outside the top 3 last week.`,
        metadata: {
          currentRevenueCents: item.currentRevenue,
          priorRevenueCents: item.priorRevenue,
          currentRank: rank + 1,
        },
        is_read: false,
      });
    }
  }

  return alerts;
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Returns the ISO date string (YYYY-MM-DD) of the Monday of the current UTC week.
// Used as the week bucket in dedup_key so only one alert per type/item fires per week.
const getWeekStart = (): string => {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, …, 6 = Saturday
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().split('T')[0];
};

export const generateAlerts = async (restaurantId: string): Promise<number> => {
  try {
    const [items, recentKeys] = await Promise.all([
      fetchItemStats(restaurantId),
      fetchRecentAlertKeys(restaurantId),
    ]);

    if (items.length === 0) return 0;

    const candidates = evaluateAlerts(items);
    const weekStart = getWeekStart();

    // Stamp restaurant_id and dedup_key, then filter against in-memory recent keys
    // for efficiency. The upsert below provides the final DB-level race guard.
    const toInsert: AlertInsert[] = candidates
      .map((a) => ({
        ...a,
        restaurant_id: restaurantId,
        dedup_key: `${a.type}|${a.menu_item_id ?? ''}|${weekStart}`,
      }))
      .filter((a) => !recentKeys.has(dedupKey(a.type, a.menu_item_id)));

    if (toInsert.length === 0) return 0;

    // ignoreDuplicates: true → ON CONFLICT DO NOTHING on (restaurant_id, dedup_key).
    // Concurrent syncs that race past the in-memory check are silently dropped at DB level.
    const { error } = await supabase
      .from('alerts')
      .upsert(toInsert, { onConflict: 'restaurant_id,dedup_key', ignoreDuplicates: true });

    if (error) {
      console.error('[alerts] upsert failed:', error.message);
      return 0;
    }

    return toInsert.length;
  } catch (err) {
    console.error('[alerts] generateAlerts error:', (err as Error).message);
    return 0;
  }
};
