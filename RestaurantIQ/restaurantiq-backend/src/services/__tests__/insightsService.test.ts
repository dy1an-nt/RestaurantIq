/**
 * Unit tests for the persistent-insights lifecycle (Sprint U).
 *
 * These pin the invariants the sprint plan calls out as success criteria:
 *   1. Regeneration is idempotent — the same pattern re-detected UPDATES its
 *      row (dedup_key), never duplicates it.
 *   2. A dismissed insight stays dismissed across regenerations.
 *   3. Escalation is the one exception: a dismissed insight whose priority
 *      rose reactivates, with an 'escalated' audit event.
 *   4. The frequency guard prevents back-to-back generations (cost cap).
 *   5. <3 days of data → no Claude call, no placeholder rows.
 *   6. Active insights the model stops reporting expire after the TTL.
 *
 * generateInsights (the Claude call) is mocked; persistence runs against the
 * shared in-memory Supabase fake so dedup semantics are real, not rubber-stamped.
 */
jest.mock('../../db', () => {
  const { createFakeSupabase: make } = require('../ingestion/__tests__/fakeSupabase');
  return { supabase: make() };
});

const generateInsightsMock = jest.fn();
jest.mock('../anthropicService', () => ({
  ...jest.requireActual('../anthropicService'),
  generateInsights: (...args: any[]) => generateInsightsMock(...args),
}));

import { supabase } from '../../db';
import { Insight } from '../anthropicService';
import {
  computeDedupKey,
  generateAndPersistInsights,
} from '../insightsService';

const fake = supabase as any;

const RESTAURANT = 'rest-1';

const insight = (overrides: Partial<Insight> = {}): Insight => ({
  category: 'menu_performance',
  priority: 'medium',
  title: 'BBQ Ribs are trending down',
  explanation: 'Revenue fell over the last two weeks.',
  metric: '$1,440 → $1,108 (-23%)',
  impact: '~$330/week at risk',
  action: 'Feature BBQ Ribs in this week’s promo.',
  link: 'menu',
  menu_item_name: 'BBQ Ribs',
  ...overrides,
});

/** Seed enough daily_summaries that generation proceeds (≥3 rows in window). */
const seedSummaries = () => {
  const today = new Date().toISOString().split('T')[0];
  fake.__seed(
    'daily_summaries',
    [1, 2, 3].map((n) => ({
      restaurant_id: RESTAURANT,
      menu_item_id: `item-${n}`,
      date: today,
      total_quantity: n,
      total_revenue_cents: n * 1000,
      total_orders: n,
      menu_items: { name: `Item ${n}`, category: 'Mains' },
    })),
  );
};

beforeEach(() => {
  fake.__reset();
  generateInsightsMock.mockReset();
});

describe('computeDedupKey', () => {
  it('derives identity from structured fields, not wording', () => {
    const a = insight({ title: 'BBQ Ribs are trending down' });
    const b = insight({ title: 'Ribs revenue is falling fast' });
    expect(computeDedupKey(a)).toBe(computeDedupKey(b));
    expect(computeDedupKey(a)).toBe('menu_performance|bbq-ribs');
  });

  it('falls back to general for whole-business insights', () => {
    expect(computeDedupKey(insight({ menu_item_name: null, category: 'staffing' }))).toBe(
      'staffing|general',
    );
  });
});

describe('generateAndPersistInsights', () => {
  it('is idempotent: regenerating the same insight updates one row, never duplicates', async () => {
    seedSummaries();
    generateInsightsMock.mockResolvedValue({ insights: [insight()] });

    await generateAndPersistInsights(RESTAURANT, { force: true });
    generateInsightsMock.mockResolvedValue({
      insights: [insight({ metric: '$1,440 → $1,050 (-27%)' })],
    });
    await generateAndPersistInsights(RESTAURANT, { force: true });

    const rows = fake.__rows('insights');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].metric).toBe('$1,440 → $1,050 (-27%)'); // fresh numbers win
  });

  it('never resurrects a dismissed insight at the same priority', async () => {
    seedSummaries();
    fake.__seed('insights', [
      {
        id: 'ins-1',
        restaurant_id: RESTAURANT,
        dedup_key: 'menu_performance|bbq-ribs',
        status: 'dismissed',
        priority: 'medium',
        title: 'old title',
        last_seen_at: '2020-01-01T00:00:00.000Z',
      },
    ]);
    generateInsightsMock.mockResolvedValue({ insights: [insight({ priority: 'medium' })] });

    await generateAndPersistInsights(RESTAURANT, { force: true });

    const rows = fake.__rows('insights');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('dismissed');
    expect(rows[0].title).toBe('old title'); // fields untouched, only last_seen_at
    expect(new Date(rows[0].last_seen_at).getTime()).toBeGreaterThan(0);
    expect(fake.__rows('insight_events')).toHaveLength(0);
  });

  it('escalates a dismissed insight whose priority rose, with an audit event', async () => {
    seedSummaries();
    fake.__seed('insights', [
      {
        id: 'ins-1',
        restaurant_id: RESTAURANT,
        dedup_key: 'menu_performance|bbq-ribs',
        status: 'dismissed',
        priority: 'medium',
        last_seen_at: '2020-01-01T00:00:00.000Z',
      },
    ]);
    generateInsightsMock.mockResolvedValue({ insights: [insight({ priority: 'high' })] });

    await generateAndPersistInsights(RESTAURANT, { force: true });

    const rows = fake.__rows('insights');
    expect(rows[0].status).toBe('active');
    expect(rows[0].priority).toBe('high');
    const events = fake.__rows('insight_events');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('escalated');
    expect(events[0].insight_id).toBe('ins-1');
  });

  it('frequency guard: a recent generation skips without calling Claude', async () => {
    seedSummaries();
    fake.__seed('insights_generation_state', [
      {
        restaurant_id: RESTAURANT,
        last_generated_at: new Date().toISOString(),
        last_meta: {},
      },
    ]);

    const outcome = await generateAndPersistInsights(RESTAURANT);

    expect(outcome).toEqual({ generated: false, reason: 'fresh' });
    expect(generateInsightsMock).not.toHaveBeenCalled();
  });

  it('force bypasses the frequency guard', async () => {
    seedSummaries();
    fake.__seed('insights_generation_state', [
      {
        restaurant_id: RESTAURANT,
        last_generated_at: new Date().toISOString(),
        last_meta: {},
      },
    ]);
    generateInsightsMock.mockResolvedValue({ insights: [insight()] });

    const outcome = await generateAndPersistInsights(RESTAURANT, { force: true });

    expect(outcome.generated).toBe(true);
    expect(generateInsightsMock).toHaveBeenCalledTimes(1);
  });

  it('under 3 days of data: no Claude call, no placeholder rows, state still saved', async () => {
    const outcome = await generateAndPersistInsights(RESTAURANT, { force: true });

    expect(outcome).toEqual({ generated: false, reason: 'insufficient_data' });
    expect(generateInsightsMock).not.toHaveBeenCalled();
    expect(fake.__rows('insights')).toHaveLength(0);
    expect(fake.__rows('insights_generation_state')).toHaveLength(1);
  });

  it('expires active insights the model stopped reporting past the TTL', async () => {
    seedSummaries();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    fake.__seed('insights', [
      {
        id: 'ins-stale',
        restaurant_id: RESTAURANT,
        dedup_key: 'slow_days|general',
        status: 'active',
        priority: 'low',
        last_seen_at: eightDaysAgo,
      },
    ]);
    generateInsightsMock.mockResolvedValue({ insights: [insight()] });

    const outcome = await generateAndPersistInsights(RESTAURANT, { force: true });

    const stale = fake.__rows('insights').find((r: any) => r.id === 'ins-stale');
    expect(stale.status).toBe('expired');
    expect(stale.resolved_at).not.toBeNull();
    expect(outcome.expired).toBe(1);
    // The freshly reported insight is untouched by the expiry pass.
    const fresh = fake.__rows('insights').find((r: any) => r.dedup_key === 'menu_performance|bbq-ribs');
    expect(fresh.status).toBe('active');
  });

  it('reactivates an expired insight when the pattern returns', async () => {
    seedSummaries();
    fake.__seed('insights', [
      {
        id: 'ins-1',
        restaurant_id: RESTAURANT,
        dedup_key: 'menu_performance|bbq-ribs',
        status: 'expired',
        priority: 'medium',
        resolved_at: '2020-01-02T00:00:00.000Z',
        last_seen_at: '2020-01-01T00:00:00.000Z',
      },
    ]);
    generateInsightsMock.mockResolvedValue({ insights: [insight()] });

    await generateAndPersistInsights(RESTAURANT, { force: true });

    const rows = fake.__rows('insights');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].resolved_at).toBeNull();
  });
});
