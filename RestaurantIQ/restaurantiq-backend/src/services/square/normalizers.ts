/**
 * Normalizers map Square API response shapes onto our internal schema.
 *
 * All money is integer cents — Square returns BigInt amounts in the smallest
 * currency unit, which already matches our convention. We coerce to Number
 * because Postgres `integer` columns can't hold BigInt directly via the JS
 * driver, and our amounts comfortably fit in a 32-bit signed int.
 *
 * IDs from Square are preserved on the row (when columns exist) so subsequent
 * syncs can upsert idempotently.
 */

import { MenuItemRow, OrderRow, OrderItemRow, NormalizedOrder } from '../ingestion/types';

// Re-export the shared row shapes so existing importers of this module keep working.
export { MenuItemRow, OrderRow, OrderItemRow };

type SquareCatalogObject = any;
type SquareOrder = any;
type SquareOrderLineItem = any;
type SquarePayment = any;

const toCents = (amount: bigint | number | null | undefined): number => {
  if (amount === null || amount === undefined) return 0;
  return typeof amount === 'bigint' ? Number(amount) : Number(amount);
};

/**
 * normalizeCatalogItem(squareItem) → menu_item row
 *
 * Square catalog items can have multiple variations; each has its own price.
 * For the MVP we collapse to the first variation as the "default" price.
 * Cost is unknown to Square — set to 0 and let the operator fill it in via UI.
 */
export const normalizeCatalogItem = (
  squareItem: SquareCatalogObject,
  restaurantId: string,
): MenuItemRow | null => {
  if (!squareItem || squareItem.type !== 'ITEM' || !squareItem.itemData) return null;
  const itemData = squareItem.itemData;

  const firstVariation = itemData.variations?.[0];
  const variationData = firstVariation?.itemVariationData;
  const priceCents = toCents(variationData?.priceMoney?.amount);

  // Store the VARIATION id, not the item id. Square order line items
  // reference variations via line.catalogObjectId, so this is what
  // upsertOrders matches against to set menu_item_id on order_items.
  // Falls back to the item id if the catalog has no variations (rare).
  const externalId = firstVariation?.id ?? squareItem.id;

  return {
    restaurant_id: restaurantId,
    name: itemData.name ?? 'Untitled',
    category: itemData.categories?.[0]?.name ?? itemData.category?.name ?? 'Uncategorized',
    price_cents: priceCents,
    cost_cents: 0,
    source: 'square',
    external_id: externalId,
  };
};

/**
 * normalizeOrder(squareOrder) → { order, items[] }
 *
 * Square Orders API returns line items inline. We split into one `orders` row
 * plus N `order_items` rows. menu_item_id linkage is deferred to the ingest
 * service which has the `external_id` → `menu_items.id` map after catalog sync.
 */
export const normalizeOrder = (
  squareOrder: SquareOrder,
  restaurantId: string,
): NormalizedOrder | null => {
  if (!squareOrder?.id) return null;

  const totalCents = toCents(squareOrder.totalMoney?.amount);
  const orderedAt =
    squareOrder.closedAt ?? squareOrder.createdAt ?? new Date().toISOString();

  const items: OrderItemRow[] = (squareOrder.lineItems ?? []).map(
    (line: SquareOrderLineItem) => ({
      menu_item_external_id: line.catalogObjectId ?? null,
      quantity: Number(line.quantity ?? 1),
      unit_price_cents: toCents(line.basePriceMoney?.amount),
    }),
  );

  return {
    order: {
      restaurant_id: restaurantId,
      source: 'square',
      total_cents: totalCents,
      ordered_at: orderedAt,
      external_id: squareOrder.id,
    },
    items,
  };
};

/**
 * normalizePayment(squarePayment) → order row
 *
 * Fallback for sellers that have Payments but not Orders (older Square accounts).
 * Produces an order with no line items — daily totals will still be accurate,
 * but per-item analytics will be missing for this row.
 */
export const normalizePayment = (
  squarePayment: SquarePayment,
  restaurantId: string,
): OrderRow | null => {
  if (!squarePayment?.id) return null;

  return {
    restaurant_id: restaurantId,
    source: 'square',
    total_cents: toCents(squarePayment.amountMoney?.amount),
    ordered_at: squarePayment.createdAt ?? new Date().toISOString(),
    external_id: squarePayment.id,
  };
};
