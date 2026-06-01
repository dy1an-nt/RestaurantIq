/**
 * Normalizers map DoorDash API response shapes onto our internal schema —
 * the DoorDash counterpart to services/square/normalizers.ts.
 *
 * They emit the exact same row shapes (from services/ingestion/types) that the
 * Square normalizers do, differing only in `source: 'doordash'` and the field
 * mapping. This is what lets the shared persistence layer treat both channels
 * identically.
 *
 * Money is integer cents throughout, matching our convention and DoorDash's
 * smallest-currency-unit amounts.
 */
import {
  MenuItemRow,
  OrderItemRow,
  NormalizedOrder,
} from '../ingestion/types';
import {
  DoorDashCatalogItem,
  DoorDashOrder,
  DoorDashOrderLine,
} from './doordashClient';

const toCents = (amount: number | null | undefined): number => {
  if (amount === null || amount === undefined) return 0;
  return Number(amount);
};

/**
 * normalizeCatalogItem(doorDashItem) → menu_item row
 *
 * Cost is unknown to DoorDash — set to 0 and let the operator fill it in via UI
 * (same as Square), which is what unlocks margin analysis for the item.
 */
export const normalizeCatalogItem = (
  item: DoorDashCatalogItem,
  restaurantId: string,
): MenuItemRow | null => {
  if (!item?.id) return null;

  return {
    restaurant_id: restaurantId,
    name: item.name ?? 'Untitled',
    category: item.category ?? 'Uncategorized',
    price_cents: toCents(item.price),
    cost_cents: 0,
    source: 'doordash',
    external_id: item.id,
  };
};

/**
 * normalizeOrder(doorDashOrder) → { order, items[] }
 *
 * menu_item_id linkage is deferred to the persistence layer, which holds the
 * external_id → menu_items.id map after the catalog upsert.
 */
export const normalizeOrder = (
  order: DoorDashOrder,
  restaurantId: string,
): NormalizedOrder | null => {
  if (!order?.id) return null;

  const orderedAt = order.created_at ?? new Date().toISOString();

  const items: OrderItemRow[] = (order.items ?? []).map((line: DoorDashOrderLine) => ({
    menu_item_external_id: line.item_id ?? null,
    quantity: Number(line.quantity ?? 1),
    unit_price_cents: toCents(line.unit_price),
  }));

  // Prefer the order's stated total; fall back to summing the lines so a missing
  // total never silently zeroes out channel revenue.
  const lineTotal = items.reduce((sum, it) => sum + it.quantity * it.unit_price_cents, 0);
  const totalCents = order.total !== undefined ? toCents(order.total) : lineTotal;

  return {
    order: {
      restaurant_id: restaurantId,
      source: 'doordash',
      total_cents: totalCents,
      ordered_at: orderedAt,
      external_id: order.id,
    },
    items,
  };
};
