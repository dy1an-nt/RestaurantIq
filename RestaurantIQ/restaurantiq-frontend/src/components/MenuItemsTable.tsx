import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useRestaurant } from './restaurant/RestaurantContext';
import EditMenuItemModal, { MenuItemPatch } from './EditMenuItemModal';

interface MenuItem {
  id: string;
  name: string;
  category: string | null;
  price_cents: number;
  cost_cents: number | null;
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

const MissingCostBadge = () => (
  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
    Cost Missing
  </span>
);

interface RowProps {
  item: MenuItem;
  accent?: 'green' | 'red';
  savedItemId: string | null;
  onEdit: (item: MenuItem) => void;
}

const Row = ({ item, accent, savedItemId, onEdit }: RowProps) => (
  <tr className={`hover:bg-indigo-50 transition-colors group ${accent === 'green' ? 'border-l-4 border-green-500' : accent === 'red' ? 'border-l-4 border-red-400' : ''}`}>
    <td className="px-4 py-3 text-sm font-medium text-gray-900">
      <span>{item.name}</span>
      {savedItemId === item.id && (
        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
          Saved
        </span>
      )}
    </td>
    <td className="px-4 py-3 text-sm text-gray-500">{item.category ?? '—'}</td>
    <td className="px-4 py-3 text-sm text-gray-700">{fmt(item.price_cents)}</td>
    <td className="px-4 py-3 text-sm text-gray-700">
      {item.cost_cents === null ? <MissingCostBadge /> : fmt(item.cost_cents)}
    </td>
    <td className="px-4 py-3 text-sm font-semibold text-gray-900">{fmt(item.revenue_30d_cents)}</td>
    <td className="px-4 py-3 text-sm text-gray-700">{item.orders_30d}</td>
    <td className="px-4 py-3"><TrendBadge trend={item.trend} /></td>
    <td className="px-4 py-3 text-right">
      <button
        onClick={() => onEdit(item)}
        className="opacity-0 group-hover:opacity-100 focus:opacity-100 px-3 py-1 bg-white border border-gray-300 text-xs font-medium text-gray-700 rounded-md hover:bg-gray-50 transition-opacity"
      >
        Edit
      </button>
    </td>
  </tr>
);

const SectionHeader = ({ label, colSpan }: { label: string; colSpan: number }) => (
  <tr>
    <td colSpan={colSpan} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 bg-gray-50">
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
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [savedItemId, setSavedItemId] = useState<string | null>(null);

  useEffect(() => {
    if (!restaurant) return;
    let cancelled = false;
    const controller = new AbortController();
    setItems(null);
    setError(null);

    (async () => {
      try {
        const res = await apiFetch(`/api/restaurants/${restaurant.id}/menu-items`, {
          signal: controller.signal,
        });
        const body = await res.json();
        if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`);
        if (!cancelled) setItems(body.data as MenuItem[]);
      } catch (err: unknown) {
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : 'Failed to load menu items');
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [restaurant]);

  const handleSaved = (updated: MenuItemPatch) => {
    setItems((prev) => {
      if (!prev) return prev;
      return prev.map((row) => {
        if (row.id !== updated.id) return row;
        // Merge only the fields the API returns; keep local analytics fields intact
        return {
          ...row,
          name: updated.name,
          category: updated.category,
          cost_cents: updated.cost_cents,
        };
      });
    });
    setEditingItem(null);
    // Show "Saved" pill on the row for 2 seconds
    setSavedItemId(updated.id);
    setTimeout(() => setSavedItemId((prev) => (prev === updated.id ? null : prev)), 2000);
  };

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

  const missingCostCount = items.filter((i) => i.cost_cents === null).length;

  const sorted = [...items].sort((a, b) => b.revenue_30d_cents - a.revenue_30d_cents);
  const topPerformers = sorted.slice(0, 4);
  const middle = sorted.slice(4, 7);
  const needsAttention = sorted.slice(7);

  const colSpan = 8;

  return (
    <>
      {missingCostCount > 0 && (
        <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">{missingCostCount} {missingCostCount === 1 ? 'item' : 'items'} missing cost data</span>
          {' '}— add costs to unlock full margin analysis. Click <strong>Edit</strong> on any row to enter a cost.
        </div>
      )}
      <Shell>
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {['Item Name', 'Category', 'Price', 'Cost', '30d Revenue', 'Orders', 'Trend', ''].map((h, i) => (
                <th key={i} className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {topPerformers.length > 0 && <SectionHeader label="⭐ Top Performers" colSpan={colSpan} />}
            {topPerformers.map((item) => (
              <Row key={item.id} item={item} accent="green" savedItemId={savedItemId} onEdit={setEditingItem} />
            ))}
            {middle.map((item) => (
              <Row key={item.id} item={item} savedItemId={savedItemId} onEdit={setEditingItem} />
            ))}
            {needsAttention.length > 0 && <SectionHeader label="⚠️ Needs Attention" colSpan={colSpan} />}
            {needsAttention.map((item) => (
              <Row key={item.id} item={item} accent="red" savedItemId={savedItemId} onEdit={setEditingItem} />
            ))}
          </tbody>
        </table>
      </Shell>

      {editingItem && restaurant && (
        <EditMenuItemModal
          item={{
            id: editingItem.id,
            name: editingItem.name,
            category: editingItem.category,
            price_cents: editingItem.price_cents,
            cost_cents: editingItem.cost_cents,
          }}
          restaurantId={restaurant.id}
          onClose={() => setEditingItem(null)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
};

export default MenuItemsTable;
