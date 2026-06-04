import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useRestaurant } from './restaurant/RestaurantContext';
import EditMenuItemModal, { MenuItemPatch } from './EditMenuItemModal';
import Icon, { IconName } from './Icons';

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
  const map: Record<MenuItem['trend'], { label: string; icon: IconName; cls: string }> = {
    up: { label: 'Trending', icon: 'arrowUp', cls: 'bg-pos-bg text-pos' },
    down: { label: 'Declining', icon: 'arrowDown', cls: 'bg-neg-bg text-neg' },
    flat: { label: 'Stable', icon: 'flat', cls: 'bg-canvas text-ink-3' },
  };
  const { label, icon, cls } = map[trend];
  return (
    <span className={`inline-flex items-center gap-1 pl-[7px] pr-[9px] py-[3px] rounded-md text-xs font-bold ${cls}`}>
      <Icon name={icon} size={14} strokeWidth={2} />
      {label}
    </span>
  );
};

const MissingCostChip = () => (
  <span className="inline-flex items-center gap-[5px] px-[9px] py-[3px] rounded-md text-[11.5px] font-bold bg-warn-bg text-warn">
    <Icon name="attention" size={13} strokeWidth={1.9} />
    Add cost
  </span>
);

interface RowProps {
  item: MenuItem;
  accent?: 'pos' | 'neg';
  savedItemId: string | null;
  onEdit: (item: MenuItem) => void;
}

const ACCENT_HEX = { pos: '#2f7a5b', neg: '#b25140' } as const;

const Row = ({ item, accent, savedItemId, onEdit }: RowProps) => (
  <tr className="group hover:bg-navy-50 transition-colors [&>td]:border-b [&>td]:border-line-2">
    <td
      className="px-[18px] py-[14px] text-sm"
      style={accent ? { boxShadow: `inset 3px 0 0 ${ACCENT_HEX[accent]}` } : undefined}
    >
      <span className="font-bold text-ink">{item.name}</span>
      {savedItemId === item.id && (
        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-bold bg-pos-bg text-pos">
          Saved
        </span>
      )}
    </td>
    <td className="px-[18px] py-[14px] text-[13px] text-ink-3">{item.category ?? '—'}</td>
    <td className="px-[18px] py-[14px] text-sm text-right text-ink-2 tnum">{fmt(item.price_cents)}</td>
    <td className="px-[18px] py-[14px] text-sm text-right text-ink-2 tnum">
      {item.cost_cents === null ? <MissingCostChip /> : fmt(item.cost_cents)}
    </td>
    <td className="px-[18px] py-[14px] text-sm text-right font-bold text-ink tnum">{fmt(item.revenue_30d_cents)}</td>
    <td className="px-[18px] py-[14px] text-sm text-right text-ink-2 tnum">{item.orders_30d.toLocaleString()}</td>
    <td className="px-[18px] py-[14px]"><TrendBadge trend={item.trend} /></td>
    <td className="px-[18px] py-[14px] text-right">
      <button
        onClick={() => onEdit(item)}
        className="opacity-0 group-hover:opacity-100 focus:opacity-100 px-[13px] py-[5px] bg-surface border border-line text-[12.5px] font-bold text-ink-2 rounded-sm hover:bg-canvas hover:border-ink-3 transition-opacity"
      >
        Edit
      </button>
    </td>
  </tr>
);

const SectionHeader = ({
  icon,
  tone,
  label,
  colSpan,
}: {
  icon: IconName;
  tone: 'pos' | 'neg';
  label: string;
  colSpan: number;
}) => (
  <tr>
    <td colSpan={colSpan} className="px-[18px] pt-[18px] pb-[9px]">
      <span className="inline-flex items-center gap-2 text-[11.5px] font-extrabold tracking-[0.07em] uppercase text-ink-2">
        <Icon name={icon} size={15} strokeWidth={1.9} className={tone === 'pos' ? 'text-pos' : 'text-neg'} />
        {label}
      </span>
    </td>
  </tr>
);

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-surface border border-line rounded shadow overflow-hidden">{children}</div>
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
    return <Shell><div className="px-[18px] py-8 text-sm text-neg">Failed to load menu items: {error}</div></Shell>;
  }
  if (items === null) {
    return <Shell><div className="px-[18px] py-8 text-sm text-ink-3">Loading menu items…</div></Shell>;
  }
  if (items.length === 0) {
    return (
      <Shell>
        <div className="p-12 text-center">
          <p className="text-lg font-bold text-ink">No menu items yet</p>
          <p className="text-sm text-ink-3 mt-2">
            Connect your Square POS and sync your catalog to see menu performance data.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Link
              to="/integrations"
              className="px-4 py-2 bg-navy-700 text-white text-sm font-bold rounded-[9px] hover:bg-navy-800 transition-colors"
            >
              {restaurant?.pos_connected ? 'Run sync' : 'Connect Square'}
            </Link>
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
        <div className="mb-[18px] flex items-center gap-[10px] rounded-sm bg-warn-bg text-warn border border-[#ecdfc0] px-[15px] py-[11px] text-[13px]">
          <Icon name="attention" size={17} strokeWidth={1.8} className="flex-shrink-0" />
          <span>
            <b className="font-bold">
              {missingCostCount} {missingCostCount === 1 ? 'item' : 'items'} missing cost data
            </b>{' '}
            — add costs to unlock full margin analysis.
          </span>
        </div>
      )}
      <Shell>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-canvas border-b border-line">
              {[
                { h: 'Item', r: false },
                { h: 'Category', r: false },
                { h: 'Price', r: true },
                { h: 'Cost', r: true },
                { h: '30-Day Revenue', r: true },
                { h: 'Orders', r: true },
                { h: 'Trend', r: false },
                { h: '', r: true },
              ].map((c, i) => (
                <th
                  key={i}
                  className={`px-[18px] py-[13px] text-[11px] font-bold uppercase tracking-[0.06em] text-ink-3 ${c.r ? 'text-right' : 'text-left'}`}
                >
                  {c.h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topPerformers.length > 0 && (
              <SectionHeader icon="star" tone="pos" label="Top Performers" colSpan={colSpan} />
            )}
            {topPerformers.map((item) => (
              <Row key={item.id} item={item} accent="pos" savedItemId={savedItemId} onEdit={setEditingItem} />
            ))}
            {middle.map((item) => (
              <Row key={item.id} item={item} savedItemId={savedItemId} onEdit={setEditingItem} />
            ))}
            {needsAttention.length > 0 && (
              <SectionHeader icon="attention" tone="neg" label="Needs Attention" colSpan={colSpan} />
            )}
            {needsAttention.map((item) => (
              <Row key={item.id} item={item} accent="neg" savedItemId={savedItemId} onEdit={setEditingItem} />
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
