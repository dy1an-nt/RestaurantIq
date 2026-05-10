import { supabase } from '../../db';
import { getSquareClient, isMockMode } from './squareClient';
import { decryptTokenSafe } from '../../lib/tokenCrypto';
import {
  normalizeCatalogItem,
  normalizeOrder,
  normalizePayment,
  MenuItemRow,
  OrderRow,
  OrderItemRow,
} from './normalizers';
import { generateAlerts } from '../alertsService';

interface IngestResult {
  ok: boolean;
  mock?: boolean;
  catalogCount: number;
  orderCount: number;
  fallbackUsedPayments?: boolean;
  message?: string;
}

/**
 * Look up a restaurant's Square credentials + location.
 */
const loadRestaurantCreds = async (restaurantId: string) => {
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, square_location_id, square_access_token')
    .eq('id', restaurantId)
    .single();

  if (error) throw new Error(`Restaurant lookup failed: ${error.message}`);
  if (!data) throw new Error('Restaurant not found');
  return data as { id: string; square_location_id: string | null; square_access_token: string | null };
};

/**
 * Upsert menu items by (restaurant_id, source, external_id).
 * Returns a map of square_external_id → internal menu_items.id for FK linking.
 */
const upsertCatalog = async (rows: MenuItemRow[]): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  if (rows.length === 0) return map;

  // Match on (restaurant_id, source, external_id). Migration 005 added a
  // partial unique index on this triple — Supabase's upsert with onConflict
  // will use it directly.
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
      .eq('source', 'square')
      .in('external_id', externalIds);
    if (fetchErr) throw new Error(`menu_items lookup failed: ${fetchErr.message}`);
    for (const row of fetched ?? []) {
      if (row.external_id) map.set(row.external_id, row.id);
    }
  }

  // Rows without external_id (shouldn't happen for Square but guard anyway):
  // fall back to plain insert.
  const withoutExternal = rows.filter((r) => !r.external_id);
  if (withoutExternal.length > 0) {
    const { error } = await supabase.from('menu_items').insert(withoutExternal);
    if (error) throw new Error(`menu_items insert failed: ${error.message}`);
  }

  return map;
};

const upsertOrders = async (
  orders: { order: OrderRow; items: OrderItemRow[] }[],
  externalToInternalMenuItem: Map<string, string>,
): Promise<number> => {
  if (orders.length === 0) return 0;

  const restaurantId = orders[0].order.restaurant_id;

  // Partition: orders from the Square Orders API have an external_id;
  // the payments-API fallback path does not.
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
      .in('external_id', withId.map((o) => o.order.external_id!));
    if (exErr) throw new Error(`orders dedup query failed: ${exErr.message}`);
    for (const row of existing ?? []) {
      if (row.external_id) existingExternalIds.add(row.external_id);
    }
  }

  const newWithId = withId.filter((o) => !existingExternalIds.has(o.order.external_id!));
  let count = newWithId.length;
  const newOrderIdMap = new Map<string, string>(); // external_id → internal id

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
        `[square] upsertOrders: dropped ${dropped}/${items.length} line items with unmapped menu_item_external_id`,
      );
    }
  }

  if (allNewItems.length > 0) {
    const { error: oiErr } = await supabase.from('order_items').insert(allNewItems);
    if (oiErr) throw new Error(`order_items insert failed: ${oiErr.message}`);
  }

  // ── Serial fallback path (Payments API — typically empty) ────────────────
  // No external_id available, so dedup by ordered_at + total_cents.
  for (const { order, items } of withoutId) {
    const { data: existing } = await supabase
      .from('orders')
      .select('id')
      .eq('restaurant_id', order.restaurant_id)
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

  return count;
};

/**
 * Recompute daily_summaries for the last 30 days from orders/order_items.
 *
 * Uses upsert (not delete+insert) so that if the write fails, the previous
 * data is preserved. After a successful upsert, rows in the 30-day window
 * that have no current activity are deleted (stale rows from deleted items).
 */
const refreshDailySummaries = async (restaurantId: string): Promise<void> => {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceIso = since.toISOString();
  const sinceDate = sinceIso.split('T')[0];

  const { data: orders, error: ordersErr } = await supabase
    .from('orders')
    .select('id, ordered_at')
    .eq('restaurant_id', restaurantId)
    .gte('ordered_at', sinceIso);
  if (ordersErr) throw new Error(`orders fetch failed: ${ordersErr.message}`);

  if (!orders || orders.length === 0) {
    // No orders in the window — clear summaries for this period.
    const { error: delErr } = await supabase
      .from('daily_summaries')
      .delete()
      .eq('restaurant_id', restaurantId)
      .gte('date', sinceDate);
    if (delErr) throw new Error(`daily_summaries delete failed: ${delErr.message}`);
    return;
  }

  const orderIds = orders.map((o) => o.id as string);
  const { data: orderItems, error: itemsErr } = await supabase
    .from('order_items')
    .select('order_id, menu_item_id, quantity, unit_price_cents')
    .in('order_id', orderIds);
  if (itemsErr) throw new Error(`order_items fetch failed: ${itemsErr.message}`);

  const itemsByOrder = new Map<string, any[]>();
  for (const oi of orderItems ?? []) {
    const arr = itemsByOrder.get(oi.order_id as string) ?? [];
    arr.push(oi);
    itemsByOrder.set(oi.order_id as string, arr);
  }

  type Bucket = { qty: number; rev: number; orders: Set<string> };
  const buckets = new Map<string, Bucket>();

  for (const o of orders as any[]) {
    const date = (o.ordered_at as string).split('T')[0];
    const lines = itemsByOrder.get(o.id as string) ?? [];
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

  // After successful upsert, prune stale rows (rows in the window that no
  // longer have any orders — e.g. deleted items from a prior sync window).
  const activeKeys = new Set(summaries.map((s) => `${s.menu_item_id}|${s.date}`));
  const { data: existing } = await supabase
    .from('daily_summaries')
    .select('id, menu_item_id, date')
    .eq('restaurant_id', restaurantId)
    .gte('date', sinceDate);

  const staleIds = (existing ?? [])
    .filter((r) => r.menu_item_id && !activeKeys.has(`${r.menu_item_id}|${r.date}`))
    .map((r) => r.id as string);

  if (staleIds.length > 0) {
    const { error: delErr } = await supabase
      .from('daily_summaries')
      .delete()
      .in('id', staleIds);
    if (delErr) {
      console.error('[square] stale daily_summaries cleanup failed:', delErr.message);
    }
  }
};

/**
 * Main ingestion entry point.
 * Pulls catalog → upserts menu_items, pulls orders (with payment fallback) →
 * upserts orders + order_items, then rebuilds daily_summaries.
 */
export const ingestSquare = async (restaurantId: string): Promise<IngestResult> => {
  if (isMockMode()) {
    return {
      ok: true,
      mock: true,
      catalogCount: 0,
      orderCount: 0,
      message: 'USE_MOCK=true — Square ingestion skipped, dashboard will use seeded data.',
    };
  }

  const restaurant = await loadRestaurantCreds(restaurantId);
  if (!restaurant.square_location_id) {
    throw new Error('Restaurant has no square_location_id — call /connect first.');
  }

  const client = getSquareClient({ accessToken: decryptTokenSafe(restaurant.square_access_token ?? '') });
  const locationId = restaurant.square_location_id;

  // 1. Catalog
  const catalogRows: MenuItemRow[] = [];
  let cursor: string | undefined;
  do {
    const { result } = await client.catalogApi.searchCatalogObjects({
      objectTypes: ['ITEM'],
      cursor,
      includeRelatedObjects: true,
    });
    for (const obj of result.objects ?? []) {
      const row = normalizeCatalogItem(obj, restaurantId);
      if (row) catalogRows.push(row);
    }
    cursor = result.cursor;
  } while (cursor);

  const externalToInternal = await upsertCatalog(catalogRows);

  // 2. Orders
  const orderRows: { order: OrderRow; items: OrderItemRow[] }[] = [];
  let orderCursor: string | undefined;
  let ordersOk = true;
  try {
    do {
      const { result } = await client.ordersApi.searchOrders({
        locationIds: [locationId],
        cursor: orderCursor,
        query: {
          filter: { stateFilter: { states: ['COMPLETED'] } },
          sort: { sortField: 'CLOSED_AT', sortOrder: 'DESC' },
        },
      });
      for (const o of result.orders ?? []) {
        const norm = normalizeOrder(o, restaurantId);
        if (norm) orderRows.push(norm);
      }
      orderCursor = result.cursor;
    } while (orderCursor);
  } catch (err) {
    ordersOk = false;
    console.error('[square] searchOrders failed:', (err as Error).message);
  }

  // Payments fallback for legacy Square accounts without Orders API access.
  // Disabled by default — the v37 SDK mishandles undefined positional args.
  // Re-enable with PAYMENTS_FALLBACK=true once we have a need + a fix.
  let fallbackUsedPayments = false;
  if (orderRows.length === 0 && process.env.PAYMENTS_FALLBACK === 'true') {
    fallbackUsedPayments = true;
    try {
      const { result } = await (client.paymentsApi as any).listPayments({ locationId });
      for (const p of result.payments ?? []) {
        const order = normalizePayment(p, restaurantId);
        if (order) orderRows.push({ order, items: [] });
      }
    } catch (err) {
      console.error('[square] listPayments fallback failed:', (err as Error).message);
    }
  }

  const orderCount = await upsertOrders(orderRows, externalToInternal);

  // 3. Recompute daily_summaries
  await refreshDailySummaries(restaurantId);

  // 4. Generate alerts from the freshly rebuilt summaries.
  // Fire-and-forget: alerts errors must not fail the sync.
  try {
    const alertCount = await generateAlerts(restaurantId);
    if (alertCount > 0) console.error(`[square] generated ${alertCount} new alert(s)`);
  } catch (err) {
    console.error('[square] alerts generation failed:', (err as Error).message);
  }

  return {
    ok: true,
    catalogCount: catalogRows.length,
    orderCount,
    fallbackUsedPayments,
  };
};
