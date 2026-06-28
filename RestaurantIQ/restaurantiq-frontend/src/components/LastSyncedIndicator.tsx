import { useLastSynced } from '../lib/useLastSynced';
import { relativeTime } from '../lib/format';

/**
 * "Last synced X ago" freshness chip for data surfaces (Sprint R, review R8).
 *
 * Turns the silent-empty / silently-stale failure mode into an understood one:
 * a fresh dataset shows when it last refreshed; a stale one (connected but no
 * successful sync in 24h, or never) shows an amber warning so the owner knows
 * the numbers may lag their POS rather than concluding the product is broken.
 *
 * Renders nothing while loading or when no provider is connected — in the
 * not-connected case the page's own "connect an integration" prompt is the
 * right call to action, not a freshness chip.
 */
const LastSyncedIndicator = () => {
  const { loading, anyConnected, lastSyncedAt, isStale } = useLastSynced();

  if (loading || !anyConnected) return null;

  if (isStale) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-1 text-[12px] font-semibold text-amber-700">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        Data may be out of date — last synced {relativeTime(lastSyncedAt)}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-3">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
      Last synced {relativeTime(lastSyncedAt)}
    </div>
  );
};

export default LastSyncedIndicator;
