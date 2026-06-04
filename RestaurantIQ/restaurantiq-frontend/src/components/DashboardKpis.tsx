import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useRestaurant } from './restaurant/RestaurantContext';
import Icon, { IconName } from './Icons';

interface RevenueTrendPoint {
  date: string;
  revenue_cents: number;
}
interface HourlyPoint {
  day: number;
  hour: number;
  revenue_cents: number;
  orders: number;
}
interface AnalyticsDashboard {
  revenueTrend: RevenueTrendPoint[];
  hourlyDistribution: HourlyPoint[];
}

interface Kpi {
  label: string;
  value: string;
  icon: IconName;
}

const dollars = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const dollarsCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const KpiCard = ({ kpi }: { kpi: Kpi }) => (
  <div className="bg-surface border border-line rounded shadow-sm p-[18px]">
    <div className="w-9 h-9 rounded-[9px] bg-navy-50 text-navy-700 flex items-center justify-center mb-[14px]">
      <Icon name={kpi.icon} size={19} />
    </div>
    <div className="text-[11px] font-bold tracking-[0.07em] uppercase text-ink-3">{kpi.label}</div>
    <div className="mt-2 text-[26px] font-extrabold tracking-[-0.02em] text-ink tnum">{kpi.value}</div>
  </div>
);

/**
 * Four KPI stat cards for the dashboard. Values are derived from the same
 * analytics + menu-item endpoints the rest of the app uses. We intentionally
 * do NOT show week-over-week deltas: the backend exposes no previous-period
 * comparison, so a "+8.4%" here would be fabricated.
 */
const DashboardKpis = () => {
  const { restaurant } = useRestaurant();
  const [kpis, setKpis] = useState<Kpi[] | null>(null);

  useEffect(() => {
    if (!restaurant) return;
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const [analyticsRes, itemsRes] = await Promise.all([
          apiFetch('/api/analytics/dashboard', { signal: controller.signal }),
          apiFetch(`/api/restaurants/${restaurant.id}/menu-items`, { signal: controller.signal }),
        ]);
        const analyticsBody = (await analyticsRes.json()) as { data: AnalyticsDashboard | null };
        const itemsBody = (await itemsRes.json()) as { data: unknown[] | null };
        if (cancelled) return;

        const trend = analyticsBody.data?.revenueTrend ?? [];
        const hours = analyticsBody.data?.hourlyDistribution ?? [];
        const itemCount = itemsBody.data?.length ?? 0;

        const revenue = trend.reduce((s, p) => s + p.revenue_cents, 0);
        const orders = hours.reduce((s, p) => s + p.orders, 0);
        const aov = orders > 0 ? revenue / orders : 0;

        if (revenue === 0 && orders === 0 && itemCount === 0) {
          setKpis([]); // nothing to show — table renders its own empty state
          return;
        }

        setKpis([
          { label: '30-Day Revenue', value: dollars(revenue), icon: 'margins' },
          { label: 'Orders', value: orders.toLocaleString('en-US'), icon: 'analytics' },
          { label: 'Avg. Order Value', value: dollarsCents(aov), icon: 'dashboard' },
          { label: 'Items Tracked', value: itemCount.toLocaleString('en-US'), icon: 'integrations' },
        ]);
      } catch {
        if (!cancelled) setKpis([]); // peripheral — fail quietly
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [restaurant]);

  if (!kpis || kpis.length === 0) return null;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-[22px]">
      {kpis.map((k) => (
        <KpiCard key={k.label} kpi={k} />
      ))}
    </div>
  );
};

export default DashboardKpis;
