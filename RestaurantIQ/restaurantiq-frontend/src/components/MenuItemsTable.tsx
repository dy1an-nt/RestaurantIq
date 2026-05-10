import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useRestaurant } from './restaurant/RestaurantContext';

interface MenuItem {
  id: string;
  name: string;
  category: string;
  price_cents: number;
  cost_cents: number;
  revenue_30d_cents: number;
  orders_30d: number;
  trend: 'up' | 'down' | 'flat';
}

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const TrendBadge = ({ trend }: { trend: MenuItem['trend'] }) => {
  if (trend === 'up') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">↑ Trending</span>;
  if (trend === 'down') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">↓ Declining</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">— Stable</span>;
};

interface RowProps { item: MenuItem; accent?: 'green' | 'red' }

const Row = ({ item, accent }: RowProps) => (
  <tr className={`hover:bg-indigo-50 transition-colors ${accent === 'green' ? 'border-l-4 border-green-500' : accent === 'red' ? 'border-l-4 border-red-400' : ''}`}>
    <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.name}</td>
    <td className="px-4 py-3 text-sm text-gray-500">{item.category}</td>
    <td className="px-4 py-3 text-sm text-gray-700">{fmt(item.price_cents)}</td>
    <td className="px-4 py-3 text-sm text-gray-700">{fmt(item.cost_cents)}</td>
    <td className="px-4 py-3 text-sm font-semibold text-gray-900">{fmt(item.revenue_30d_cents)}</td>
    <td className="px-4 py-3 text-sm text-gray-700">{item.orders_30d}</td>
    <td className="px-4 py-3"><TrendBadge trend={item.trend} /></td>
  </tr>
);

const SectionHeader = ({ label }: { label: string }) => (
  <tr>
    <td colSpan={7} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 bg-gray-50">
      {label}
    </td>
  </tr>
);

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-white rounded-xl shadow overflow-hidden">{children}</div>
);

const MenuItemsTable = () => {
  const { restaurant } = useRestaurant();
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!restaurant) return;
    let cancelled = false;
    const controller = new AbortController();
    setItems(null);
    setError(null);

    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError('Not signed in');
        return;
      }

      try {
        const res = await fetch(`/api/restaurants/${restaurant.id}/menu-items`, {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const body = await res.json();
        if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`);
        if (!cancelled) setItems(body.data as MenuItem[]);
      } catch (err: any) {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [restaurant]);

  if (error) {
    return <Shell><div className="px-4 py-8 text-sm text-red-600">Failed to load menu items: {error}</div></Shell>;
  }
  if (items === null) {
    return <Shell><div className="px-4 py-8 text-sm text-gray-500">Loading menu items…</div></Shell>;
  }
  if (items.length === 0) {
    return (
      <Shell>
        <div className="p-12 text-center">
          <p className="text-lg font-semibold text-gray-900">No menu items yet</p>
          <p className="text-sm text-gray-500 mt-2">
            Connect your Square POS and sync your catalog to see menu performance data.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            {restaurant?.pos_connected ? (
              <Link
                to="/integrations"
                className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-800"
              >
                Run sync
              </Link>
            ) : (
              <Link
                to="/integrations"
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700"
              >
                Connect Square
              </Link>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  const sorted = [...items].sort((a, b) => b.revenue_30d_cents - a.revenue_30d_cents);
  const topPerformers = sorted.slice(0, 4);
  const middle = sorted.slice(4, 7);
  const needsAttention = sorted.slice(7);

  return (
    <Shell>
      <table className="w-full text-left">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            {['Item Name', 'Category', 'Price', 'Cost', '30d Revenue', 'Orders', 'Trend'].map((h) => (
              <th key={h} className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {topPerformers.length > 0 && <SectionHeader label="⭐ Top Performers" />}
          {topPerformers.map((item) => <Row key={item.id} item={item} accent="green" />)}
          {middle.map((item) => <Row key={item.id} item={item} />)}
          {needsAttention.length > 0 && <SectionHeader label="⚠️ Needs Attention" />}
          {needsAttention.map((item) => <Row key={item.id} item={item} accent="red" />)}
        </tbody>
      </table>
    </Shell>
  );
};

export default MenuItemsTable;
