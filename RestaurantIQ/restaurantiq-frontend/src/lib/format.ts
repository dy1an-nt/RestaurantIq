/**
 * Money formatting (Sprint R, review M3).
 *
 * Every monetary value in this app is stored and passed as integer cents and
 * formatted for display only (see CLAUDE.md conventions). Before this file, the
 * "cents → string" helper was redefined in ~9 components, each subtly different
 * (some added thousands separators, some didn't). That meant changing the money
 * format required editing nine files — or, more likely, missing one. These are
 * the single source of truth.
 *
 * Inputs are integer cents. `formatCents` is the default for any exact amount;
 * `formatDollars` is for compact KPI/headline figures where cents are noise.
 */

/** `123456` → `"$1,234.56"`. Exact amount, thousands-separated, always 2dp. */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

/** `123456` → `"$1,235"`. Rounded to whole dollars for headline/KPI display. */
export function formatDollars(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/**
 * Human-readable "x ago" for an ISO timestamp (or `null`). Centralized here
 * because the same helper had been copy-pasted into several pages. Used by the
 * "Last synced" indicators so every data surface phrases freshness identically.
 */
export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
