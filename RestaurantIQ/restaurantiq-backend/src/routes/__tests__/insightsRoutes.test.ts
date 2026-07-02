/**
 * HTTP-level tests for /api/insights (Sprint U) — the repo's first route-layer
 * suite (engineering review H5: the tenant-isolation boundary previously had
 * zero automated coverage).
 *
 * The full middleware chain runs REAL code: authMiddleware verifies actual
 * HS256 JWTs (SUPABASE_JWT_SECRET set, SUPABASE_URL unset → hs256 mode) and
 * requireRestaurant resolves the tenant against the in-memory Supabase fake.
 * Only the AI rate limiter (not under test, needs full env) and the Claude
 * call are mocked.
 *
 * The wrong-tenant cases are the point of this file: a valid token for user A
 * must never read or mutate restaurant B's insights.
 */
jest.mock('../../db', () => {
  const { createFakeSupabase: make } = require('../../services/ingestion/__tests__/fakeSupabase');
  return { supabase: make() };
});

jest.mock('../../middleware/rateLimit', () => ({
  createAiRateLimiter:
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const generateInsightsMock = jest.fn();
jest.mock('../../services/anthropicService', () => ({
  ...jest.requireActual('../../services/anthropicService'),
  generateInsights: (...args: any[]) => generateInsightsMock(...args),
}));

// HS256 auth mode: SUPABASE_URL must be unset BEFORE the auth middleware first
// resolves its mode (it caches after the first request).
delete process.env.SUPABASE_URL;
process.env.SUPABASE_JWT_SECRET = 'test-secret';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { supabase } from '../../db';
import insightsRouter from '../insights';

const fake = supabase as any;

const app = express();
app.use(express.json());
app.use('/api/insights', insightsRouter);

const tokenFor = (userId: string): string =>
  jwt.sign({ sub: userId }, 'test-secret', { audience: 'authenticated', expiresIn: '1h' });

const USER_A = 'user-a';
const USER_B = 'user-b';
const REST_A = 'rest-a';
const REST_B = 'rest-b';

const seedTenants = () => {
  fake.__seed('restaurants', [
    { id: REST_A, user_id: USER_A, name: 'A Diner' },
    { id: REST_B, user_id: USER_B, name: 'B Bistro' },
  ]);
};

/** Generation state so GET does not attempt a lazy first generation. */
const seedState = (restaurantId: string, meta: Record<string, unknown> = { daysWithData: 30 }) => {
  fake.__seed('insights_generation_state', [
    {
      restaurant_id: restaurantId,
      last_generated_at: new Date().toISOString(),
      last_meta: meta,
    },
  ]);
};

const seedInsight = (restaurantId: string, overrides: Record<string, unknown> = {}) => {
  const row = {
    id: `ins-${restaurantId}-${(overrides.dedup_key as string) ?? 'x'}`,
    restaurant_id: restaurantId,
    dedup_key: 'menu_performance|x',
    category: 'menu_performance',
    priority: 'medium',
    title: 't',
    explanation: 'e',
    metric: 'm',
    impact: 'i',
    action: 'a',
    link: 'menu',
    status: 'active',
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    resolved_at: null,
    ...overrides,
  };
  fake.__seed('insights', [row]);
  return row;
};

beforeEach(() => {
  fake.__reset();
  generateInsightsMock.mockReset();
});

describe('auth boundary', () => {
  it('401s without a bearer token', async () => {
    const res = await request(app).get('/api/insights');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ data: null, error: 'Unauthorized' });
  });

  it('401s with a token signed by the wrong secret', async () => {
    const bad = jwt.sign({ sub: USER_A }, 'wrong-secret', { audience: 'authenticated' });
    const res = await request(app)
      .get('/api/insights')
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it('404s for an authenticated user with no restaurant', async () => {
    seedTenants();
    const res = await request(app)
      .get('/api/insights')
      .set('Authorization', `Bearer ${tokenFor('user-with-nothing')}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/insights', () => {
  it('returns the tenant’s stored insights, priority-ordered, with stored meta', async () => {
    seedTenants();
    seedState(REST_A, { daysWithData: 30, confidence: 'high' });
    seedInsight(REST_A, { dedup_key: 'a|low', priority: 'low' });
    seedInsight(REST_A, { dedup_key: 'a|high', priority: 'high' });
    // Another tenant's insight must never appear.
    seedInsight(REST_B, { dedup_key: 'b|high', priority: 'high' });

    const res = await request(app)
      .get('/api/insights')
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`);

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.insights).toHaveLength(2);
    expect(res.body.data.insights[0].priority).toBe('high');
    expect(res.body.data.insights[1].priority).toBe('low');
    expect(res.body.data.meta.confidence).toBe('high');
    expect(generateInsightsMock).not.toHaveBeenCalled(); // reads are free
  });

  it('rejects an invalid status filter with 400', async () => {
    seedTenants();
    seedState(REST_A);
    const res = await request(app)
      .get('/api/insights?status=bogus')
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`);
    expect(res.status).toBe(400);
  });

  it('serves the not-enough-data fallback (unpersisted) for thin-data tenants', async () => {
    seedTenants();
    seedState(REST_A, { daysWithData: 1 });

    const res = await request(app)
      .get('/api/insights')
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.insights[0].title).toBe('Not enough data yet');
    expect(fake.__rows('insights')).toHaveLength(0); // never persisted
  });
});

describe('POST /api/insights/refresh', () => {
  it('generates, persists, and returns the fresh list', async () => {
    seedTenants();
    const today = new Date().toISOString().split('T')[0];
    fake.__seed(
      'daily_summaries',
      [1, 2, 3].map((n) => ({
        restaurant_id: REST_A,
        menu_item_id: `item-${n}`,
        date: today,
        total_quantity: n,
        total_revenue_cents: n * 1000,
        total_orders: n,
      })),
    );
    generateInsightsMock.mockResolvedValue({
      insights: [
        {
          category: 'menu_performance',
          priority: 'high',
          title: 'Promote Truffle Fries',
          explanation: 'e',
          metric: 'm',
          impact: 'i',
          action: 'a',
          link: 'menu',
          menu_item_name: 'Truffle Fries',
        },
      ],
    });

    const res = await request(app)
      .post('/api/insights/refresh')
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.refreshed).toBe(true);
    expect(res.body.data.insights).toHaveLength(1);
    expect(res.body.data.insights[0].title).toBe('Promote Truffle Fries');
    expect(fake.__rows('insights')).toHaveLength(1); // persisted, not ephemeral
  });
});

describe('PATCH /api/insights/:id — tenant isolation', () => {
  it('lets the owner dismiss their insight and records the event', async () => {
    seedTenants();
    const row = seedInsight(REST_A);

    const res = await request(app)
      .patch(`/api/insights/${row.id}`)
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`)
      .send({ status: 'dismissed' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('dismissed');
    expect(res.body.data.resolved_at).not.toBeNull();
    const events = fake.__rows('insight_events');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ insight_id: row.id, event: 'dismissed' });
  });

  it("404s (and does not mutate) another tenant's insight", async () => {
    seedTenants();
    const foreign = seedInsight(REST_B);

    const res = await request(app)
      .patch(`/api/insights/${foreign.id}`)
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`)
      .send({ status: 'dismissed' });

    expect(res.status).toBe(404);
    // The row is untouched and no event leaked across tenants.
    const after = fake.__rows('insights').find((r: any) => r.id === foreign.id);
    expect(after.status).toBe('active');
    expect(fake.__rows('insight_events')).toHaveLength(0);
  });

  it('rejects an invalid status body with 400', async () => {
    seedTenants();
    const row = seedInsight(REST_A);

    const res = await request(app)
      .patch(`/api/insights/${row.id}`)
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`)
      .send({ status: 'archived' });

    expect(res.status).toBe(400);
    const after = fake.__rows('insights').find((r: any) => r.id === row.id);
    expect(after.status).toBe('active');
  });

  it('reactivation records a reactivated event and clears resolved_at', async () => {
    seedTenants();
    const row = seedInsight(REST_A, {
      status: 'dismissed',
      resolved_at: new Date().toISOString(),
    });

    const res = await request(app)
      .patch(`/api/insights/${row.id}`)
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`)
      .send({ status: 'active' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.resolved_at).toBeNull();
    expect(fake.__rows('insight_events')[0].event).toBe('reactivated');
  });
});
