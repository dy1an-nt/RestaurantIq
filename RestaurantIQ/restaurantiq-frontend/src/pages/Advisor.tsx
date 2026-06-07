import { useState, useEffect } from 'react';
import { useAuth } from '../components/auth/AuthContext';
import { getForecast, refreshForecast, ForecastResult } from '../lib/advisorApi';
import ForecastTable from '../components/advisor/ForecastTable';
import NarrativePanel from '../components/advisor/NarrativePanel';
import InsufficientHistoryList from '../components/advisor/InsufficientHistoryList';
import Icon from '../components/Icons';

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function isStale(iso: string) {
  return Date.now() - new Date(iso).getTime() > 48 * 60 * 60 * 1000;
}

export default function Advisor() {
  const { session } = useAuth();
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    getForecast(session)
      .then((f) => { if (!cancelled) { setForecast(f); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load forecast');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [session]);

  async function handleRefresh() {
    if (!session) return;
    setRefreshing(true);
    setError(null);
    try {
      const f = await refreshForecast(session);
      setForecast(f);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to generate forecast');
    } finally {
      setRefreshing(false);
    }
  }

  const hasData = forecast && forecast.items.length > 0;
  const stale = forecast?.generated_at && isStale(forecast.generated_at);

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Purchasing Advisor</h1>
          {forecast?.generated_at && (
            <p className="text-sm text-gray-400 mt-0.5">Last updated {relativeTime(forecast.generated_at)}</p>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors"
        >
          {refreshing ? (
            <>
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Generating…
            </>
          ) : (
            <>
              <Icon name="sync" size={15} />
              Refresh forecast
            </>
          )}
        </button>
      </div>

      {stale && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-700">
          <Icon name="attention" size={16} />
          Data may be out of date — sync your POS to refresh
        </div>
      )}

      {error && (
        <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-600">{error}</div>
      )}

      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">Loading…</div>
      ) : !hasData ? (
        <div className="py-16 flex flex-col items-center justify-center text-center bg-white rounded-xl border border-gray-200">
          <Icon name="advisor" size={40} className="text-gray-200 mb-3" />
          <p className="text-sm text-gray-500 font-medium mb-1">No forecast yet</p>
          <p className="text-xs text-gray-400 max-w-xs">
            Click Refresh to generate your first purchasing plan. You need at least 14 days of sales history.
          </p>
        </div>
      ) : (
        <>
          <ForecastTable items={forecast!.items} />
          <InsufficientHistoryList items={forecast!.insufficient_history_items ?? []} />
          <NarrativePanel narrative={forecast!.narrative} isLoading={refreshing} />
        </>
      )}
    </div>
  );
}
