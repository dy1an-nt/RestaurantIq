/**
 * Shared persistence layer for order-source ingestion.
 *
 * Square and DoorDash (and any future source) normalize their payloads into the
 * row shapes in ./types.ts, then call these functions to write them. Keeping the
 * writes here — rather than duplicating them per source — guarantees that every
 * channel dedupes, links order items, and rebuilds daily_summaries identically.
 *
 * The only source-specific input is the `source` tag, which scopes the catalog
 * upsert/lookup and the order dedup so two channels can never collide on each
 * other's external ids.
 *
 * This logic was originally written inline in services/square/ingestSquare.ts;
 * it was lifted here verbatim (plus source parametrization) so Square's proven
 * behavior is preserved while DoorDash reuses it.
 */
import { supabase } from '../../db';
import { generateAlerts } from '../alertsService';
import { MenuItemRow, OrderSource, NormalizedOrder } from './types';

/**
 * PostgREST silently caps an unranged `select()` (commonly 1000 rows) with no
 * error, so any read whose correctness depends on seeing every row must page
 * with `.range()` and carry an explicit `.order()` — range paging over an
 * unordered query can repeat or skip rows. See docs/sharp-edges.md.
 */
const SELECT_PAGE_SIZE = 1000;

/** PostgREST's request-line length caps how many ids `.in()` can carry at once. */
const ID_CHUNK_SIZE = 500;

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * Page a full-table read with an explicit order + `.range()`, accumulating
 * every row regardless of PostgREST's per-request row cap.
 */
async function selectPaged<T>(
  table: string,
  columns: string,
  applyFilters: (q: any) => any,
  orderCol: string,
): Promise<T[]> {
  const results: T[] = [];
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select(columns);
    q = applyFilters(q);
    q = q.order(orderCol, { ascending: true }).range(from, from + SELECT_PAGE_SIZE - 1);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    results.push(...rows);
    if (rows.length < SELECT_PAGE_SIZE) break;
    from += SELECT_PAGE_SIZE;
  }
  return results;
}

/**
 * Upsert menu items by (restaurant_id, source, external_id).
 * Returns a map of external_id → internal menu_items.id for FK linking.
 */
export const upsertCatalog = async (
  rows: MenuItemRow[],
  source: OrderSource,
): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  if (rows.length === 0) return map;

  // Match on (restaurant_id, source, external_id). Migration 008 added a
  // UNIQUE constraint on this triple — Supabase's upsert with onConflict
  // uses it directly.
  const withExternal = rows.filter((r) => r.external_id);
  if (withExternal.length > 0) {
    const { error } = await supabase
      .from('menu_items')
      .upsert(withExternal, { onConflict: 'restaurant_id,source,external_id' });
    if (error) throw new Error(`menu_items upsert failed: ${error.message}`);

    // Re-read to populate the map. Doing a fresh select is more reliable than
    // trusting the upsert's returning clause: when a row is unchanged, some
    // PostgREST configs omit it from the returned set, leaving the map sparse
    // and silently breaking order_item linkage on the next sync.
    const restaurantId = withExternal[0].restaurant_id;
    const externalIds = withExternal.map((r) => r.external_id!) as string[];
    const { data: fetched, error: fetchErr } = await supabase
      .from('menu_items')
      .select('id, external_id')
      .eq('restaurant_id', restaurantId)
      .eq('source', source)
      .in('external_id', externalIds);
    if (fetchErr) throw new Error(`menu_items lookup failed: ${fetchErr.message}`);
    for (const row of fetched ?? []) {
      if (row.external_id) map.set(row.external_id, row.id);
    }
  }

  // Rows without external_id (shouldn't happen for POS sources but guard anyway):
  // fall back to plain insert.
  const withoutExternal = rows.filter((r) => !r.external_id);
  if (withoutExternal.length > 0) {
    const { error } = await supabase.from('menu_items').insert(withoutExternal);
    if (error) throw new Error(`menu_items insert failed: ${error.message}`);
  }

  return map;
};

export interface UpsertOrdersResult {
  count: number;
  /** Distinct (UTC) dates of orders actually inserted by this call. */
  insertedDates: string[];
}

/**
 * Insert new orders + their line items, deduped by (restaurant_id, source,
 * external_id) so re-syncs never create duplicate orders.
 */
export const upsertOrders = async (
  orders: NormalizedOrder[],
  externalToInternalMenuItem: Map<string, string>,
  source: OrderSource,
): Promise<UpsertOrdersResult> => {
  if (orders.length === 0) return { count: 0, insertedDates: [] };

  const restaurantId = orders[0].order.restaurant_id;

  // Partition: orders from a proper Orders API have an external_id;
  // the payments-API fallback path (Square legacy) does not.
  const withId = orders.filter((o) => o.order.external_id);
  const withoutId = orders.filter((o) => !o.order.external_id);

  // ── Batch path (Orders API) ──────────────────────────────────────────────
  // One SELECT to find which external_ids already exist, then one INSERT for
  // all new orders, then one INSERT for all their line items.

  const existingExternalIds = new Set<string>();
  if (withId.length > 0) {
    const { data: existing, error: exErr } = await supabase
      .from('orders')
      .select('external_id')
      .eq('restaurant_id', restaurantId)
      .eq('source', source)
      .in('external_id', withId.map((o) => o.order.external_id!));
    if (exErr) throw new Error(`orders dedup query failed: ${exErr.message}`);
    for (const row of existing ?? []) {
      if (row.external_id) existingExternalIds.add(row.external_id);
    }
  }

  const newWithId = withId.filter((o) => !existingExternalIds.has(o.order.external_id!));
  let count = newWithId.length;
  const newOrderIdMap = new Map<string, string>(); // external_id → internal id
  const insertedDates = new Set<string>();
  for (const o of newWithId) insertedDates.add(o.order.ordered_at.split('T')[0]);

  if (newWithId.length > 0) {
    const { data: inserted, error: insErr } = await supabase
      .from('orders')
      .insert(
        newWithId.map((o) => ({
          restaurant_id: o.order.restaurant_id,
          source: o.order.source,
          total_cents: o.order.total_cents,
          ordered_at: o.order.ordered_at,
          external_id: o.order.external_id,
        })),
      )
      .select('id, external_id');
    if (insErr) throw new Error(`orders insert failed: ${insErr.message}`);
    for (const row of inserted ?? []) {
      if (row.external_id) newOrderIdMap.set(row.external_id, row.id);
    }
  }

  // Collect all line items for the newly inserted orders and insert in one batch.
  const allNewItems: {
    order_id: string;
    menu_item_id: string;
    quantity: number;
    unit_price_cents: number;
  }[] = [];

  for (const { order, items } of newWithId) {
    const orderId = newOrderIdMap.get(order.external_id!);
    if (!orderId || items.length === 0) continue;
    let dropped = 0;
    for (const it of items) {
      const menuItemId = it.menu_item_external_id
        ? externalToInternalMenuItem.get(it.menu_item_external_id)
        : undefined;
      if (!menuItemId) { dropped++; continue; }
      allNewItems.push({
        order_id: orderId,
        menu_item_id: menuItemId,
        quantity: it.quantity,
        unit_price_cents: it.unit_price_cents,
      });
    }
    if (dropped > 0) {
      console.error(
        `[${source}] upsertOrders: dropped ${dropped}/${items.length} line items with unmapped menu_item_external_id`,
      );
    }
  }

  if (allNewItems.length > 0) {
    const { error: oiErr } = await supabase.from('order_items').insert(allNewItems);
    if (oiErr) throw new Error(`order_items insert failed: ${oiErr.message}`);
  }

  // ── Serial fallback path (no external_id — Square Payments API only) ──────
  // Dedup by ordered_at + total_cents.
  for (const { order, items } of withoutId) {
    const { data: existing } = await supabase
      .from('orders')
      .select('id')
      .eq('restaurant_id', order.restaurant_id)
      .eq('source', source)
      .eq('ordered_at', order.ordered_at)
      .eq('total_cents', order.total_cents)
      .maybeSingle();

    if (existing) continue;

    const { data: inserted, error: insErr } = await supabase
      .from('orders')
      .insert({
        restaurant_id: order.restaurant_id,
        source: order.source,
        total_cents: order.total_cents,
        ordered_at: order.ordered_at,
        external_id: null,
      })
      .select('id')
      .single();
    if (insErr) throw new Error(`orders insert failed: ${insErr.message}`);
    count++;
    insertedDates.add(order.ordered_at.split('T')[0]);

    if (items.length > 0) {
      const mapped = items.flatMap((it) => {
        const menuItemId = it.menu_item_external_id
          ? externalToInternalMenuItem.get(it.menu_item_external_id)
          : undefined;
        return menuItemId
          ? [{ order_id: inserted!.id, menu_item_id: menuItemId, quantity: it.quantity, unit_price_cents: it.unit_price_cents }]
          : [];
      });
      if (mapped.length > 0) {
        const { error: oiErr } = await supabase.from('order_items').insert(mapped);
        if (oiErr) throw new Error(`order_items insert failed: ${oiErr.message}`);
      }
    }
  }

  return { count, insertedDates: Array.from(insertedDates) };
};

const isoDate = (d: Date): string => d.toISOString().split('T')[0];

/** How far back the one-time coverage bootstrap recomputes, and the floor any
 * backdated top-up is clamped to. */
const COVERAGE_BOOTSTRAP_DAYS = 90;
const STEADY_STATE_DAYS = 30;

/**
 * Recompute daily_summaries for an explicit [from, to] range from
 * orders/order_items. Pure recompute-and-prune: no range selection logic.
 *
 * Uses upsert (not delete+insert) so that if the write fails, the previous
 * data is preserved. After a successful upsert, rows in the range that have
 * no current activity are deleted (stale rows from deleted items).
 *
 * Every delete here carries restaurant_id + a lower AND upper date bound —
 * an unbounded `.gte('date', from)` is only safe while ranges are trailing.
 * Once ranges can be arbitrary (bootstrap, backdated top-up), an unbounded
 * delete on a restaurant with no orders in that range would wipe every
 * summary from `from` forward, including today's.
 */
async function recomputeRange(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<{ from: string; to: string; orderCount: number }> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const fromDate = isoDate(from);
  const toDate = isoDate(to);

  const orders = await selectPaged<{ id: string; ordered_at: string }>(
    'orders',
    'id, ordered_at',
    (q) => q.eq('restaurant_id', restaurantId).gte('ordered_at', fromIso).lte('ordered_at', toIso),
    'ordered_at',
  );

  if (orders.length === 0) {
    // No orders in the range — clear summaries for this period.
    const { error: delErr } = await supabase
      .from('daily_summaries')
      .delete()
      .eq('restaurant_id', restaurantId)
      .gte('date', fromDate)
      .lte('date', toDate);
    if (delErr) throw new Error(`daily_summaries delete failed: ${delErr.message}`);
    return { from: fromDate, to: toDate, orderCount: 0 };
  }

  const orderIds = orders.map((o) => o.id);
  const orderItems: { order_id: string; menu_item_id: string | null; quantity: number; unit_price_cents: number }[] = [];
  for (const idChunk of chunk(orderIds, ID_CHUNK_SIZE)) {
    const rows = await selectPaged<{
      order_id: string;
      menu_item_id: string | null;
      quantity: number;
      unit_price_cents: number;
    }>(
      'order_items',
      'order_id, menu_item_id, quantity, unit_price_cents',
      (q) => q.in('order_id', idChunk),
      'order_id',
    );
    orderItems.push(...rows);
  }

  const itemsByOrder = new Map<string, typeof orderItems>();
  for (const oi of orderItems) {
    const arr = itemsByOrder.get(oi.order_id) ?? [];
    arr.push(oi);
    itemsByOrder.set(oi.order_id, arr);
  }

  type Bucket = { qty: number; rev: number; orders: Set<string> };
  const buckets = new Map<string, Bucket>();

  for (const o of orders) {
    const date = o.ordered_at.split('T')[0];
    const lines = itemsByOrder.get(o.id) ?? [];
    for (const oi of lines) {
      if (!oi.menu_item_id) continue;
      const key = `${date}|${oi.menu_item_id}`;
      const b = buckets.get(key) ?? { qty: 0, rev: 0, orders: new Set<string>() };
      b.qty += oi.quantity;
      b.rev += oi.quantity * oi.unit_price_cents;
      b.orders.add(o.id);
      buckets.set(key, b);
    }
  }

  const summaries = Array.from(buckets.entries()).map(([key, b]) => {
    const [date, menu_item_id] = key.split('|');
    return {
      restaurant_id: restaurantId,
      menu_item_id,
      date,
      total_quantity: b.qty,
      total_revenue_cents: b.rev,
      total_orders: b.orders.size,
    };
  });

  // UPSERT first — if this fails, old data is preserved (no delete has happened).
  const { error: upsertErr } = await supabase
    .from('daily_summaries')
    .upsert(summaries, { onConflict: 'restaurant_id,menu_item_id,date' });
  if (upsertErr) throw new Error(`daily_summaries upsert failed: ${upsertErr.message}`);

  // After successful upsert, prune stale rows (rows in the range that no
  // longer have any orders — e.g. deleted items from a prior sync window).
  const activeKeys = new Set(summaries.map((s) => `${s.menu_item_id}|${s.date}`));
  const existing = await selectPaged<{ id: string; menu_item_id: string | null; date: string }>(
    'daily_summaries',
    'id, menu_item_id, date',
    (q) => q.eq('restaurant_id', restaurantId).gte('date', fromDate).lte('date', toDate),
    'date',
  );

  const staleIds = existing
    .filter((r) => r.menu_item_id && !activeKeys.has(`${r.menu_item_id}|${r.date}`))
    .map((r) => r.id);

  if (staleIds.length > 0) {
    const { error: delErr } = await supabase
      .from('daily_summaries')
      .delete()
      .eq('restaurant_id', restaurantId)
      .gte('date', fromDate)
      .lte('date', toDate)
      .in('id', staleIds);
    if (delErr) {
      console.error('[ingestion] stale daily_summaries cleanup failed:', delErr.message);
    }
  }

  return { from: fromDate, to: toDate, orderCount: orders.length };
}

/**
 * Recompute daily_summaries for a restaurant, choosing the range to recompute
 * (see the module doc comment on the exported function) then delegating the
 * actual read/upsert/prune work to recomputeRange.
 *
 * `now` is injected (default: real clock) so the window is deterministic
 * under test. Reading `new Date()` inline here made the window slide with the
 * calendar, which silently rotted both the data and the tests that seeded fixed
 * dates — inject the instant instead of coupling to the wall clock.
 */
export const refreshDailySummaries = async (
  restaurantId: string,
  opts: { from?: Date; to?: Date; insertedOrderDates?: string[] } = {},
  now: Date = new Date(),
): Promise<{ from: string; to: string; orderCount: number }> => {
  const target = new Date(now);
  target.setUTCDate(target.getUTCDate() - COVERAGE_BOOTSTRAP_DAYS);
  const targetDate = isoDate(target);

  let from: Date;
  let to: Date;
  let bootstrapping = false;

  if (opts.from) {
    // 1. Explicit range — the seam a future chunked backfill uses.
    from = opts.from;
    to = opts.to ?? now;
  } else {
    // 2. Coverage bootstrap: one time per restaurant, only when the watermark
    // is missing or later than the 90-day target.
    const { data: restRow, error: restErr } = await supabase
      .from('restaurants')
      .select('summaries_covered_from')
      .eq('id', restaurantId)
      .maybeSingle();
    if (restErr) throw new Error(`restaurants lookup failed: ${restErr.message}`);

    const coveredFrom = restRow?.summaries_covered_from
      ? new Date(`${restRow.summaries_covered_from}T00:00:00.000Z`)
      : null;

    if (!coveredFrom || coveredFrom > target) {
      bootstrapping = true;
      from = target;
      to = now;
    } else {
      // 3. Steady state — same cost as before this change.
      from = new Date(now);
      from.setUTCDate(from.getUTCDate() - STEADY_STATE_DAYS);
      to = now;
    }
  }

  const result = await recomputeRange(restaurantId, from, to);

  // Write the watermark ONLY after a successful recompute (upsert + prune) —
  // writing it first would permanently mark an incomplete restaurant as covered.
  if (bootstrapping) {
    const { error: wmErr } = await supabase
      .from('restaurants')
      .update({ summaries_covered_from: targetDate })
      .eq('id', restaurantId);
    if (wmErr) throw new Error(`restaurants watermark update failed: ${wmErr.message}`);
  }

  // 4. Backdated top-up, additive to the steady-state path only: at most one
  // extra recompute per sync, over the single contiguous range covering every
  // inserted order older than the steady-state window, clamped to the 90-day
  // target so this can never re-walk further back than the bootstrap already
  // guaranteed.
  if (!opts.from && !bootstrapping && opts.insertedOrderDates && opts.insertedOrderDates.length > 0) {
    const steadyFromDate = isoDate(from);
    const olderDates = opts.insertedOrderDates.filter((d) => d < steadyFromDate);
    if (olderDates.length > 0) {
      const minOlderDate = olderDates.reduce((a, b) => (a < b ? a : b));
      const clampedFromDate = minOlderDate < targetDate ? targetDate : minOlderDate;
      const topUpFrom = new Date(`${clampedFromDate}T00:00:00.000Z`);
      const topUpTo = new Date(from.getTime() - 1);
      if (topUpFrom <= topUpTo) {
        await recomputeRange(restaurantId, topUpFrom, topUpTo);
      }
    }
  }

  return result;
};

/**
 * Regenerate alerts from the freshly rebuilt summaries.
 * Fire-and-forget: alert errors must never fail a sync. The `source` tag is
 * only used for logging clarity.
 */
export const runAlerts = async (restaurantId: string, source: OrderSource): Promise<void> => {
  try {
    const alertCount = await generateAlerts(restaurantId);
    if (alertCount > 0) console.error(`[${source}] generated ${alertCount} new alert(s)`);
  } catch (err) {
    console.error(`[${source}] alerts generation failed:`, (err as Error).message);
  }
};
