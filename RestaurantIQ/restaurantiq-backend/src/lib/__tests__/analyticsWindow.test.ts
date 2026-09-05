import { resolveWindow, windowQuerySchema } from '../analyticsWindow';

describe('resolveWindow', () => {
  it('a 7-day window is 7 calendar days inclusive of today', () => {
    const now = new Date('2026-09-05T15:30:00.000Z');
    const w = resolveWindow(7, now);
    expect(w.to).toBe('2026-09-05');
    expect(w.from).toBe('2026-08-30'); // today + 6 days back = 7 days total
    expect(w.days).toBe(7);
    expect(w.fromIso).toBe('2026-08-30T00:00:00.000Z');
  });

  it('a 30-day window counts 30 calendar days inclusive', () => {
    const now = new Date('2026-09-05T00:00:00.000Z');
    const w = resolveWindow(30, now);
    expect(w.to).toBe('2026-09-05');
    expect(w.from).toBe('2026-08-07');
  });

  it('a 90-day window counts 90 calendar days inclusive', () => {
    const now = new Date('2026-09-05T00:00:00.000Z');
    const w = resolveWindow(90, now);
    expect(w.from).toBe('2026-06-08');
    expect(w.to).toBe('2026-09-05');
  });

  it('rolls over a month boundary correctly', () => {
    const now = new Date('2026-03-02T12:00:00.000Z');
    const w = resolveWindow(7, now);
    expect(w.to).toBe('2026-03-02');
    expect(w.from).toBe('2026-02-24');
  });

  it('rolls over a year boundary correctly', () => {
    const now = new Date('2026-01-02T12:00:00.000Z');
    const w = resolveWindow(7, now);
    expect(w.to).toBe('2026-01-02');
    expect(w.from).toBe('2025-12-27');
  });

  it('formats dates in UTC regardless of the instant time-of-day', () => {
    const lateUtc = resolveWindow(7, new Date('2026-09-05T23:59:59.999Z'));
    const earlyUtc = resolveWindow(7, new Date('2026-09-05T00:00:00.000Z'));
    expect(lateUtc.to).toBe('2026-09-05');
    expect(earlyUtc.to).toBe('2026-09-05');
    expect(lateUtc.from).toBe(earlyUtc.from);
  });
});

describe('windowQuerySchema', () => {
  it('defaults to 30 when days is omitted', () => {
    const result = windowQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.days).toBe(30);
  });

  it.each([7, 30, 90])('accepts the allowed value %i as a string (query params are strings)', (n) => {
    const result = windowQuerySchema.safeParse({ days: String(n) });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.days).toBe(n);
  });

  it('rejects a value outside {7, 30, 90}', () => {
    const result = windowQuerySchema.safeParse({ days: '14' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric value', () => {
    const result = windowQuerySchema.safeParse({ days: 'abc' });
    expect(result.success).toBe(false);
  });

  it('rejects a negative value', () => {
    const result = windowQuerySchema.safeParse({ days: '-7' });
    expect(result.success).toBe(false);
  });

  it('rejects an array (Express parses ?days=7&days=90 into an array)', () => {
    const result = windowQuerySchema.safeParse({ days: ['7', '90'] });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown query key via .strict()', () => {
    const result = windowQuerySchema.safeParse({ day: '90' });
    // day=90 is unknown; days is absent so it would default, but .strict()
    // must reject the unrecognized key rather than silently ignoring it.
    expect(result.success).toBe(false);
  });
});
