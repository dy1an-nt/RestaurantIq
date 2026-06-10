import { supabase } from '../db';

// ---------------------------------------------------------------------------
// Channel Margin Service
//
// Owns all cross-channel margin math for GET /api/analytics/channel-margins.
// Given a restaurant's DoorDash commission settings, it splits the last-30-day
// order history by channel (in-house vs delivery), computes per-item gross
// revenue, food cost, and — for delivery — the platform "delivery tax" that
// the commission and flat fee consume before the operator sees the money.
//
// Routes stay thin: auth, restaurant lookup (including commission columns),
// call analyzeChannelMargins(), return the result. All monetary values are
// integer cents; no float arithmetic crosses a boundary.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Row types (internal to this service — not exported)
// ---------------------------------------------------------------------------

interface MenuItemRow {
  id: string;
  name: string;
  price_cents: number;
  cost_cents: number | null;
}

interface OrderRow {
  id: string;
  source: string;
  ordered_at: string;
}

interface OrderItemRow {
  order_id: string;
  menu_item_id: string | null;
  quantity: number;
  unit_price_cents: number;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/**
 * Per-channel sales breakdown for a single menu item.
 * Either channel may be null when the item had no sales on that channel in
 * the 30-day window.
 */
export interface ChannelItemDetail {
  units: number;
  gross_cents: number;
  food_cost_cents: number;
  net_cents: number;
  margin_percent: number;
}

export interface DeliveryItemDetail extends ChannelItemDetail {
  /** Delivery-tax burden allocated to this item (commission + flat fee share). */
  delivery_tax_cents: number;
}

export interface ChannelMarginItem {
  id: string;
  name: string;
  price_cents: number;
  /** null when the item had no in-house sales in the window. */
  in_house: ChannelItemDetail | null;
  /** null when the item had no delivery sales in the window. */
  delivery: DeliveryItemDetail | null;
  /**
   * Absolute margin gap: in_house.margin_percent − delivery.margin_percent.
   * null when sales on only one channel exist (no meaningful comparison).
   */
  margin_gap_percent: number | null;
}

/** Items whose cost_cents is 0 or null — excluded from margin math. */
export interface MissingCostItem {
  id: string;
  name: string;
  price_cents: number;
}

export interface ChannelSummary {
  /** Total gross revenue across all cost-known items. */
  gross_cents: number;
  /** Total net revenue (gross minus food cost, minus delivery tax for delivery). */
  net_cents: number;
  /** Delivery-tax paid (0 for in-house channel). */
  delivery_tax_cents: number;
  /** Number of orders on this channel in the 30-day window. */
  order_count: number;
}

export interface ChannelMarginSummary {
  in_house: ChannelSummary;
  delivery: ChannelSummary;
  /**
   * The item with the largest absolute margin gap between channels, i.e. the
   * item whose delivery margin is furthest below its in-house margin. null
   * when no item has sales on both channels.
   */
  biggest_margin_gap_item: { id: string; name: string; margin_gap_percent: number } | null;
}

export interface DeliveryEconomicsSettings {
  /** Commission rate used for this computation, in basis points (e.g. 2000 = 20%). */
  doordash_commission_bps: number;
  /** Per-order flat fee used for this computation, in integer cents. */
  doordash_flat_fee_cents: number;
}

export interface ChannelMarginResult {
  summary: ChannelMarginSummary;
  items: ChannelMarginItem[];
  settings: DeliveryEconomicsSettings;
  missingCostItems: MissingCostItem[];
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown for upstream (Supabase) failures so the route can map to a stable 500
 * with a client-safe message instead of leaking internals.
 */
export class ChannelMarginError extends Error {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Chunk an array into slices of at most `size` elements. Used to keep
 * PostgREST `.in()` calls within a safe URL-length budget when the order id
 * list is large. PostgREST encodes every id into the query string; UUIDs are
 * 36 chars each, so 500 per batch stays well under the 8 KB URL limit.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

const IN_CHUNK_SIZE = 500;

// Channels that represent in-house (POS) orders.
const IN_HOUSE_SOURCES = new Set(['square', 'toast', 'manual']);
const DELIVERY_SOURCE = 'doordash';

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/**
 * Fetches menu items, last-30-day orders, and order items for the restaurant,
 * then delegates all math to buildChannelMarginAnalysis.
 *
 * order_items has no restaurant_id column; tenant safety is achieved by
 * fetching orders scoped to the restaurant first, then fetching order_items
 * only for those order ids — cross-tenant row access is impossible because a
 * tenant's order ids are never visible to another tenant's request.
 *
 * @throws {ChannelMarginError} when any upstream Supabase query fails.
 */
export async function analyzeChannelMargins(
  restaurantId: string,
  commissionBps: number,
  flatFeeCents: number,
): Promise<ChannelMarginResult> {
  // 1. Menu items
  const { data: menuItems, error: mErr } = await supabase
    .from('menu_items')
    .select('id, name, price_cents, cost_cents')
    .eq('restaurant_id', restaurantId);

  if (mErr) throw new ChannelMarginError('Failed to fetch menu items');

  // 2. Last-30-day orders (id + source + ordered_at only — no PII, no totals)
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: orders, error: oErr } = await supabase
    .from('orders')
    .select('id, source, ordered_at')
    .eq('restaurant_id', restaurantId)
    .gte('ordered_at', since.toISOString());

  if (oErr) throw new ChannelMarginError('Failed to fetch orders');

  const orderRows = (orders ?? []) as OrderRow[];

  // 3. Order items — fetched in chunks so we never blow PostgREST's URL limit.
  //    Tenant safety: we only pass order ids that came from the restaurant's
  //    own orders query above.
  const orderIds = orderRows.map((o) => o.id);
  const allOrderItems: OrderItemRow[] = [];

  if (orderIds.length > 0) {
    for (const idBatch of chunk(orderIds, IN_CHUNK_SIZE)) {
      const { data: items, error: iErr } = await supabase
        .from('order_items')
        .select('order_id, menu_item_id, quantity, unit_price_cents')
        .in('order_id', idBatch);

      if (iErr) throw new ChannelMarginError('Failed to fetch order items');
      allOrderItems.push(...((items ?? []) as OrderItemRow[]));
    }
  }

  return buildChannelMarginAnalysis(
    (menuItems ?? []) as MenuItemRow[],
    orderRows,
    allOrderItems,
    commissionBps,
    flatFeeCents,
  );
}

// ---------------------------------------------------------------------------
// Pure transform (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Pure transform: given menu items, orders, order items, and commission
 * settings, produces the full cross-channel margin analysis. Kept separate
 * from data access so the math is trivial to unit-test without a DB.
 *
 * Cost rule
 * ---------
 * DoorDash-ingested catalog items have cost_cents = 0 (no cost data from the
 * delivery platform). Treating a $0 cost as real would make every such item
 * appear to have 100% margin — a misleading signal. Items with cost_cents
 * equal to 0 OR null are treated as cost-unknown: excluded from margin items
 * and returned in missingCostItems. Only items with cost_cents > 0 are
 * included in per-channel breakdowns.
 *
 * Flat-fee allocation
 * -------------------
 * The total flat-fee burden is:  doordash_flat_fee_cents × delivery_order_count
 * This is allocated to cost-known delivery items proportionally by their share
 * of total delivery gross revenue. Allocation uses integer floor() division;
 * the remainder (at most N−1 cents for N items) is intentionally dropped
 * rather than assigned to an arbitrary item, keeping the math deterministic
 * and reproducible. The summary's delivery_tax_cents reflects actual allocated
 * tax (commission + allocated flat fees), not the theoretical total.
 *
 * Margin percent
 * --------------
 * Rounded to 2 decimal places. Negative values are valid (item sold below cost).
 */
export function buildChannelMarginAnalysis(
  menuItems: MenuItemRow[],
  orders: OrderRow[],
  orderItems: OrderItemRow[],
  commissionBps: number,
  flatFeeCents: number,
): ChannelMarginResult {
  // ── Split orders by channel ──────────────────────────────────────────────
  const deliveryOrderIds = new Set<string>();
  const inHouseOrderIds = new Set<string>();

  for (const o of orders) {
    if (o.source === DELIVERY_SOURCE) {
      deliveryOrderIds.add(o.id);
    } else if (IN_HOUSE_SOURCES.has(o.source)) {
      inHouseOrderIds.add(o.id);
    }
    // Unknown sources are silently ignored — they don't appear in either channel.
  }

  const deliveryOrderCount = deliveryOrderIds.size;
  const inHouseOrderCount = inHouseOrderIds.size;

  // ── Separate cost-known from unknown items ───────────────────────────────
  // cost_cents === 0 or null → cost-unknown → excluded from margin math.
  const missingCostItems: MissingCostItem[] = [];
  const knownCostItems: MenuItemRow[] = [];
  const missingCostIds = new Set<string>();

  for (const item of menuItems) {
    if (item.cost_cents == null || item.cost_cents === 0) {
      missingCostItems.push({ id: item.id, name: item.name, price_cents: item.price_cents });
      missingCostIds.add(item.id);
    } else {
      knownCostItems.push(item);
    }
  }

  // ── Aggregate order_items by (menu_item_id, channel) ────────────────────
  //    Accumulate: units sold, gross revenue (quantity × unit_price_cents),
  //    food cost (quantity × cost_cents from the menu_items row).
  const menuItemMap = new Map<string, MenuItemRow>();
  for (const item of knownCostItems) menuItemMap.set(item.id, item);

  interface ChannelAgg {
    units: number;
    gross_cents: number;
    food_cost_cents: number;
  }

  const inHouseAgg = new Map<string, ChannelAgg>();
  const deliveryAgg = new Map<string, ChannelAgg>();

  for (const oi of orderItems) {
    if (!oi.menu_item_id) continue;
    // Skip items whose cost is unknown — they never appear in channel breakdowns.
    if (missingCostIds.has(oi.menu_item_id)) continue;

    const menuItem = menuItemMap.get(oi.menu_item_id);
    if (!menuItem) continue; // item belongs to another restaurant (should never happen)

    const isDelivery = deliveryOrderIds.has(oi.order_id);
    const isInHouse = inHouseOrderIds.has(oi.order_id);
    if (!isDelivery && !isInHouse) continue; // order source unknown — skip

    const agg = isDelivery ? deliveryAgg : inHouseAgg;
    const cur = agg.get(oi.menu_item_id) ?? { units: 0, gross_cents: 0, food_cost_cents: 0 };
    cur.units += oi.quantity;
    cur.gross_cents += oi.quantity * oi.unit_price_cents;
    // cost_cents is guaranteed > 0 here (checked above)
    cur.food_cost_cents += oi.quantity * (menuItem.cost_cents as number);
    agg.set(oi.menu_item_id, cur);
  }

  // ── Flat-fee proportional allocation ────────────────────────────────────
  //    Total flat-fee burden = flatFeeCents × deliveryOrderCount.
  //    Allocate to each delivery item proportional to its gross share.
  //    Use floor() — remainder is dropped (documented above).
  const totalFlatFeeBurden = flatFeeCents * deliveryOrderCount;
  const totalDeliveryGross = Array.from(deliveryAgg.values()).reduce(
    (sum, a) => sum + a.gross_cents,
    0,
  );

  /**
   * Returns the flat-fee cents allocated to a single item given its delivery
   * gross revenue. Returns 0 when totalDeliveryGross is 0 (no delivery sales).
   */
  function allocateFlatFee(itemDeliveryGross: number): number {
    if (totalDeliveryGross === 0) return 0;
    return Math.floor((totalFlatFeeBurden * itemDeliveryGross) / totalDeliveryGross);
  }

  // ── Build per-item result rows ───────────────────────────────────────────
  const items: ChannelMarginItem[] = [];

  for (const item of knownCostItems) {
    const ihAgg = inHouseAgg.get(item.id) ?? null;
    const dlAgg = deliveryAgg.get(item.id) ?? null;

    // Item had no sales on either channel in the window — omit entirely.
    if (!ihAgg && !dlAgg) continue;

    let inHouseDetail: ChannelItemDetail | null = null;
    if (ihAgg) {
      const net_cents = ihAgg.gross_cents - ihAgg.food_cost_cents;
      const margin_percent =
        ihAgg.gross_cents > 0
          ? Math.round((net_cents / ihAgg.gross_cents) * 10000) / 100
          : 0;
      inHouseDetail = {
        units: ihAgg.units,
        gross_cents: ihAgg.gross_cents,
        food_cost_cents: ihAgg.food_cost_cents,
        net_cents,
        margin_percent,
      };
    }

    let deliveryDetail: DeliveryItemDetail | null = null;
    if (dlAgg) {
      const commissionCents = Math.floor((dlAgg.gross_cents * commissionBps) / 10000);
      const allocatedFlatFee = allocateFlatFee(dlAgg.gross_cents);
      const delivery_tax_cents = commissionCents + allocatedFlatFee;
      const net_cents = dlAgg.gross_cents - dlAgg.food_cost_cents - delivery_tax_cents;
      const margin_percent =
        dlAgg.gross_cents > 0
          ? Math.round((net_cents / dlAgg.gross_cents) * 10000) / 100
          : 0;
      deliveryDetail = {
        units: dlAgg.units,
        gross_cents: dlAgg.gross_cents,
        food_cost_cents: dlAgg.food_cost_cents,
        net_cents,
        margin_percent,
        delivery_tax_cents,
      };
    }

    const margin_gap_percent =
      inHouseDetail !== null && deliveryDetail !== null
        ? Math.round((inHouseDetail.margin_percent - deliveryDetail.margin_percent) * 100) / 100
        : null;

    items.push({
      id: item.id,
      name: item.name,
      price_cents: item.price_cents,
      in_house: inHouseDetail,
      delivery: deliveryDetail,
      margin_gap_percent,
    });
  }

  // ── Biggest margin-gap item ──────────────────────────────────────────────
  //    Among items with sales on both channels, find the one whose in-house
  //    margin most exceeds its delivery margin (largest positive gap).
  let biggest_margin_gap_item: ChannelMarginSummary['biggest_margin_gap_item'] = null;
  for (const item of items) {
    if (item.margin_gap_percent === null) continue;
    if (
      biggest_margin_gap_item === null ||
      item.margin_gap_percent > biggest_margin_gap_item.margin_gap_percent
    ) {
      biggest_margin_gap_item = {
        id: item.id,
        name: item.name,
        margin_gap_percent: item.margin_gap_percent,
      };
    }
  }

  // ── Channel-level summary totals ─────────────────────────────────────────
  const inHouseSummary: ChannelSummary = { gross_cents: 0, net_cents: 0, delivery_tax_cents: 0, order_count: inHouseOrderCount };
  const deliverySummary: ChannelSummary = { gross_cents: 0, net_cents: 0, delivery_tax_cents: 0, order_count: deliveryOrderCount };

  for (const item of items) {
    if (item.in_house) {
      inHouseSummary.gross_cents += item.in_house.gross_cents;
      inHouseSummary.net_cents += item.in_house.net_cents;
    }
    if (item.delivery) {
      deliverySummary.gross_cents += item.delivery.gross_cents;
      deliverySummary.net_cents += item.delivery.net_cents;
      deliverySummary.delivery_tax_cents += item.delivery.delivery_tax_cents;
    }
  }

  return {
    summary: {
      in_house: inHouseSummary,
      delivery: deliverySummary,
      biggest_margin_gap_item,
    },
    items,
    settings: {
      doordash_commission_bps: commissionBps,
      doordash_flat_fee_cents: flatFeeCents,
    },
    missingCostItems,
  };
}
