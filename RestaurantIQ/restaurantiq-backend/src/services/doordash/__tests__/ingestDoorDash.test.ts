/**
 * End-to-end DoorDash ingestion test.
 *
 * Drives the REAL ingestDoorDash entry point (mock-data mode) through the REAL
 * normalizers and the REAL shared persistence layer, persisting into an in-memory
 * Supabase fake. This is the offline stand-in for Sprint K's live-sync evidence
 * (goal #4) and idempotency proof (goal #5): no DoorDash sandbox credentials
 * exist and writing to the production Supabase was deliberately avoided, so the
 * full pipeline is exercised against a Postgres-faithful fake instead.
 *
 * What it proves:
 *   - orders, order_items, menu_items, daily_summaries all get written
 *   - every record is tagged source='doordash'
 *   - order_items link to a real order id AND a real menu_item id
 *   - revenue in daily_summaries reconciles with the source orders
 *   - re-running the sync is idempotent (no duplicate rows, no inflated metrics)
 */
import { createFakeSupabase } from '../../ingestion/__tests__/fakeSupabase';

jest.mock('../../../db', () => {
  const { createFakeSupabase: make } = require('../../ingestion/__tests__/fakeSupabase');
  return { supabase: make() };
});

const generateAlertsMock = jest.fn();
jest.mock('../../alertsService', () => ({
  generateAlerts: (...args: any[]) => generateAlertsMock(...args),
}));

import { supabase } from '../../../db';
import { ingestDoorDash } from '../ingestDoorDash';

const db = supabase as any;
const REST = 'rest-1';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.USE_MOCK = 'true'; // deterministic sandbox catalog + orders, no network
  db.__reset();
  db.__seed('restaurants', [
    {
      id: REST,
      doordash_store_id: 'st-sandbox',
      doordash_access_token: null,
      doordash_refresh_token: null,
      doordash_token_expires_at: null,
    },
  ]);
  generateAlertsMock.mockReset();
  generateAlertsMock.mockResolvedValue(0);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('ingestDoorDash — first sync', () => {
  it('reports a successful mock-mode result with the expected counts', async () => {
    const result = await ingestDoorDash(REST);
    expect(result).toEqual({
      ok: true,
      mock: true,
      catalogCount: 5,
      orderCount: 12,
    });
  });

  it('persists menu_items, orders, and order_items — all tagged source=doordash', async () => {
    await ingestDoorDash(REST);

    const menuItems = db.__rows('menu_items');
    const orders = db.__rows('orders');
    const orderItems = db.__rows('order_items');

    expect(menuItems).toHaveLength(5);
    expect(menuItems.every((m: any) => m.source === 'doordash')).toBe(true);
    expect(menuItems.every((m: any) => m.external_id.startsWith('dd-item-'))).toBe(true);

    expect(orders).toHaveLength(12);
    expect(orders.every((o: any) => o.source === 'doordash')).toBe(true);
    expect(orders.every((o: any) => o.external_id.startsWith('dd-order-'))).toBe(true);
    expect(orders.every((o: any) => o.total_cents > 0)).toBe(true);

    // 12 orders × 2 line items each, none dropped (all ids resolve in catalog).
    expect(orderItems).toHaveLength(24);
  });

  it('links every order_item to a real order id and a real menu_item id', async () => {
    await ingestDoorDash(REST);

    const orderIds = new Set(db.__rows('orders').map((o: any) => o.id));
    const menuItemIds = new Set(db.__rows('menu_items').map((m: any) => m.id));
    const orderItems = db.__rows('order_items');

    expect(orderItems.every((oi: any) => orderIds.has(oi.order_id))).toBe(true);
    expect(orderItems.every((oi: any) => menuItemIds.has(oi.menu_item_id))).toBe(true);
  });

  it('produces daily_summaries whose revenue reconciles with the source orders', async () => {
    await ingestDoorDash(REST);

    const orders = db.__rows('orders');
    const summaries = db.__rows('daily_summaries');
    expect(summaries.length).toBeGreaterThan(0);

    const ordersTotal = orders.reduce((s: number, o: any) => s + o.total_cents, 0);
    const summariesTotal = summaries.reduce(
      (s: number, r: any) => s + r.total_revenue_cents,
      0,
    );
    // Each mock order's total equals the sum of its lines, so summary revenue
    // (aggregated from order_items) must reconcile with the order totals.
    expect(summariesTotal).toBe(ordersTotal);
  });

  it('triggers alert regeneration after the summaries are rebuilt', async () => {
    await ingestDoorDash(REST);
    expect(generateAlertsMock).toHaveBeenCalledWith(REST);
  });
});

describe('ingestDoorDash — idempotency (re-sync safety)', () => {
  it('a second immediate sync creates no new rows and does not inflate metrics', async () => {
    await ingestDoorDash(REST);
    const snapshot = {
      menu: db.__rows('menu_items').length,
      orders: db.__rows('orders').length,
      items: db.__rows('order_items').length,
      summaries: db.__rows('daily_summaries').length,
      revenue: db
        .__rows('daily_summaries')
        .reduce((s: number, r: any) => s + r.total_revenue_cents, 0),
    };

    const second = await ingestDoorDash(REST);

    expect(second.orderCount).toBe(0); // nothing new ingested
    expect(db.__rows('menu_items')).toHaveLength(snapshot.menu);
    expect(db.__rows('orders')).toHaveLength(snapshot.orders);
    expect(db.__rows('order_items')).toHaveLength(snapshot.items);
    expect(db.__rows('daily_summaries')).toHaveLength(snapshot.summaries);
    expect(
      db.__rows('daily_summaries').reduce((s: number, r: any) => s + r.total_revenue_cents, 0),
    ).toBe(snapshot.revenue); // revenue unchanged — no double counting
  });

  it('remains stable across three consecutive syncs', async () => {
    await ingestDoorDash(REST);
    await ingestDoorDash(REST);
    await ingestDoorDash(REST);

    expect(db.__rows('orders')).toHaveLength(12);
    expect(db.__rows('order_items')).toHaveLength(24);
    expect(db.__rows('menu_items')).toHaveLength(5);
  });
});
