import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import RevenueTrendChart from '../components/charts/RevenueTrendChart';
import TopItemsChart from '../components/charts/TopItemsChart';
import SalesHeatmap from '../components/charts/SalesHeatmap';

interface RevenueTrendPoint {
  date: string;
  revenue_cents: number;
}

interface TopItemPoint {
  item_id: string;
  name: string;
  category: string;
  revenue_cents: number;
  orders: number;
}

interface HourlyPoint {
  day: number;
  hour: number;
  revenue_cents: number;
  orders: number;
}

interface AnalyticsDashboard {
  revenueTrend: RevenueTrendPoint[];
  topItems: TopItemPoint[];
  hourlyDistribution: HourlyPoint[];
}

const Analytics = () => {
  const [dashboard, setDashboard] = useState<AnalyticsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(async (signal: AbortSignal) => {
    const res = await apiFetch('/api/analytics/dashboard', { signal });
    const body = await res.json() as { data: AnalyticsDashboard; error: string | null };
    if (!res.ok || body.error) throw new Error(body.error ?? `Request failed (${res.status})`);
    return body.data;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const data = await fetchDashboard(controller.signal);
        if (!cancelled) setDashboard(data);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetchDashboard]);

  return (
    <div className="max-w-5xl">
      <div className="mb-[22px]">
        <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">Analytics</h1>
        <p className="mt-[5px] text-[13.5px] font-medium text-ink-3">
          Revenue · Top items · Busiest hours · Last 30 days
        </p>
      </div>

      {error && (
        <div className="rounded-sm bg-neg-bg border border-neg/30 px-4 py-3 text-sm text-neg mb-[18px]">
          {error}
        </div>
      )}

      {!loading && !error && dashboard && dashboard.revenueTrend.length === 0 && dashboard.topItems.length === 0 && dashboard.hourlyDistribution.length === 0 ? (
        <div className="bg-surface border border-line rounded shadow-sm p-12 text-center">
          <p className="text-xl font-extrabold text-ink">No analytics data yet</p>
          <p className="text-sm text-ink-3 mt-2 max-w-md mx-auto">
            Sync your Square catalog and orders to start seeing revenue trends and top performers.
          </p>
          <Link
            to="/integrations"
            className="inline-flex items-center mt-6 px-4 h-[46px] bg-navy-700 text-white text-sm font-bold rounded-[9px] hover:bg-navy-800 transition-colors"
          >
            Go to Integrations
          </Link>
        </div>
      ) : (
        <div className="grid gap-[18px]">
          {/* Revenue Trend — full width */}
          <div className="bg-surface border border-line rounded px-[22px] py-5">
            <div className="flex items-baseline justify-between gap-3 mb-1.5">
              <h2 className="text-base font-bold text-ink whitespace-nowrap">Revenue Trend</h2>
            </div>
            <div className="flex gap-4 my-2.5 text-xs font-semibold text-ink-2">
              <span className="inline-flex items-center gap-[7px]">
                <i className="inline-block w-[14px] h-[3px] rounded-sm bg-navy-700" /> This period
              </span>
            </div>
            <RevenueTrendChart data={dashboard?.revenueTrend} loading={loading} />
          </div>

          {/* Top items | Busiest hours */}
          <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-[18px]">
            <div className="bg-surface border border-line rounded px-[22px] py-5">
              <h2 className="text-base font-bold text-ink mb-1.5">Top Items by Revenue</h2>
              <TopItemsChart data={dashboard?.topItems} loading={loading} />
            </div>
            <div className="bg-surface border border-line rounded px-[22px] py-5">
              <h2 className="text-base font-bold text-ink mb-1.5">Busiest Hours</h2>
              <SalesHeatmap data={dashboard?.hourlyDistribution} loading={loading} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Analytics;
