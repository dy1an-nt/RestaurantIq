import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
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
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');

    const res = await fetch('/api/analytics/dashboard', {
      signal,
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
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
    <div className="max-w-5xl space-y-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
        <p className="text-sm text-gray-500 mt-1">
          Revenue · Top Items · Busiest Hours · Last 30 days
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && dashboard && dashboard.revenueTrend.length === 0 && dashboard.topItems.length === 0 && dashboard.hourlyDistribution.length === 0 ? (
        <div className="bg-white rounded-xl shadow p-12 text-center">
          <p className="text-xl font-semibold text-gray-900">No analytics data yet</p>
          <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto">
            Sync your Square catalog and orders to start seeing revenue trends and top performers.
          </p>
          <Link
            to="/integrations"
            className="inline-flex items-center mt-6 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700"
          >
            Go to Integrations
          </Link>
        </div>
      ) : (
        <>
          {/* Revenue Trend */}
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Revenue Trend</h2>
            <RevenueTrendChart
              data={dashboard?.revenueTrend}
              loading={loading}
            />
          </div>

          {/* Top Items */}
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Items by Revenue</h2>
            <TopItemsChart
              data={dashboard?.topItems}
              loading={loading}
            />
          </div>

          {/* Heatmap */}
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Busiest Sales Hours</h2>
            <SalesHeatmap data={dashboard?.hourlyDistribution} loading={loading} />
          </div>
        </>
      )}
    </div>
  );
};

export default Analytics;
