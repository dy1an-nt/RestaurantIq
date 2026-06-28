import { useCallback, useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { apiFetch } from '../lib/api';
import { formatCents } from '../lib/format';
import EmptyState from '../components/EmptyState';

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

interface MissingCostItem {
  id: string;
  name: string;
  price_cents: number;
}

interface MarginSummary {
  averageMarginPercent: number;
  totalProfitCents: number;
  worstItem: { name: string; margin_percent: number } | null;
  bestItem: { name: string; margin_percent: number } | null;
  analyzedItems: number;
  missingCosts: number;
  negativeMarginItems: number;
  healthyItems: number;
}

interface MarginsData {
  summary: MarginSummary;
  negativeMarginItems: MarginItem[];
  repricingCandidates: MarginItem[];
  lowVelocityPremiumItems: MarginItem[];
  healthyPerformers: MarginItem[];
  missingCostItems: MissingCostItem[];
}

const fmt = formatCents;
const fmtPct = (pct: number) => `${pct.toFixed(1)}%`;

const marginColorClass = (pct: number): string => {
  if (pct < 0) return 'text-red-600';
  if (pct < 25) return 'text-yellow-600';
  if (pct < 50) return 'text-ink';
  return 'text-green-600';
};

interface CategorySectionProps {
  title: string;
  description: string;
  items: MarginItem[];
  accent: 'red' | 'yellow' | 'green' | 'navy';
  emptyText: string;
}

const accentBorderClass: Record<CategorySectionProps['accent'], string> = {
  red: 'border-red-500',
  yellow: 'border-yellow-400',
  green: 'border-green-500',
  navy: 'border-navy-500',
};

const accentBadgeClass: Record<CategorySectionProps['accent'], string> = {
  red: 'bg-red-100 text-red-700',
  yellow: 'bg-yellow-100 text-yellow-700',
  green: 'bg-green-100 text-green-700',
  navy: 'bg-navy-100 text-navy-800',
};

const CategorySection = ({ title, description, items, accent, emptyText }: CategorySectionProps) => (
  <div className="bg-surface border border-line rounded overflow-hidden">
    <div className={`px-6 py-4 border-l-4 ${accentBorderClass[accent]} flex items-start justify-between`}>
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="text-sm text-ink-3 mt-0.5">{description}</p>
      </div>
      <span className={`text-xs font-medium px-2 py-1 rounded-full ${accentBadgeClass[accent]}`}>
        {items.length} items
      </span>
    </div>
    {items.length === 0 ? (
      <p className="px-6 py-6 text-sm text-ink-3">{emptyText}</p>
    ) : (
      <table className="w-full text-left">
        <thead>
          <tr className="bg-canvas">
            <th className="px-4 py-2 text-xs font-medium text-ink-3 uppercase tracking-wide">Item</th>
            <th className="px-4 py-2 text-xs font-medium text-ink-3 uppercase tracking-wide">Category</th>
            <th className="px-4 py-2 text-xs font-medium text-ink-3 uppercase tracking-wide">Price</th>
            <th className="px-4 py-2 text-xs font-medium text-ink-3 uppercase tracking-wide">Cost</th>
            <th className="px-4 py-2 text-xs font-medium text-ink-3 uppercase tracking-wide">Margin</th>
            <th className="px-4 py-2 text-xs font-medium text-ink-3 uppercase tracking-wide">30d Orders</th>
            <th className="px-4 py-2 text-xs font-medium text-ink-3 uppercase tracking-wide">30d Profit</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t border-line hover:bg-canvas">
              <td className="px-4 py-3 text-sm font-medium text-ink">{item.name}</td>
              <td className="px-4 py-3 text-sm text-ink-3">{item.category}</td>
              <td className="px-4 py-3 text-sm text-ink-2">{fmt(item.price_cents)}</td>
              <td className="px-4 py-3 text-sm text-ink-2">{fmt(item.cost_cents)}</td>
              <td className={`px-4 py-3 text-sm font-semibold ${marginColorClass(item.margin_percent)}`}>
                {fmtPct(item.margin_percent)}
              </td>
              <td className="px-4 py-3 text-sm text-ink-2">{item.orders_30d}</td>
              <td className="px-4 py-3 text-sm text-ink-2">{fmt(item.profit_30d_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

/**
 * `embedded` is set when this renders inside the consolidated Margins tab shell,
 * which owns the page title — so the component suppresses its own <h1> header to
 * avoid a duplicate title. Standalone (legacy /margins direct) it shows its own.
 */
const MarginAnalysis = ({ embedded = false }: { embedded?: boolean }) => {
  const [data, setData] = useState<MarginsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMargins = useCallback(async (signal: AbortSignal) => {
    const res = await apiFetch('/api/analytics/margins', { signal });
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
    data.missingCostItems.length === 0 &&
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
      {!embedded && (
        <header>
          <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">Margin Analysis</h1>
          <p className="mt-[5px] text-[13.5px] font-medium text-ink-3">
            Profitability by item — margins, repricing opportunities, and top contributors
          </p>
        </header>
      )}

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!error && isEmpty && (
        <EmptyState
          icon="margins"
          title="No margin data yet"
          description="Add cost data to your menu items to see profitability analysis. Costs are entered from the Dashboard menu table."
          action={{ label: 'Add cost data', to: '/' }}
        />
      )}

      {!error && data && !isEmpty && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-surface border border-line rounded p-5">
              <p className="text-xs font-medium text-ink-3 uppercase tracking-wide">Average Margin</p>
              <p className={`text-2xl font-bold mt-1 ${averageMarginColor}`}>
                {fmtPct(data.summary.averageMarginPercent)}
              </p>
            </div>

            <div className="bg-surface border border-line rounded p-5">
              <p className="text-xs font-medium text-ink-3 uppercase tracking-wide">30-Day Profit</p>
              <p className="text-2xl font-bold mt-1 text-ink">
                {fmt(data.summary.totalProfitCents)}
              </p>
            </div>

            <div className="bg-surface border border-line rounded p-5">
              <p className="text-xs font-medium text-ink-3 uppercase tracking-wide">Top Margin Item</p>
              <p className="text-lg font-bold mt-1 text-ink truncate">
                {data.summary.bestItem?.name ?? '—'}
              </p>
              {data.summary.bestItem && (
                <p className={`text-sm font-medium ${marginColorClass(data.summary.bestItem.margin_percent)}`}>
                  {fmtPct(data.summary.bestItem.margin_percent)}
                </p>
              )}
            </div>

            <div className="bg-surface border border-line rounded p-5">
              <p className="text-xs font-medium text-ink-3 uppercase tracking-wide">Worst Margin Item</p>
              <p className="text-lg font-bold mt-1 text-ink truncate">
                {data.summary.worstItem?.name ?? '—'}
              </p>
              {data.summary.worstItem && (
                <p className="text-sm text-red-600 font-medium">
                  {fmtPct(data.summary.worstItem.margin_percent)}
                </p>
              )}
            </div>

            <div className="bg-surface border border-line rounded p-5">
              <p className="text-xs font-medium text-ink-3 uppercase tracking-wide">Missing Costs</p>
              <p
                className={`text-2xl font-bold mt-1 ${
                  data.summary.missingCosts > 0 ? 'text-yellow-600' : 'text-ink'
                }`}
              >
                {data.summary.missingCosts}
              </p>
              <p className="text-xs text-ink-3 mt-1">items without cost data</p>
            </div>
          </div>

          <div className="bg-surface border border-line rounded p-6">
            <h2 className="text-lg font-semibold text-ink mb-4">
              Top Items by Profit Contribution (30d)
            </h2>
            {chartData.length === 0 ? (
              <p className="text-sm text-ink-3 text-center py-8">No profit data available</p>
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
                  <Bar dataKey="profit" fill="#1e3a5f" radius={[0, 4, 4, 0]} />
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
            accent="navy"
            emptyText="No underexposed premium items found."
          />

          <CategorySection
            title="Healthy Performers"
            description="High-margin, high-volume items — your core profitability drivers. Worth protecting and promoting."
            items={data.healthyPerformers}
            accent="green"
            emptyText="Not enough data to identify healthy performers yet."
          />

          {data.missingCostItems.length > 0 && (
            <div className="bg-surface border border-line rounded overflow-hidden">
              <div className="px-6 py-4 border-l-4 border-gray-300 flex items-start justify-between">
                <div>
                  <h2 className="text-base font-semibold text-ink">Missing Cost Items</h2>
                  <p className="text-sm text-ink-3 mt-0.5">
                    Add item costs to unlock profitability analytics.
                  </p>
                </div>
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600">
                  {data.missingCostItems.length} items
                </span>
              </div>
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-canvas">
                    <th className="px-4 py-2 text-xs font-medium text-ink-3 uppercase tracking-wide">Item</th>
                    <th className="px-4 py-2 text-xs font-medium text-ink-3 uppercase tracking-wide">Price</th>
                    <th className="px-4 py-2 text-xs font-medium text-ink-3 uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.missingCostItems.map((item) => (
                    <tr key={item.id} className="border-t border-line hover:bg-canvas">
                      <td className="px-4 py-3 text-sm font-medium text-ink">{item.name}</td>
                      <td className="px-4 py-3 text-sm text-ink-2">{fmt(item.price_cents)}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600">
                          Cost Missing
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default MarginAnalysis;
