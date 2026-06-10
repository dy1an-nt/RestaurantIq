/**
 * Unit tests for channelMarginService (Sprint Q).
 *
 * Only buildChannelMarginAnalysis is tested here — it is the pure transform
 * that contains all business logic. analyzeChannelMargins (the data-access
 * wrapper) is not tested because it has no logic beyond I/O; its correctness
 * is validated by integration tests in a live environment.
 *
 * Test coverage targets:
 *   1. Channel split  — orders routed correctly to in-house vs delivery
 *   2. Commission math — floor(gross × bps / 10000), integer only
 *   3. Flat-fee math   — total burden = flatFee × deliveryOrders, allocated
 *                        proportionally by gross share, floor() remainder dropped
 *   4. cost_cents === 0 exclusion  — item treated as cost-unknown
 *   5. cost_cents === null exclusion
 *   6. Empty data (no orders, no items)
 *   7. Item sold on only one channel (in-house only, delivery only)
 *   8. summary.biggest_margin_gap_item reflects widest gap
 */

import { buildChannelMarginAnalysis } from '../channelMarginService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const item = (overrides: {
  id?: string;
  name?: string;
  price_cents?: number;
  cost_cents?: number | null;
}) => ({
  id: overrides.id ?? 'item-1',
  name: overrides.name ?? 'Burger',
  price_cents: overrides.price_cents ?? 1000,
  cost_cents: overrides.cost_cents !== undefined ? overrides.cost_cents : 300,
});

const order = (id: string, source: string) => ({
  id,
  source,
  ordered_at: '2026-05-01T12:00:00Z',
});

const orderItem = (
  order_id: string,
  menu_item_id: string,
  quantity = 1,
  unit_price_cents = 1000,
) => ({ order_id, menu_item_id, quantity, unit_price_cents });

// ---------------------------------------------------------------------------
// 1. Channel split
// ---------------------------------------------------------------------------

describe('channel split', () => {
  it('assigns square, toast, and manual orders to in-house', () => {
    const items = [item({ id: 'i1' })];
    const orders = [
      order('o-sq', 'square'),
      order('o-to', 'toast'),
      order('o-ma', 'manual'),
    ];
    const ois = [
      orderItem('o-sq', 'i1', 1, 1000),
      orderItem('o-to', 'i1', 1, 1000),
      orderItem('o-ma', 'i1', 1, 1000),
    ];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);

    expect(result.summary.in_house.order_count).toBe(3);
    expect(result.summary.delivery.order_count).toBe(0);
    expect(result.items[0].in_house?.units).toBe(3);
    expect(result.items[0].delivery).toBeNull();
  });

  it('assigns doordash orders to delivery', () => {
    const items = [item({ id: 'i1' })];
    const orders = [order('o-dd', 'doordash')];
    const ois = [orderItem('o-dd', 'i1', 2, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);

    expect(result.summary.delivery.order_count).toBe(1);
    expect(result.summary.in_house.order_count).toBe(0);
    expect(result.items[0].delivery?.units).toBe(2);
    expect(result.items[0].in_house).toBeNull();
  });

  it('ignores orders with unknown sources', () => {
    const items = [item({ id: 'i1' })];
    const orders = [order('o-unk', 'grubhub')];
    const ois = [orderItem('o-unk', 'i1', 1, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);

    // grubhub order has no matching channel — item appears in no channel detail
    expect(result.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Commission math
// ---------------------------------------------------------------------------

describe('commission math', () => {
  it('applies floor(gross * bps / 10000) as commission', () => {
    // gross = 3 × 1000 = 3000 cents; 20% commission = floor(3000 * 2000 / 10000) = 600
    const items = [item({ id: 'i1', cost_cents: 300 })];
    const orders = [order('o1', 'doordash')];
    const ois = [orderItem('o1', 'i1', 3, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);
    const d = result.items[0].delivery!;

    expect(d.gross_cents).toBe(3000);
    expect(d.delivery_tax_cents).toBe(600);
    expect(d.food_cost_cents).toBe(900);  // 3 × 300
    expect(d.net_cents).toBe(3000 - 900 - 600); // 1500
  });

  it('uses floor for fractional commission (no rounding up)', () => {
    // gross = 1 cent; 15% commission = floor(1 * 1500 / 10000) = 0 (not 1)
    const items = [item({ id: 'i1', price_cents: 1, cost_cents: 0 })];
    // cost_cents=0 → missing cost. Use cost > 0.
    const items2 = [item({ id: 'i1', price_cents: 100, cost_cents: 1 })];
    const orders = [order('o1', 'doordash')];
    const ois = [orderItem('o1', 'i1', 1, 7)]; // gross = 7 cents

    // 1500 bps = 15%; floor(7 * 1500 / 10000) = floor(0.105) = 0... let's pick
    // a value that is fractional:  gross = 33 cents, 15% = 4.95 → floor = 4
    const ois2 = [orderItem('o1', 'i1', 1, 33)]; // gross = 33

    const result = buildChannelMarginAnalysis(items2, orders, ois2, 1500, 0);
    const d = result.items[0].delivery!;

    expect(d.delivery_tax_cents).toBe(4); // floor(33 * 1500 / 10000) = floor(4.95) = 4
  });

  it('applies 0% commission correctly', () => {
    const items = [item({ id: 'i1', cost_cents: 200 })];
    const orders = [order('o1', 'doordash')];
    const ois = [orderItem('o1', 'i1', 1, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 0, 0);
    const d = result.items[0].delivery!;

    expect(d.delivery_tax_cents).toBe(0);
    expect(d.net_cents).toBe(1000 - 200);
  });
});

// ---------------------------------------------------------------------------
// 3. Flat-fee allocation
// ---------------------------------------------------------------------------

describe('flat-fee allocation', () => {
  it('allocates flat fee proportionally by delivery gross share', () => {
    // Two items: gross 1000 and 3000; total gross = 4000.
    // 2 delivery orders × $1.00 flat fee = 200 cents total burden.
    // item A (1000/4000 = 25%) → floor(200 * 1000 / 4000) = 50
    // item B (3000/4000 = 75%) → floor(200 * 3000 / 4000) = 150
    const items = [
      item({ id: 'iA', cost_cents: 200 }),
      item({ id: 'iB', cost_cents: 200 }),
    ];
    const orders = [order('o1', 'doordash'), order('o2', 'doordash')];
    const ois = [
      orderItem('o1', 'iA', 1, 1000),
      orderItem('o2', 'iB', 1, 3000),
    ];

    const result = buildChannelMarginAnalysis(items, orders, ois, 0, 100); // 100 cents flat fee

    const iA = result.items.find((i) => i.id === 'iA')!;
    const iB = result.items.find((i) => i.id === 'iB')!;

    expect(iA.delivery!.delivery_tax_cents).toBe(50);
    expect(iB.delivery!.delivery_tax_cents).toBe(150);
  });

  it('drops the floor() remainder without assigning it to any item', () => {
    // 3 items with gross 1, 1, 1 (total 3). 1 order × 100 cents flat fee.
    // Each item share = floor(100 * 1 / 3) = 33. Total assigned = 99 (1 cent remainder dropped).
    const items = [
      item({ id: 'i1', cost_cents: 1 }),
      item({ id: 'i2', cost_cents: 1 }),
      item({ id: 'i3', cost_cents: 1 }),
    ];
    const orders = [order('o1', 'doordash')];
    const ois = [
      orderItem('o1', 'i1', 1, 1),
      orderItem('o1', 'i2', 1, 1),
      orderItem('o1', 'i3', 1, 1),
    ];

    const result = buildChannelMarginAnalysis(items, orders, ois, 0, 100);

    const taxes = result.items.map((i) => i.delivery!.delivery_tax_cents);
    expect(taxes).toEqual([33, 33, 33]); // 99 total, 1 cent remainder dropped
    // summary reflects actual allocated tax (99), not theoretical (100)
    expect(result.summary.delivery.delivery_tax_cents).toBe(99);
  });

  it('allocates 0 flat fee when there are no delivery orders', () => {
    const items = [item({ id: 'i1', cost_cents: 300 })];
    const orders = [order('o1', 'square')];
    const ois = [orderItem('o1', 'i1', 1, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 500);

    // No delivery items → delivery channel has nothing; summary tax = 0
    expect(result.summary.delivery.delivery_tax_cents).toBe(0);
    expect(result.summary.delivery.order_count).toBe(0);
  });

  it('combines commission and flat fee in delivery_tax_cents', () => {
    // gross = 1000; 20% commission = 200; 1 order × 50 cent flat fee allocated fully
    const items = [item({ id: 'i1', cost_cents: 200 })];
    const orders = [order('o1', 'doordash')];
    const ois = [orderItem('o1', 'i1', 1, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 50);
    const d = result.items[0].delivery!;

    expect(d.delivery_tax_cents).toBe(200 + 50); // 250
    expect(d.net_cents).toBe(1000 - 200 - 250);  // 550
  });
});

// ---------------------------------------------------------------------------
// 4 & 5. cost_cents === 0 or null exclusion
// ---------------------------------------------------------------------------

describe('cost_cents 0 / null exclusion', () => {
  it('excludes items with cost_cents === 0 from margin items', () => {
    const items = [item({ id: 'i1', cost_cents: 0 })];
    const orders = [order('o1', 'doordash')];
    const ois = [orderItem('o1', 'i1', 1, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);

    expect(result.items).toHaveLength(0);
    expect(result.missingCostItems).toHaveLength(1);
    expect(result.missingCostItems[0].id).toBe('i1');
  });

  it('excludes items with cost_cents === null from margin items', () => {
    const items = [item({ id: 'i1', cost_cents: null })];
    const orders = [order('o1', 'square')];
    const ois = [orderItem('o1', 'i1', 1, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);

    expect(result.items).toHaveLength(0);
    expect(result.missingCostItems).toHaveLength(1);
  });

  it('keeps items with cost_cents > 0 in margin items', () => {
    const items = [item({ id: 'i1', cost_cents: 100 })];
    const orders = [order('o1', 'square')];
    const ois = [orderItem('o1', 'i1', 1, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);

    expect(result.items).toHaveLength(1);
    expect(result.missingCostItems).toHaveLength(0);
  });

  it('places missing-cost items in missingCostItems with id, name, price_cents', () => {
    const items = [
      item({ id: 'i1', name: 'Zero-cost', price_cents: 500, cost_cents: 0 }),
      item({ id: 'i2', name: 'Known-cost', price_cents: 800, cost_cents: 200 }),
    ];
    const orders = [order('o1', 'square')];
    const ois = [
      orderItem('o1', 'i1', 1, 500),
      orderItem('o1', 'i2', 1, 800),
    ];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);

    expect(result.missingCostItems).toHaveLength(1);
    expect(result.missingCostItems[0]).toEqual({ id: 'i1', name: 'Zero-cost', price_cents: 500 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('i2');
  });
});

// ---------------------------------------------------------------------------
// 6. Empty data
// ---------------------------------------------------------------------------

describe('empty data', () => {
  it('returns zeroed summaries and empty arrays when there are no items', () => {
    const result = buildChannelMarginAnalysis([], [], [], 2000, 0);

    expect(result.items).toHaveLength(0);
    expect(result.missingCostItems).toHaveLength(0);
    expect(result.summary.in_house.gross_cents).toBe(0);
    expect(result.summary.delivery.gross_cents).toBe(0);
    expect(result.summary.biggest_margin_gap_item).toBeNull();
  });

  it('returns zeroed summaries when items exist but no orders', () => {
    const items = [item({ id: 'i1', cost_cents: 300 })];
    const result = buildChannelMarginAnalysis(items, [], [], 2000, 0);

    expect(result.items).toHaveLength(0); // item had no sales
    expect(result.summary.in_house.order_count).toBe(0);
    expect(result.summary.delivery.order_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Item sold on only one channel
// ---------------------------------------------------------------------------

describe('item sold on only one channel', () => {
  it('sets in_house when item has no delivery sales', () => {
    const items = [item({ id: 'i1', cost_cents: 200 })];
    const orders = [order('o1', 'square')];
    const ois = [orderItem('o1', 'i1', 2, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);

    const row = result.items[0];
    expect(row.in_house).not.toBeNull();
    expect(row.delivery).toBeNull();
    expect(row.margin_gap_percent).toBeNull(); // only one channel → no gap
  });

  it('sets delivery when item has no in-house sales', () => {
    const items = [item({ id: 'i1', cost_cents: 200 })];
    const orders = [order('o1', 'doordash')];
    const ois = [orderItem('o1', 'i1', 1, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);

    const row = result.items[0];
    expect(row.delivery).not.toBeNull();
    expect(row.in_house).toBeNull();
    expect(row.margin_gap_percent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. summary.biggest_margin_gap_item
// ---------------------------------------------------------------------------

describe('biggest_margin_gap_item', () => {
  it('identifies the item with the largest in-house vs delivery margin gap', () => {
    // Item A (cost=500): sold in-house at 1000, delivery at 600.
    //   in-house:  gross=1000, food=500, net=500              → margin=50%
    //   delivery:  gross=600,  food=500, commission=floor(600*2000/10000)=120
    //              net=600-500-120=-20                        → margin=round(-20/600*10000)/100=-3.33%
    //   gap = 50 − (−3.33) = 53.33%  ← biggest
    //
    // Item B (cost=200): sold in-house and delivery at 1000.
    //   in-house:  gross=1000, food=200, net=800              → margin=80%
    //   delivery:  gross=1000, food=200, commission=200, net=600 → margin=60%
    //   gap = 80 − 60 = 20%
    const items = [
      item({ id: 'iA', name: 'A', cost_cents: 500 }),
      item({ id: 'iB', name: 'B', cost_cents: 200 }),
    ];
    const orders = [
      order('o-ih-a', 'square'),
      order('o-ih-b', 'square'),
      order('o-dl-a', 'doordash'),
      order('o-dl-b', 'doordash'),
    ];
    const ois = [
      orderItem('o-ih-a', 'iA', 1, 1000),
      orderItem('o-ih-b', 'iB', 1, 1000),
      orderItem('o-dl-a', 'iA', 1, 600),  // delivery at discounted price
      orderItem('o-dl-b', 'iB', 1, 1000),
    ];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0); // 20% commission

    const iA = result.items.find((i) => i.id === 'iA')!;
    const iB = result.items.find((i) => i.id === 'iB')!;

    expect(iA.in_house!.margin_percent).toBe(50);
    expect(iA.delivery!.delivery_tax_cents).toBe(120);
    expect(iA.delivery!.net_cents).toBe(-20);
    expect(iA.delivery!.margin_percent).toBe(-3.33);
    expect(iA.margin_gap_percent).toBe(53.33);

    expect(iB.margin_gap_percent).toBe(20);

    expect(result.summary.biggest_margin_gap_item?.id).toBe('iA');
    expect(result.summary.biggest_margin_gap_item?.margin_gap_percent).toBe(53.33);
  });

  it('returns null when no item has sales on both channels', () => {
    const items = [item({ id: 'i1', cost_cents: 200 })];
    const orders = [order('o1', 'square')];
    const ois = [orderItem('o1', 'i1', 1, 1000)];

    const result = buildChannelMarginAnalysis(items, orders, ois, 2000, 0);

    expect(result.summary.biggest_margin_gap_item).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. settings passthrough
// ---------------------------------------------------------------------------

describe('settings passthrough', () => {
  it('echoes commission and flat fee settings in the result', () => {
    const result = buildChannelMarginAnalysis([], [], [], 3000, 150);

    expect(result.settings.doordash_commission_bps).toBe(3000);
    expect(result.settings.doordash_flat_fee_cents).toBe(150);
  });
});
