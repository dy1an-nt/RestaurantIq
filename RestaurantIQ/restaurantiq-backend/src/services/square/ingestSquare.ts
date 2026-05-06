import { supabase } from '../../db';
import { getSquareClient, isMockMode } from './squareClient';
import {
  normalizeCatalogItem,
  normalizeOrder,
  normalizePayment,
  MenuItemRow,
  OrderRow,
  OrderItemRow,
} from './normalizers';

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

  // Supabase upsert needs a unique constraint to merge on. The migration leaves
  // the (restaurant_id, source, external_id) index commented; until it's added
  // we do a read-then-insert-or-update loop. Cheap enough for MVP catalog sizes.
  for (const row of rows) {
    const { data: existing } = await supabase
      .from('menu_items')
      .select('id')
      .eq('restaurant_id', row.restaurant_id)
      .eq('source', row.source)
      .eq('name', row.name) // proxy match while external_id column isn't unique
      .maybeSingle();

    if (existing?.id) {
      await supabase.from('menu_items').update(row).eq('id', existing.id);
      if (row.external_id) map.set(row.external_id, existing.id);
    } else {
      const { data: inserted, error } = await supabase
        .from('menu_items')
        .insert(row)
        .select('id')
        .single();
      if (error) throw new Error(`menu_items insert failed: ${error.message}`);
      if (row.external_id && inserted) map.set(row.external_id, inserted.id);
    }
  }
  return map;
};

const upsertOrders = async (
  orders: { order: OrderRow; items: OrderItemRow[] }[],
  externalToInternalMenuItem: Map<string, string>,
): Promise<number> => {
  let count = 0;
  for (const { order, items } of orders) {
    // Skip if we've already ingested this Square order (best-effort dedupe by ordered_at + total).
    const { data: existing } = await supabase
      .from('orders')
      .select('id')
      .eq('restaurant_id', order.restaurant_id)
      .eq('ordered_at', order.ordered_at)
      .eq('total_cents', order.total_cents)
      .maybeSingle();

    let orderId = existing?.id;
    if (!orderId) {
      const { data: inserted, error } = await supabase
        .from('orders')
        .insert({
          restaurant_id: order.restaurant_id,
          source: order.source,
          total_cents: order.total_cents,
          ordered_at: order.ordered_at,
        })
        .select('id')
        .single();
      if (error) throw new Error(`orders insert failed: ${error.message}`);
      orderId = inserted!.id;
      count++;
    }

    if (items.length > 0) {
      const rows = items
        .map((it) => ({
          order_id: orderId,
          menu_item_id: it.menu_item_external_id
            ? externalToInternalMenuItem.get(it.menu_item_external_id) ?? null
            : null,
          quantity: it.quantity,
          unit_price_cents: it.unit_price_cents,
        }))
        .filter((r) => r.menu_item_id !== null);
      if (rows.length > 0) await supabase.from('order_items').insert(rows);
    }
  }
  return count;
};

/**
 * Recompute daily_summaries for the last 30 days from orders/order_items.
 * Naive but correct: delete + reinsert the window.
 */
const refreshDailySummaries = async (restaurantId: string): Promise<void> => {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceIso = since.toISOString();
  const sinceDate = sinceIso.split('T')[0];

  await supabase
    .from('daily_summaries')
    .delete()
    .eq('restaurant_id', restaurantId)
    .gte('date', sinceDate);

  const { data: orders } = await supabase
    .from('orders')
    .select('id, ordered_at, order_items ( menu_item_id, quantity, unit_price_cents )')
    .eq('restaurant_id', restaurantId)
    .gte('ordered_at', sinceIso);

  if (!orders || orders.length === 0) return;

  type Bucket = { qty: number; rev: number; orders: Set<string> };
  const buckets = new Map<string, Bucket>(); // key = `${date}|${menu_item_id}`

  for (const o of orders as any[]) {
    const date = (o.ordered_at as string).split('T')[0];
    for (const oi of o.order_items ?? []) {
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

  if (summaries.length > 0) await supabase.from('daily_summaries').insert(summaries);
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

  const client = getSquareClient({ accessToken: restaurant.square_access_token });
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

  return {
    ok: true,
    catalogCount: catalogRows.length,
    orderCount,
    fallbackUsedPayments,
  };
};
