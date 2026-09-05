/**
 * Direct tests for the shared ingestion persistence layer.
 *
 * Sprint K goal #2: this layer now backs MULTIPLE revenue channels, so it must
 * be tested in isolation — not only indirectly through Square. These tests drive
 * the real persistence functions against an in-memory Supabase fake (see
 * ./fakeSupabase) that models upsert-conflict + insert-dedup with Postgres-like
 * semantics. That makes the dedup / idempotency assertions meaningful rather than
 * a mock rubber-stamp.
 *
 * Covered: order dedup, restaurant + order-item linkage, summary aggregation,
 * summary updates, cross-source isolation, idempotent writes, alert isolation.
 */
jest.mock('../../../db', () => {
  const { createFakeSupabase: make } = require('./fakeSupabase');
  return { supabase: make() };
});

const generateAlertsMock = jest.fn();
jest.mock('../../alertsService', () => ({
  generateAlerts: (...args: any[]) => generateAlertsMock(...args),
}));

import { supabase } from '../../../db';
import {
  upsertCatalog,
  upsertOrders,
  refreshDailySummaries,
  runAlerts,
} from '../persistence';
import { MenuItemRow, NormalizedOrder, OrderSource } from '../types';

const db = supabase as any;
const REST = 'rest-1';

const menuRow = (over: Partial<MenuItemRow> = {}): MenuItemRow => ({
  restaurant_id: REST,
  name: 'Item',
  category: 'Mains',
  price_cents: 1000,
  cost_cents: 0,
  source: 'doordash',
  external_id: 'ext-1',
  ...over,
});

const order = (
  externalId: string,
  lines: Array<[string, number, number]>, // [menu_item_external_id, qty, unit_price]
  over: Partial<NormalizedOrder['order']> = {},
): NormalizedOrder => ({
  order: {
    restaurant_id: REST,
    source: 'doordash',
    total_cents: lines.reduce((s, [, q, p]) => s + q * p, 0),
    ordered_at: '2026-05-20T12:00:00.000Z',
    external_id: externalId,
    ...over,
  },
  items: lines.map(([extId, quantity, unit_price_cents]) => ({
    menu_item_external_id: extId,
    quantity,
    unit_price_cents,
  })),
});

beforeEach(() => {
  db.__reset();
  generateAlertsMock.mockReset();
  generateAlertsMock.mockResolvedValue(0);
});

describe('upsertCatalog', () => {
  it('inserts catalog rows and returns an external_id → internal id map', async () => {
    const map = await upsertCatalog(
      [menuRow({ external_id: 'a' }), menuRow({ external_id: 'b', name: 'Fries' })],
      'doordash',
    );

    expect(db.__rows('menu_items')).toHaveLength(2);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBeDefined();
    expect(map.get('b')).toBeDefined();
    expect(map.get('a')).not.toBe(map.get('b'));
  });

  it('is idempotent: re-upserting the same catalog adds no rows and keeps ids stable', async () => {
    const first = await upsertCatalog([menuRow({ external_id: 'a' })], 'doordash');
    const second = await upsertCatalog(
      [menuRow({ external_id: 'a', price_cents: 1500 })], // price changed
      'doordash',
    );

    expect(db.__rows('menu_items')).toHaveLength(1); // updated in place, not duplicated
    expect(second.get('a')).toBe(first.get('a')); // same internal id
    expect(db.__rows('menu_items')[0].price_cents).toBe(1500); // change applied
  });

  it('returns an empty map for an empty input without touching the table', async () => {
    const map = await upsertCatalog([], 'doordash');
    expect(map.size).toBe(0);
    expect(db.__rows('menu_items')).toHaveLength(0);
  });

  it('falls back to a plain insert for rows missing an external_id', async () => {
    const map = await upsertCatalog(
      [menuRow({ external_id: undefined, name: 'Manual' })],
      'doordash',
    );
    expect(map.size).toBe(0);
    expect(db.__rows('menu_items')).toHaveLength(1);
  });

  it('scopes the returned map to the requested source (no cross-source bleed)', async () => {
    // Same external_id under two sources must yield two distinct rows + ids.
    const sq = await upsertCatalog(
      [menuRow({ external_id: 'shared', source: 'square' })],
      'square',
    );
    const dd = await upsertCatalog(
      [menuRow({ external_id: 'shared', source: 'doordash' })],
      'doordash',
    );

    expect(db.__rows('menu_items')).toHaveLength(2);
    expect(dd.get('shared')).not.toBe(sq.get('shared'));
  });
});

describe('upsertOrders', () => {
  async function seedCatalog(extIds: string[], source: OrderSource = 'doordash') {
    return upsertCatalog(
      extIds.map((id) => menuRow({ external_id: id, source })),
      source,
    );
  }

  it('inserts new orders + line items linked to the right menu item and order', async () => {
    const map = await seedCatalog(['burger', 'fries']);
    const { count } = await upsertOrders(
      [order('o-1', [['burger', 2, 1295], ['fries', 1, 695]])],
      map,
      'doordash',
    );

    expect(count).toBe(1);
    const orders = db.__rows('orders');
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      restaurant_id: REST,
      source: 'doordash',
      external_id: 'o-1',
      total_cents: 2 * 1295 + 695,
    });

    const items = db.__rows('order_items');
    expect(items).toHaveLength(2);
    // Every line links to the inserted order...
    expect(items.every((i) => i.order_id === orders[0].id)).toBe(true);
    // ...and to a real menu item id from the catalog map.
    expect(items.map((i) => i.menu_item_id).sort()).toEqual(
      [map.get('burger'), map.get('fries')].sort(),
    );
  });

  it('dedupes on re-sync: a second identical run inserts no new orders or items', async () => {
    const map = await seedCatalog(['burger']);
    const orders = [order('o-1', [['burger', 1, 1295]])];

    const { count: first } = await upsertOrders(orders, map, 'doordash');
    const { count: second } = await upsertOrders(orders, map, 'doordash');

    expect(first).toBe(1);
    expect(second).toBe(0); // nothing new
    expect(db.__rows('orders')).toHaveLength(1);
    expect(db.__rows('order_items')).toHaveLength(1);
  });

  it('only inserts the genuinely-new orders in a mixed re-sync', async () => {
    const map = await seedCatalog(['burger']);
    await upsertOrders([order('o-1', [['burger', 1, 1295]])], map, 'doordash');

    const { count } = await upsertOrders(
      [order('o-1', [['burger', 1, 1295]]), order('o-2', [['burger', 3, 1295]])],
      map,
      'doordash',
    );

    expect(count).toBe(1); // only o-2
    expect(db.__rows('orders').map((o) => o.external_id).sort()).toEqual(['o-1', 'o-2']);
  });

  it('drops line items whose menu_item_external_id is not in the catalog map', async () => {
    const map = await seedCatalog(['burger']); // 'ghost' intentionally absent
    const { count } = await upsertOrders(
      [order('o-1', [['burger', 1, 1295], ['ghost', 1, 999]])],
      map,
      'doordash',
    );

    expect(count).toBe(1);
    expect(db.__rows('orders')).toHaveLength(1);
    expect(db.__rows('order_items')).toHaveLength(1); // ghost line dropped, order survives
    expect(db.__rows('order_items')[0].menu_item_id).toBe(map.get('burger'));
  });

  it('keeps two sources isolated when they share an order external_id', async () => {
    const sqMap = await seedCatalog(['sq-item'], 'square');
    const ddMap = await seedCatalog(['dd-item'], 'doordash');

    await upsertOrders(
      [order('shared-order', [['sq-item', 1, 500]], { source: 'square' })],
      sqMap,
      'square',
    );
    await upsertOrders(
      [order('shared-order', [['dd-item', 1, 700]], { source: 'doordash' })],
      ddMap,
      'doordash',
    );

    const orders = db.__rows('orders');
    expect(orders).toHaveLength(2); // not deduped against each other
    expect(orders.map((o) => o.source).sort()).toEqual(['doordash', 'square']);
  });

  it('returns 0 for an empty order list', async () => {
    expect((await upsertOrders([], new Map(), 'doordash')).count).toBe(0);
  });

  // ── Legacy serial fallback path: orders with no external_id ────────────────
  // (Square's Payments-API path; deduped by ordered_at + total_cents instead.)
  it('inserts an external_id-less order and links its items via the fallback path', async () => {
    const map = await seedCatalog(['burger'], 'square');
    const { count } = await upsertOrders(
      [order(undefined as any, [['burger', 2, 1295]], { source: 'square' })],
      map,
      'square',
    );

    expect(count).toBe(1);
    const orders = db.__rows('orders');
    expect(orders).toHaveLength(1);
    expect(orders[0].external_id).toBeNull();
    expect(db.__rows('order_items')).toHaveLength(1);
    expect(db.__rows('order_items')[0].menu_item_id).toBe(map.get('burger'));
  });

  it('dedupes external_id-less orders by (ordered_at, total_cents) on re-sync', async () => {
    const map = await seedCatalog(['burger'], 'square');
    const noId = [
      order(undefined as any, [['burger', 1, 1295]], {
        source: 'square',
        ordered_at: '2026-05-22T09:00:00.000Z',
      }),
    ];

    expect((await upsertOrders(noId, map, 'square')).count).toBe(1);
    expect((await upsertOrders(noId, map, 'square')).count).toBe(0); // same time+total → deduped
    expect(db.__rows('orders')).toHaveLength(1);
    expect(db.__rows('order_items')).toHaveLength(1);
  });
});

describe('refreshDailySummaries', () => {
  // Inject a fixed "now" anchored just after the seeded order dates so the
  // 30-day rolling window deterministically covers them. Previously these tests
  // relied on the real clock, so they passed only while the hardcoded seed dates
  // happened to fall inside `new Date() - 30d` — and went red once the calendar
  // moved past them. The clock is now a parameter, not an ambient dependency.
  const NOW = new Date('2026-05-22T00:00:00.000Z');

  async function ingestOneDay() {
    const map = await seedAndOrder();
    return map;
  }
  async function seedAndOrder() {
    const map = await upsertCatalog(
      [menuRow({ external_id: 'burger' }), menuRow({ external_id: 'fries', name: 'Fries' })],
      'doordash',
    );
    await upsertOrders(
      [
        order('o-1', [['burger', 2, 1295]], { ordered_at: '2026-05-20T12:00:00.000Z' }),
        order('o-2', [['burger', 1, 1295], ['fries', 3, 695]], {
          ordered_at: '2026-05-20T19:00:00.000Z',
        }),
      ],
      map,
      'doordash',
    );
    return map;
  }

  it('aggregates quantity, revenue, and order counts per (item, date)', async () => {
    const map = await ingestOneDay();
    await refreshDailySummaries(REST, {}, NOW);

    const summaries = db.__rows('daily_summaries');
    const burger = summaries.find((s) => s.menu_item_id === map.get('burger'));
    const fries = summaries.find((s) => s.menu_item_id === map.get('fries'));

    // Burger: 2 (o-1) + 1 (o-2) = 3 units across 2 orders.
    expect(burger).toMatchObject({
      date: '2026-05-20',
      total_quantity: 3,
      total_revenue_cents: 3 * 1295,
      total_orders: 2,
    });
    // Fries: 3 units in 1 order.
    expect(fries).toMatchObject({
      date: '2026-05-20',
      total_quantity: 3,
      total_revenue_cents: 3 * 695,
      total_orders: 1,
    });
  });

  it('updates summaries in place on re-run — metrics do not inflate', async () => {
    const map = await seedAndOrder();
    await refreshDailySummaries(REST, {}, NOW);
    const before = db.__rows('daily_summaries').length;

    // Re-running ingestion of the SAME orders, then refreshing again.
    await upsertOrders(
      [order('o-1', [['burger', 2, 1295]], { ordered_at: '2026-05-20T12:00:00.000Z' })],
      map,
      'doordash',
    );
    await refreshDailySummaries(REST, {}, NOW);

    const summaries = db.__rows('daily_summaries');
    expect(summaries).toHaveLength(before); // no new summary rows
    const burger = summaries.find((s) => s.menu_item_id === map.get('burger'));
    expect(burger.total_quantity).toBe(3); // unchanged, not doubled
  });

  it('prunes stale summary rows that no longer have backing orders', async () => {
    await seedAndOrder();
    await refreshDailySummaries(REST, {}, NOW);
    expect(db.__rows('daily_summaries').length).toBeGreaterThan(0);

    // Wipe the orders, then refresh: summaries in the window should be cleared.
    db.__tables.orders = [];
    db.__tables.order_items = [];
    await refreshDailySummaries(REST, {}, NOW);

    expect(db.__rows('daily_summaries')).toHaveLength(0);
  });

  it('an explicit older range with no orders does not wipe the steady-state window (bounded delete)', async () => {
    // Seed the steady-state (last 30 days) window with real summaries.
    await seedAndOrder();
    await refreshDailySummaries(REST, {}, NOW);
    const before = db.__rows('daily_summaries');
    expect(before.length).toBeGreaterThan(0);

    // Recompute an explicit, non-trailing range (days 60-90 back) that has no
    // orders at all. Before the fix, the no-orders delete path used
    // `.gte('date', sinceDate)` with no upper bound, so calling it with an old
    // `from` deleted every summary from that date forward — including the
    // steady-state window seeded above. Every delete must now also carry
    // `.lte('date', to)` so it only touches the requested range.
    await refreshDailySummaries(
      REST,
      { from: new Date('2026-02-01T00:00:00.000Z'), to: new Date('2026-02-20T00:00:00.000Z') },
      NOW,
    );

    const after = db.__rows('daily_summaries');
    expect(after).toEqual(before);
  });

  it('aggregates across sources into the same date bucket', async () => {
    const sqMap = await upsertCatalog(
      [menuRow({ external_id: 'sq-burger', source: 'square' })],
      'square',
    );
    const ddMap = await upsertCatalog(
      [menuRow({ external_id: 'dd-burger', source: 'doordash' })],
      'doordash',
    );
    await upsertOrders(
      [order('sq-1', [['sq-burger', 1, 1000]], { ordered_at: '2026-05-21T10:00:00.000Z', source: 'square' })],
      sqMap,
      'square',
    );
    await upsertOrders(
      [order('dd-1', [['dd-burger', 1, 1200]], { ordered_at: '2026-05-21T11:00:00.000Z', source: 'doordash' })],
      ddMap,
      'doordash',
    );

    await refreshDailySummaries(REST, {}, NOW);

    const onDate = db.__rows('daily_summaries').filter((s) => s.date === '2026-05-21');
    // Two distinct menu items → two summary rows, both present (source-agnostic).
    expect(onDate).toHaveLength(2);
    expect(onDate.reduce((s, r) => s + r.total_revenue_cents, 0)).toBe(2200);
  });
});

describe('refreshDailySummaries: coverage bootstrap / single-run / backdated top-up', () => {
  // Same fixed-clock rationale as the block above: the window must not slide
  // with the calendar.
  const NOW = new Date('2026-05-22T00:00:00.000Z');
  const BOOTSTRAP_DAYS = 90;
  const MENU_ITEM_ID = 'menu-item-1';

  const daysAgoDate_ = (n: number): string => {
    const d = new Date(NOW);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().split('T')[0];
  };
  const daysAgoIso_ = (n: number): string => `${daysAgoDate_(n)}T12:00:00.000Z`;

  /** Seed a bare orders + order_items row directly, bypassing upsertOrders —
   * these tests exercise recomputeRange's read side, not the write-dedup path
   * (that's covered by the upsertOrders describe block above). */
  function seedRawOrder(id: string, daysAgo: number) {
    db.__seed('orders', [
      {
        id,
        restaurant_id: REST,
        source: 'doordash',
        total_cents: 1000,
        ordered_at: daysAgoIso_(daysAgo),
        external_id: id,
      },
    ]);
    db.__seed('order_items', [
      { id: `${id}-oi`, order_id: id, menu_item_id: MENU_ITEM_ID, quantity: 1, unit_price_cents: 1000 },
    ]);
  }

  it('bootstraps full 90-day coverage on the first sync and writes the watermark', async () => {
    db.__seed('restaurants', [{ id: REST }]); // no summaries_covered_from yet

    // Orders spanning the full 90-day bootstrap window.
    seedRawOrder('o-89', 89);
    seedRawOrder('o-60', 60);
    seedRawOrder('o-45', 45);
    seedRawOrder('o-20', 20);
    seedRawOrder('o-5', 5);

    // Pre-existing summaries only for the last 30 days, as if this restaurant
    // had been running under the old steady-state-only behavior.
    db.__seed('daily_summaries', [
      { id: 'ds-20', restaurant_id: REST, menu_item_id: MENU_ITEM_ID, date: daysAgoDate_(20), total_quantity: 1, total_revenue_cents: 1000, total_orders: 1 },
      { id: 'ds-5', restaurant_id: REST, menu_item_id: MENU_ITEM_ID, date: daysAgoDate_(5), total_quantity: 1, total_revenue_cents: 1000, total_orders: 1 },
    ]);

    await refreshDailySummaries(REST, {}, NOW);

    const dates = db.__rows('daily_summaries').map((s) => s.date).sort();
    expect(dates).toEqual(
      [daysAgoDate_(89), daysAgoDate_(60), daysAgoDate_(45), daysAgoDate_(20), daysAgoDate_(5)].sort(),
    );

    const rest = db.__rows('restaurants').find((r) => r.id === REST);
    expect(rest.summaries_covered_from).toBe(daysAgoDate_(BOOTSTRAP_DAYS));
  });

  it('does not re-run the wide bootstrap query on a second sync', async () => {
    db.__seed('restaurants', [{ id: REST }]);
    seedRawOrder('o-89', 89);
    seedRawOrder('o-5', 5);

    await refreshDailySummaries(REST, {}, NOW); // bootstrap sync
    db.__clearCalls();

    await refreshDailySummaries(REST, {}, NOW); // second sync, should be steady-state only

    const target = new Date(NOW);
    target.setUTCDate(target.getUTCDate() - BOOTSTRAP_DAYS);
    const bootstrapFromIso = target.toISOString();

    const wideOrderQueries = db.__calls().filter(
      (c) =>
        c.table === 'orders' &&
        c.op === 'select' &&
        c.filters.some((f) => f.kind === 'gte' && f.col === 'ordered_at' && f.val === bootstrapFromIso),
    );
    expect(wideOrderQueries).toHaveLength(0);
  });

  it('tops up a backdated order without disturbing the steady-state window', async () => {
    // Already bootstrapped: watermark is set, so this sync takes the
    // steady-state + top-up path, not the bootstrap path.
    db.__seed('restaurants', [{ id: REST, summaries_covered_from: daysAgoDate_(BOOTSTRAP_DAYS) }]);

    // Existing steady-state order + summary (last 30 days).
    seedRawOrder('o-recent', 5);
    db.__seed('daily_summaries', [
      { id: 'ds-recent', restaurant_id: REST, menu_item_id: MENU_ITEM_ID, date: daysAgoDate_(5), total_quantity: 1, total_revenue_cents: 1000, total_orders: 1 },
    ]);

    // A newly-inserted, backdated order (60 days ago — outside the 30-day
    // steady-state window but inside the 90-day bootstrap floor).
    const map = await upsertCatalog([menuRow({ external_id: 'burger' })], 'doordash');
    const { insertedDates } = await upsertOrders(
      [order('o-backdated', [['burger', 2, 500]], { ordered_at: daysAgoIso_(60) })],
      map,
      'doordash',
    );
    expect(insertedDates).toEqual([daysAgoDate_(60)]);

    await refreshDailySummaries(REST, { insertedOrderDates: insertedDates }, NOW);

    const summaries = db.__rows('daily_summaries');

    const backdated = summaries.find((s) => s.date === daysAgoDate_(60));
    expect(backdated).toMatchObject({
      menu_item_id: map.get('burger'),
      total_quantity: 2,
      total_revenue_cents: 1000,
      total_orders: 1,
    });

    // Steady-state (last-30-days) row is untouched by the top-up.
    const recent = summaries.find((s) => s.date === daysAgoDate_(5));
    expect(recent).toMatchObject({
      menu_item_id: MENU_ITEM_ID,
      total_quantity: 1,
      total_revenue_cents: 1000,
      total_orders: 1,
    });
  });
});

describe('runAlerts', () => {
  it('invokes generateAlerts for the restaurant', async () => {
    generateAlertsMock.mockResolvedValue(3);
    await runAlerts(REST, 'doordash');
    expect(generateAlertsMock).toHaveBeenCalledWith(REST);
  });

  it('never throws when alert generation fails (fire-and-forget)', async () => {
    generateAlertsMock.mockRejectedValue(new Error('alert boom'));
    await expect(runAlerts(REST, 'doordash')).resolves.toBeUndefined();
  });
});
