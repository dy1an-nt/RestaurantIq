import { z } from 'zod';

/**
 * Single source of truth for the analytics dashboard's selectable time
 * windows and the boundary math behind them.
 *
 * The `days=N` query param must resolve to the SAME [from, to] range no
 * matter which downstream query consumes it (orders' timestamp filter,
 * daily_summaries' date filter). Before this existed, /api/analytics/dashboard
 * derived `from` twice — once as a date string for daily_summaries, once as a
 * timestamp offset for orders — and the two could disagree, which silently
 * narrowed hourlyDistribution relative to revenueTrend and skewed AOV. Every
 * caller must go through resolveWindow() instead of computing dates inline.
 */
export const ALLOWED_WINDOW_DAYS = [7, 30, 90] as const;
export type WindowDays = (typeof ALLOWED_WINDOW_DAYS)[number];

export const windowQuerySchema = z
  .object({
    days: z.coerce
      .number()
      .int()
      .refine((n): n is WindowDays => (ALLOWED_WINDOW_DAYS as readonly number[]).includes(n), {
        message: `days must be one of ${ALLOWED_WINDOW_DAYS.join(', ')}`,
      })
      .default(30),
  })
  .strict();

export interface ResolvedWindow {
  /** The resolved window size in days (echoes the default when omitted). */
  days: WindowDays;
  /** UTC date (YYYY-MM-DD) of the start of the window, inclusive. */
  from: string;
  /** UTC date (YYYY-MM-DD) of the end of the window, inclusive — always "today". */
  to: string;
  /** `from` as a UTC midnight ISO timestamp, for timestamp-column filters. */
  fromIso: string;
}

const toUtcDateString = (d: Date): string => d.toISOString().split('T')[0];

/**
 * Resolve a window size into concrete UTC date boundaries. Pure — no clock
 * reads, no I/O — so it is trivially unit-testable and deterministic under
 * test with an injected `now`.
 *
 * A `days=7` window is 7 calendar days INCLUSIVE of today: `from` is
 * `now - (days - 1)` days, not `now - days` days.
 */
export const resolveWindow = (days: WindowDays, now: Date): ResolvedWindow => {
  const to = toUtcDateString(now);
  const fromDate = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const from = toUtcDateString(fromDate);
  return {
    days,
    from,
    to,
    fromIso: `${from}T00:00:00.000Z`,
  };
};
