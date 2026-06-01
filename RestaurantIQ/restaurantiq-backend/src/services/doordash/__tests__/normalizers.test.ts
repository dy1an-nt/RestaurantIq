/**
 * Tests for the DoorDash normalizers — the mapping from raw DoorDash API shapes
 * onto the shared internal row shapes (services/ingestion/types).
 *
 * Sprint K goal #1 (test parity with Square) + goal #3 (lock down the tolerant
 * parsing assumptions). Each assertion pins one mapping rule so a future change
 * to a guessed field name or fallback fails loudly here instead of silently
 * zeroing revenue or breaking order-item linkage.
 */
import { normalizeCatalogItem, normalizeOrder } from '../normalizers';
import { DoorDashCatalogItem, DoorDashOrder } from '../doordashClient';

const REST = 'rest-1';

describe('normalizeCatalogItem', () => {
  it('maps a full catalog item onto a menu_items row tagged source=doordash', () => {
    const item: DoorDashCatalogItem = {
      id: 'dd-burger',
      name: 'Smash Burger',
      category: 'Mains',
      price: 1295,
    };
    expect(normalizeCatalogItem(item, REST)).toEqual({
      restaurant_id: REST,
      name: 'Smash Burger',
      category: 'Mains',
      price_cents: 1295,
      cost_cents: 0, // DoorDash never supplies cost — operator fills it in later
      source: 'doordash',
      external_id: 'dd-burger',
    });
  });

  it('returns null when the item has no id (cannot be linked or deduped)', () => {
    expect(normalizeCatalogItem({ id: '' } as DoorDashCatalogItem, REST)).toBeNull();
    expect(normalizeCatalogItem(undefined as any, REST)).toBeNull();
  });

  it('defaults a missing name and category', () => {
    const row = normalizeCatalogItem({ id: 'x' } as DoorDashCatalogItem, REST);
    expect(row).toMatchObject({ name: 'Untitled', category: 'Uncategorized' });
  });

  it('coerces a missing price to 0 cents', () => {
    const row = normalizeCatalogItem({ id: 'x', name: 'Water' } as DoorDashCatalogItem, REST);
    expect(row!.price_cents).toBe(0);
  });
});

describe('normalizeOrder', () => {
  const baseOrder: DoorDashOrder = {
    id: 'dd-order-1',
    total: 3285,
    created_at: '2026-05-20T12:30:00.000Z',
    items: [
      { item_id: 'dd-burger', quantity: 2, unit_price: 1295 },
      { item_id: 'dd-fries', quantity: 1, unit_price: 695 },
    ],
  };

  it('maps a full order onto { order, items } tagged source=doordash', () => {
    const result = normalizeOrder(baseOrder, REST);
    expect(result!.order).toEqual({
      restaurant_id: REST,
      source: 'doordash',
      total_cents: 3285,
      ordered_at: '2026-05-20T12:30:00.000Z',
      external_id: 'dd-order-1',
    });
    expect(result!.items).toEqual([
      { menu_item_external_id: 'dd-burger', quantity: 2, unit_price_cents: 1295 },
      { menu_item_external_id: 'dd-fries', quantity: 1, unit_price_cents: 695 },
    ]);
  });

  it('returns null when the order has no id', () => {
    expect(normalizeOrder({ id: '' } as DoorDashOrder, REST)).toBeNull();
    expect(normalizeOrder(undefined as any, REST)).toBeNull();
  });

  it('falls back to summing line items when total is absent (never zeroes revenue)', () => {
    const { total, ...noTotal } = baseOrder;
    const result = normalizeOrder(noTotal as DoorDashOrder, REST);
    expect(result!.order.total_cents).toBe(2 * 1295 + 695);
  });

  it('prefers the stated total even when it differs from the line sum', () => {
    // e.g. order-level discount/fee — DoorDash's total is authoritative.
    const discounted = { ...baseOrder, total: 3000 };
    expect(normalizeOrder(discounted, REST)!.order.total_cents).toBe(3000);
  });

  it('defaults a missing ordered_at to a valid ISO timestamp', () => {
    const { created_at, ...noTs } = baseOrder;
    const result = normalizeOrder(noTs as DoorDashOrder, REST);
    expect(() => new Date(result!.order.ordered_at).toISOString()).not.toThrow();
    expect(Number.isNaN(Date.parse(result!.order.ordered_at))).toBe(false);
  });

  it('handles an order with no items array', () => {
    const result = normalizeOrder({ id: 'dd-empty', total: 0 } as DoorDashOrder, REST);
    expect(result!.items).toEqual([]);
    expect(result!.order.total_cents).toBe(0);
  });

  it('defaults a missing line quantity to 1 and a missing unit_price to 0', () => {
    const result = normalizeOrder(
      { id: 'dd-2', items: [{ item_id: 'x' } as any] } as DoorDashOrder,
      REST,
    );
    expect(result!.items[0]).toEqual({
      menu_item_external_id: 'x',
      quantity: 1,
      unit_price_cents: 0,
    });
  });

  it('preserves a null menu_item_external_id when a line has no item_id', () => {
    const result = normalizeOrder(
      { id: 'dd-3', total: 100, items: [{ quantity: 1, unit_price: 100 } as any] } as DoorDashOrder,
      REST,
    );
    expect(result!.items[0].menu_item_external_id).toBeNull();
  });
});
