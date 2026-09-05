import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { requireRestaurant } from '../middleware/requireRestaurant';
import { validateBody, validateQuery } from '../middleware/validate';
import { resolveWindow, windowQuerySchema, WindowQuery } from '../lib/analyticsWindow';
import { analyzeMargins, MarginAnalysisError } from '../services/marginAnalysisService';
import {
  analyzeChannelMargins,
  ChannelMarginError,
} from '../services/channelMarginService';

/**
 * Page a full-table read with an explicit order + `.range()`, so the read
 * cannot be silently truncated by PostgREST's per-request row cap. Mirrors
 * services/ingestion/persistence.ts's selectPaged — kept local here since
 * this route reads with different filter shapes and that module is scoped to
 * the ingestion write path.
 */
const DASHBOARD_PAGE_SIZE = 1000;
async function selectAllPaged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const results: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + DASHBOARD_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    results.push(...rows);
    if (rows.length < DASHBOARD_PAGE_SIZE) break;
    from += DASHBOARD_PAGE_SIZE;
  }
  return results;
}

// PostgREST returns a many-to-one embed as an object; older client versions
// returned an array. Accept both shapes and unwrap with unwrapEmbed().
// menu_item_id is nullable — ON DELETE SET NULL means deleted items leave null rows.
interface EmbeddedMenuItem {
  name: string;
  category: string;
}
interface DailySummaryRow {
  menu_item_id: string | null;
  date: string;
  total_quantity: number;
  total_revenue_cents: number;
  total_orders: number;
  menu_items: EmbeddedMenuItem | EmbeddedMenuItem[] | null;
}

const unwrapEmbed = (embed: EmbeddedMenuItem | EmbeddedMenuItem[] | null): EmbeddedMenuItem | undefined =>
  Array.isArray(embed) ? embed[0] : embed ?? undefined;

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
// GET /api/analytics/dashboard?days=7|30|90 (default 30)
// Returns revenueTrend, topItems, hourlyDistribution, and a meta block
// describing the resolved window, for the selected trailing window.
// All aggregation is done in TypeScript after fetching from Supabase.
// ---------------------------------------------------------------------------
router.get(
  '/dashboard',
  validateQuery(windowQuerySchema),
  async (req: Request, res: Response) => {
  // Resolve "now" once and thread it through every boundary below — reading
  // the clock twice risks the orders and daily_summaries filters disagreeing
  // by however long the handler took to run between the two reads.
  const now = new Date();
  const { days, from, to, fromIso } = resolveWindow(
    (req.validatedQuery as WindowQuery).days,
    now,
  );
  const nowIso = now.toISOString();

  // Fetch daily_summaries with embedded menu_items for the window. Paged with
  // an explicit order + .range() — PostgREST silently caps an unranged
  // select at ~1000 rows, and a 90-day window for a busy restaurant can
  // exceed that with no error.
  let rows: DailySummaryRow[];
  try {
    rows = await selectAllPaged<DailySummaryRow>((from_, to_) =>
      supabase
        .from('daily_summaries')
        .select(
          'menu_item_id, date, total_quantity, total_revenue_cents, total_orders, menu_items(name, category)',
        )
        .eq('restaurant_id', req.restaurantId!)
        .gte('date', from)
        .lte('date', to)
        .order('date', { ascending: true })
        .range(from_, to_),
    );
  } catch {
    return res.status(500).json({ data: null, error: 'Failed to fetch daily summaries' });
  }

  // Fetch orders for the window — only the two columns we need. Both this
  // filter and the daily_summaries filter above derive from the SAME `from`
  // (and both are bounded by the same `now`), so hourlyDistribution and
  // revenueTrend cover identical spans and AOV divides across a matched range.
  let orderRows: OrderRow[];
  try {
    orderRows = await selectAllPaged<OrderRow>((from_, to_) =>
      supabase
        .from('orders')
        .select('ordered_at, total_cents')
        .eq('restaurant_id', req.restaurantId!)
        .gte('ordered_at', fromIso)
        .lte('ordered_at', nowIso)
        .order('ordered_at', { ascending: true })
        .range(from_, to_),
    );
  } catch {
    return res.status(500).json({ data: null, error: 'Failed to fetch orders' });
  }

  // Earliest order date for this restaurant, scoped to the tenant — an
  // unscoped "oldest order" query would leak another tenant's history into
  // this restaurant's meta block.
  const { data: earliestRows, error: earliestErr } = await supabase
    .from('orders')
    .select('ordered_at')
    .eq('restaurant_id', req.restaurantId!)
    .order('ordered_at', { ascending: true })
    .limit(1);

  if (earliestErr) {
    return res.status(500).json({ data: null, error: 'Failed to fetch orders' });
  }

  const earliestOrderedAt = (earliestRows as { ordered_at: string }[] | null)?.[0]?.ordered_at ?? null;
  const earliestDataDate = earliestOrderedAt ? earliestOrderedAt.split('T')[0] : null;
  const daysAvailable = earliestDataDate
    ? Math.floor(
        (new Date(`${to}T00:00:00.000Z`).getTime() -
          new Date(`${earliestDataDate > from ? earliestDataDate : from}T00:00:00.000Z`).getTime()) /
          (24 * 60 * 60 * 1000),
      ) + 1
    : 0;

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
    const menuItem = unwrapEmbed(row.menu_items);
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
    data: {
      revenueTrend,
      topItems,
      hourlyDistribution,
      meta: {
        days,
        from,
        to,
        earliest_data_date: earliestDataDate,
        days_available: daysAvailable,
      },
    },
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
