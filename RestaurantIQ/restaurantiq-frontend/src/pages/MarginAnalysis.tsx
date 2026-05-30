import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { supabase } from '../lib/supabase';

interface MarginItem {
  id: string;
  name: string;
  category: string;
  price_cents: number;
  cost_cents: number;
  profit_cents: number;
  margin_percent: number;
  orders_30d: number;
  revenue_30d_cents: number;
  profit_30d_cents: number;
}

interface MarginSummary {
  averageMarginPercent: number;
  totalProfitCents: number;
  worstItem: { name: string; margin_percent: number } | null;
  bestItem: { name: string; margin_percent: number } | null;
}

interface MarginsData {
  summary: MarginSummary;
  negativeMarginItems: MarginItem[];
  repricingCandidates: MarginItem[];
  lowVelocityPremiumItems: MarginItem[];
  healthyPerformers: MarginItem[];
}

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const fmtPct = (pct: number) => `${pct.toFixed(1)}%`;

const marginColorClass = (pct: number): string => {
  if (pct < 0) return 'text-red-600';
  if (pct < 25) return 'text-yellow-600';
  if (pct < 50) return 'text-gray-900';
  return 'text-green-600';
};

interface CategorySectionProps {
  title: string;
  description: string;
  items: MarginItem[];
  accent: 'red' | 'yellow' | 'green' | 'indigo';
  emptyText: string;
}

const accentBorderClass: Record<CategorySectionProps['accent'], string> = {
  red: 'border-red-500',
  yellow: 'border-yellow-400',
  green: 'border-green-500',
  indigo: 'border-indigo-500',
};

const accentBadgeClass: Record<CategorySectionProps['accent'], string> = {
  red: 'bg-red-100 text-red-700',
  yellow: 'bg-yellow-100 text-yellow-700',
  green: 'bg-green-100 text-green-700',
  indigo: 'bg-indigo-100 text-indigo-700',
};

const CategorySection = ({ title, description, items, accent, emptyText }: CategorySectionProps) => (
  <div className="bg-white rounded-xl shadow overflow-hidden">
    <div className={`px-6 py-4 border-l-4 ${accentBorderClass[accent]} flex items-start justify-between`}>
      <div>
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        <p className="text-sm text-gray-500 mt-0.5">{description}</p>
      </div>
      <span className={`text-xs font-medium px-2 py-1 rounded-full ${accentBadgeClass[accent]}`}>
        {items.length} items
      </span>
    </div>
    {items.length === 0 ? (
      <p className="px-6 py-6 text-sm text-gray-400">{emptyText}</p>
    ) : (
      <table className="w-full text-left">
        <thead>
          <tr className="bg-gray-50">
            <th className="px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">Item</th>
            <th className="px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">Category</th>
            <th className="px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">Price</th>
            <th className="px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">Cost</th>
            <th className="px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">Margin</th>
            <th className="px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">30d Orders</th>
            <th className="px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">30d Profit</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t border-gray-100 hover:bg-gray-50">
              <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.name}</td>
              <td className="px-4 py-3 text-sm text-gray-500">{item.category}</td>
              <td className="px-4 py-3 text-sm text-gray-700">{fmt(item.price_cents)}</td>
              <td className="px-4 py-3 text-sm text-gray-700">{fmt(item.cost_cents)}</td>
              <td className={`px-4 py-3 text-sm font-semibold ${marginColorClass(item.margin_percent)}`}>
                {fmtPct(item.margin_percent)}
              </td>
              <td className="px-4 py-3 text-sm text-gray-700">{item.orders_30d}</td>
              <td className="px-4 py-3 text-sm text-gray-700">{fmt(item.profit_30d_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

const MarginAnalysis = () => {
  const [data, setData] = useState<MarginsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMargins = useCallback(async (signal: AbortSignal) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');

    const res = await fetch('/api/analytics/margins', {
      signal,
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const body = await res.json() as { data: MarginsData; error: string | null };
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
        const result = await fetchMargins(controller.signal);
        if (!cancelled) setData(result);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load margin data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetchMargins]);

  if (loading) {
    return (
      <div className="max-w-5xl space-y-4">
        <div className="animate-pulse bg-gray-200 rounded h-24" />
        <div className="animate-pulse bg-gray-200 rounded h-24" />
        <div className="animate-pulse bg-gray-200 rounded h-24" />
      </div>
    );
  }

  const isEmpty =
    data !== null &&
    data.negativeMarginItems.length === 0 &&
    data.repricingCandidates.length === 0 &&
    data.lowVelocityPremiumItems.length === 0 &&
    data.healthyPerformers.length === 0 &&
    data.summary.totalProfitCents === 0 &&
    data.summary.averageMarginPercent === 0;

  const averageMarginColor =
    data && data.summary.averageMarginPercent > 40
      ? 'text-green-600'
      : data && data.summary.averageMarginPercent >= 20
      ? 'text-yellow-600'
      : 'text-red-600';

  const allItems: MarginItem[] = [];
  if (data) {
    const seen = new Set<string>();
    for (const item of [
      ...data.negativeMarginItems,
      ...data.repricingCandidates,
      ...data.lowVelocityPremiumItems,
      ...data.healthyPerformers,
    ]) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        allItems.push(item);
      }
    }
  }

  const chartData = allItems
    .filter((item) => item.profit_30d_cents > 0)
    .sort((a, b) => b.profit_30d_cents - a.profit_30d_cents)
    .slice(0, 10)
    .map((item) => ({ name: item.name, profit: item.profit_30d_cents }));

  return (
    <div className="max-w-5xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Margin Analysis</h1>
        <p className="text-sm text-gray-500 mt-1">
          Profitability by item — margins, repricing opportunities, and top contributors
        </p>
      </header>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!error && isEmpty && (
        <div className="bg-white rounded-xl shadow p-12 text-center">
          <p className="text-xl font-semibold text-gray-900">No margin data yet</p>
          <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto">
            Add cost data to your menu items to see profitability analysis. Costs are entered
            from the Dashboard menu table.
          </p>
          <Link
            to="/"
            className="inline-flex items-center mt-6 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700"
          >
            Add cost data to your menu items
          </Link>
        </div>
      )}

      {!error && data && !isEmpty && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl shadow p-5">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Average Margin</p>
              <p className={`text-2xl font-bold mt-1 ${averageMarginColor}`}>
                {fmtPct(data.summary.averageMarginPercent)}
              </p>
            </div>

            <div className="bg-white rounded-xl shadow p-5">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">30-Day Profit</p>
              <p className="text-2xl font-bold mt-1 text-gray-900">
                {fmt(data.summary.totalProfitCents)}
              </p>
            </div>

            <div className="bg-white rounded-xl shadow p-5">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Top Margin Item</p>
              <p className="text-lg font-bold mt-1 text-gray-900 truncate">
                {data.summary.bestItem?.name ?? '—'}
              </p>
              {data.summary.bestItem && (
                <p className={`text-sm font-medium ${marginColorClass(data.summary.bestItem.margin_percent)}`}>
                  {fmtPct(data.summary.bestItem.margin_percent)}
                </p>
              )}
            </div>

            <div className="bg-white rounded-xl shadow p-5">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Worst Margin Item</p>
              <p className="text-lg font-bold mt-1 text-gray-900 truncate">
                {data.summary.worstItem?.name ?? '—'}
              </p>
              {data.summary.worstItem && (
                <p className="text-sm text-red-600 font-medium">
                  {fmtPct(data.summary.worstItem.margin_percent)}
                </p>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              Top Items by Profit Contribution (30d)
            </h2>
            {chartData.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No profit data available</p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  layout="vertical"
                  data={chartData}
                  margin={{ left: 16, right: 24, top: 8, bottom: 8 }}
                >
                  <XAxis
                    type="number"
                    tickFormatter={(v: number) => `$${(v / 100).toFixed(0)}`}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={140}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip formatter={(v) => fmt(Number(v))} />
                  <Bar dataKey="profit" fill="#4f46e5" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <CategorySection
            title="Negative Margin Items"
            description="These items cost more than they sell for — fix pricing or costs immediately."
            items={data.negativeMarginItems}
            accent="red"
            emptyText="No negative-margin items detected."
          />

          <CategorySection
            title="Repricing Candidates"
            description="High-demand items with thin margins — small price increases likely have low customer resistance."
            items={data.repricingCandidates}
            accent="yellow"
            emptyText="No obvious repricing opportunities identified."
          />

          <CategorySection
            title="Low Visibility Premium Items"
            description="High-margin items with low sales — consider featuring on menus, promotions, or staff recommendations."
            items={data.lowVelocityPremiumItems}
            accent="indigo"
            emptyText="No underexposed premium items found."
          />

          <CategorySection
            title="Healthy Performers"
            description="High-margin, high-volume items — your core profitability drivers. Worth protecting and promoting."
            items={data.healthyPerformers}
            accent="green"
            emptyText="Not enough data to identify healthy performers yet."
          />
        </>
      )}
    </div>
  );
};

export default MarginAnalysis;
