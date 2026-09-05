/**
 * Unit tests for the incremental orders watermark policy.
 *
 * ordersStartAt decides how far back each sync asks Square for orders. The
 * asymmetry it encodes is the whole point: re-pulling a stored order is free
 * (upsertOrders dedupes on external_id), missing one loses it forever. Every
 * case below checks that ambiguity resolves toward pulling MORE, never less.
 */

// ingestSquare imports the db client at module load; this suite only exercises
// pure functions, so the client is stubbed rather than used.
jest.mock('../../../db', () => ({ supabase: { from: () => ({}) } }));

import {
  ordersStartAt,
  ORDERS_OVERLAP_MS,
  FIRST_SYNC_LOOKBACK_MS,
} from '../ingestSquare';

const ms = (iso: string) => new Date(iso).getTime();

describe('ordersStartAt', () => {
  it('resumes one overlap window before the watermark', () => {
    const watermark = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

    const start = ordersStartAt(watermark);

    expect(ms(start)).toBe(ms(watermark) - ORDERS_OVERLAP_MS);
  });

  it('returns an RFC 3339 string Square accepts', () => {
    const start = ordersStartAt(new Date().toISOString());

    // toISOString is RFC 3339; round-tripping proves it parses.
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isFinite(ms(start))).toBe(true);
  });

  it('bounds a first sync instead of walking all history', () => {
    // A null watermark is a restaurant that has never completed a sync. An
    // unbounded pull here can exceed the page cap on every attempt, and a first
    // sync that never succeeds never writes a watermark, so it stays stuck.
    const before = Date.now();
    const start = ms(ordersStartAt(null));
    const after = Date.now();

    expect(start).toBeGreaterThanOrEqual(before - FIRST_SYNC_LOOKBACK_MS);
    expect(start).toBeLessThanOrEqual(after - FIRST_SYNC_LOOKBACK_MS);
  });

  it('treats an unparseable watermark as a first sync, not as the epoch', () => {
    // new Date('nonsense').getTime() is NaN. Falling through to a raw
    // subtraction would produce an Invalid Date, and coercing NaN to 0 would
    // resume from 1970, which is the unbounded walk this policy prevents.
    const start = ms(ordersStartAt('not-a-timestamp'));

    expect(Number.isFinite(start)).toBe(true);
    expect(start).toBeGreaterThan(Date.now() - FIRST_SYNC_LOOKBACK_MS - 60_000);
  });

  it('clamps a future watermark so ingestion cannot silently stop', () => {
    // Clock skew between us and Square can put last_success_at ahead of now.
    // Asking for orders closed after now returns nothing, every tick, forever.
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const start = ms(ordersStartAt(future));

    expect(start).toBeLessThanOrEqual(Date.now() - ORDERS_OVERLAP_MS);
  });

  it('never returns a start time in the future for any input', () => {
    const inputs = [
      null,
      'not-a-timestamp',
      new Date().toISOString(),
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date(0).toISOString(),
    ];

    for (const input of inputs) {
      expect(ms(ordersStartAt(input))).toBeLessThan(Date.now());
    }
  });
});
