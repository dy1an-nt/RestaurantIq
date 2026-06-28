import { useEffect, useState } from 'react';
import { apiFetch } from './api';
import { useRestaurant } from '../components/restaurant/RestaurantContext';

/**
 * Data-freshness hook (Sprint R, review R8).
 *
 * Analytics in this app are computed from imported POS/delivery data, so a
 * number is only as trustworthy as the last successful sync. This hook reads
 * /api/integrations/sync-status and reduces the per-provider health into a
 * single freshness signal the data surfaces can show: when the data was last
 * refreshed, and whether it has gone stale.
 *
 * `isStale` is true when a provider is connected but its most recent successful
 * sync is missing or older than STALE_AFTER_HOURS — the case where a dashboard
 * would otherwise render silently empty or out-of-date with no explanation.
 */
const STALE_AFTER_HOURS = 24;

interface ProviderHealth {
  connected: boolean;
  last_success_at: string | null;
}

export interface SyncFreshness {
  loading: boolean;
  /** Any POS/delivery provider connected? If false, there's nothing to sync. */
  anyConnected: boolean;
  /** Most recent successful sync across connected providers, or null. */
  lastSyncedAt: string | null;
  /** Connected but never-synced or last success older than the stale window. */
  isStale: boolean;
}

export function useLastSynced(): SyncFreshness {
  const { restaurant } = useRestaurant();
  const [state, setState] = useState<SyncFreshness>({
    loading: true,
    anyConnected: false,
    lastSyncedAt: null,
    isStale: false,
  });

  useEffect(() => {
    if (!restaurant) return;
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await apiFetch('/api/integrations/sync-status', {
          signal: controller.signal,
        });
        const body = (await res.json()) as {
          data: Record<string, ProviderHealth> | null;
          error: string | null;
        };
        if (cancelled || !res.ok || !body.data) {
          if (!cancelled) setState((s) => ({ ...s, loading: false }));
          return;
        }

        const providers = Object.values(body.data);
        const connected = providers.filter((p) => p.connected);
        const successes = connected
          .map((p) => p.last_success_at)
          .filter((t): t is string => !!t)
          .sort();
        const lastSyncedAt = successes.length ? successes[successes.length - 1] : null;

        const ageMs = lastSyncedAt ? Date.now() - new Date(lastSyncedAt).getTime() : Infinity;
        const isStale =
          connected.length > 0 && ageMs > STALE_AFTER_HOURS * 60 * 60 * 1000;

        setState({
          loading: false,
          anyConnected: connected.length > 0,
          lastSyncedAt,
          isStale,
        });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [restaurant]);

  return state;
}
