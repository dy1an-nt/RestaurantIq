/**
 * HTTP-level tests for GET /api/analytics/dashboard's selectable time window
 * (`?days=7|30|90`). Mirrors the harness in insightsRoutes.test.ts /
 * tenantIsolation.test.ts: real authMiddleware (HS256 fallback), real
 * requireRestaurant, real analyticsRouter, against an in-memory Supabase fake.
 *
 * Covers the contract in the sprint spec: the 400 rejection cases (unknown
 * value, non-numeric, negative, array, unknown query key), the 200 shape and
 * `meta` block at each allowed window, and that orders/summaries share the
 * same `from` boundary (the AOV-mismatch bug this sprint fixes).
 */
jest.mock('../../db', () => {
  const { createFakeSupabase: make } = require('../../services/ingestion/__tests__/fakeSupabase');
  return { supabase: make() };
});

delete process.env.SUPABASE_URL;
process.env.SUPABASE_JWT_SECRET = 'test-secret';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { supabase } from '../../db';
import analyticsRouter from '../analytics';

const fake = supabase as any;

const app = express();
app.use(express.json());
app.use('/api/analytics', analyticsRouter);

const tokenFor = (userId: string): string =>
  jwt.sign({ sub: userId }, 'test-secret', { audience: 'authenticated', expiresIn: '1h' });

const REST = 'rest-1';
const USER = 'user-1';
const asUser = { Authorization: `Bearer ${tokenFor(USER)}` };

beforeEach(() => {
  fake.__reset();
  fake.__seed('restaurants', [
    {
      id: REST,
      user_id: USER,
      doordash_commission_bps: 1500,
      doordash_flat_fee_cents: 199,
    },
  ]);
});

describe('GET /api/analytics/dashboard — auth and validation', () => {
  it('401s without a bearer token', async () => {
    const res = await request(app).get('/api/analytics/dashboard');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ data: null, error: 'Unauthorized' });
  });

  it('400s for a days value outside {7, 30, 90}', async () => {
    const res = await request(app)
      .get('/api/analytics/dashboard?days=14')
      .set(asUser);
    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(typeof res.body.error).toBe('string');
  });

  it('400s for a non-numeric days value', async () => {
    const res = await request(app)
      .get('/api/analytics/dashboard?days=abc')
      .set(asUser);
    expect(res.status).toBe(400);
  });

  it('400s for a negative days value', async () => {
    const res = await request(app)
      .get('/api/analytics/dashboard?days=-7')
      .set(asUser);
    expect(res.status).toBe(400);
  });

  it('400s when days is repeated (Express parses it into an array)', async () => {
    const res = await request(app)
      .get('/api/analytics/dashboard?days=7&days=90')
      .set(asUser);
    expect(res.status).toBe(400);
  });

  it('400s for an unknown query key', async () => {
    const res = await request(app)
      .get('/api/analytics/dashboard?day=90')
      .set(asUser);
    expect(res.status).toBe(400);
  });

  it('404s for an authenticated user with no restaurant', async () => {
    const res = await request(app)
      .get('/api/analytics/dashboard')
      .set({ Authorization: `Bearer ${tokenFor('user-with-nothing')}` });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ data: null, error: 'Restaurant not found' });
  });
});

describe('GET /api/analytics/dashboard — window resolution', () => {
  it.each([7, 30, 90] as const)('resolves days=%i into a matching meta block', async (days) => {
    const res = await request(app)
      .get(`/api/analytics/dashboard?days=${days}`)
      .set(asUser);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.meta.days).toBe(days);
    expect(res.body.data.meta.earliest_data_date).toBeNull();
    expect(res.body.data.meta.days_available).toBe(0);
    // to is always "today" in UTC.
    expect(res.body.data.meta.to).toBe(new Date().toISOString().split('T')[0]);
  });

  it('defaults to 30 when days is omitted', async () => {
    const res = await request(app).get('/api/analytics/dashboard').set(asUser);
    expect(res.status).toBe(200);
    expect(res.body.data.meta.days).toBe(30);
  });

  it('reports earliest_data_date and days_available scoped to the caller only', async () => {
    fake.__seed('orders', [
      { id: 'o-1', restaurant_id: REST, source: 'square', total_cents: 1000, ordered_at: '2020-01-01T12:00:00.000Z' },
      // A different tenant's older order must never leak into this restaurant's meta.
      { id: 'o-2', restaurant_id: 'rest-other', source: 'square', total_cents: 500, ordered_at: '1999-01-01T00:00:00.000Z' },
    ]);

    const res = await request(app)
      .get('/api/analytics/dashboard?days=7')
      .set(asUser);

    expect(res.status).toBe(200);
    // earliest_data_date is far outside the 7-day window, so days_available
    // is clamped to the window size, not the full history.
    expect(res.body.data.meta.earliest_data_date).toBe('2020-01-01');
    expect(res.body.data.meta.days_available).toBe(7);
  });

  it('revenueTrend (from daily_summaries) and hourlyDistribution (from orders) share the same lower boundary', async () => {
    // date === meta.from exactly: in-window for both daily_summaries and orders.
    const res7 = await request(app).get('/api/analytics/dashboard?days=7').set(asUser);
    const from = res7.body.data.meta.from;

    fake.__seed('daily_summaries', [
      { restaurant_id: REST, menu_item_id: 'item-1', date: from, total_quantity: 1, total_revenue_cents: 500, total_orders: 1, menu_items: [{ name: 'Burger', category: 'Mains' }] },
    ]);
    fake.__seed('orders', [
      { id: 'o-in', restaurant_id: REST, source: 'square', total_cents: 500, ordered_at: `${from}T00:00:00.000Z` },
    ]);

    const res = await request(app).get('/api/analytics/dashboard?days=7').set(asUser);
    expect(res.status).toBe(200);
    expect(res.body.data.revenueTrend).toEqual([{ date: from, revenue_cents: 500 }]);
    expect(res.body.data.hourlyDistribution.length).toBe(1);
  });
});
