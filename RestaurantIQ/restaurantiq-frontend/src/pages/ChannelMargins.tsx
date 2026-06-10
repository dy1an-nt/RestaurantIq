import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { apiFetch } from '../lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChannelStats {
  gross_cents: number;
  net_cents: number;
  delivery_tax_cents: number;
  order_count: number;
}

interface ItemChannelStats {
  units: number;
  gross_cents: number;
  food_cost_cents: number;
  net_cents: number;
  margin_percent: number;
}

// Delivery stats always carry the allocated delivery tax; in-house never does.
interface ItemDeliveryStats extends ItemChannelStats {
  delivery_tax_cents: number;
}

interface ChannelItem {
  id: string;
  name: string;
  price_cents: number;
  in_house: ItemChannelStats | null;
  delivery: ItemDeliveryStats | null;
  margin_gap_percent: number | null;
}

interface MissingCostItem {
  id: string;
  name: string;
  price_cents: number;
}

interface DeliverySettings {
  doordash_commission_bps: number;
  doordash_flat_fee_cents: number;
}

interface ChannelSummary {
  in_house: ChannelStats;
  delivery: ChannelStats;
  biggest_margin_gap_item: {
    id: string;
    name: string;
    margin_gap_percent: number;
  } | null;
}

interface ChannelMarginsData {
  summary: ChannelSummary;
  items: ChannelItem[];
  settings: DeliverySettings;
  missingCostItems: MissingCostItem[];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const fmt = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const fmtK = (cents: number): string => {
  const d = cents / 100;
  if (d >= 1000) return `$${(d / 1000).toFixed(1)}k`;
  return `$${Math.round(d)}`;
};
const fmtPct = (pct: number): string => `${pct.toFixed(1)}%`;

const marginColorClass = (pct: number): string => {
  if (pct < 0) return 'text-neg';
  if (pct < 25) return 'text-warn';
  if (pct < 50) return 'text-ink-2';
  return 'text-pos';
};

const gapColorClass = (gap: number): string => {
  if (gap >= 20) return 'text-neg font-semibold';
  if (gap >= 10) return 'text-warn font-semibold';
  return 'text-ink-2';
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const SummaryCard = ({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) => (
  <div className="bg-surface border border-line rounded px-5 py-4">
    <p className="text-xs font-bold uppercase tracking-[0.08em] text-ink-3">{label}</p>
    <p className={`text-2xl font-extrabold mt-1 tracking-tighter ${valueClass ?? 'text-ink'}`}>
      {value}
    </p>
    {sub && <p className="text-xs text-ink-3 mt-0.5">{sub}</p>}
  </div>
);

// ---------------------------------------------------------------------------
// Commission settings panel
// ---------------------------------------------------------------------------

interface SettingsPanelProps {
  settings: DeliverySettings;
  onSaved: (s: DeliverySettings) => void;
}

const MAX_COMMISSION_BPS = 5000;
const MAX_FLAT_FEE_CENTS = 2000;

const SettingsPanel = ({ settings, onSaved }: SettingsPanelProps) => {
  // Display values are in percentage (bps / 100) and dollars (cents / 100)
  const [commissionPct, setCommissionPct] = useState<string>(
    (settings.doordash_commission_bps / 100).toFixed(1),
  );
  const [flatFeeDollars, setFlatFeeDollars] = useState<string>(
    (settings.doordash_flat_fee_cents / 100).toFixed(2),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  const validate = (): string | null => {
    const pct = parseFloat(commissionPct);
    const fee = parseFloat(flatFeeDollars);
    if (Number.isNaN(pct) || pct < 0 || pct * 100 > MAX_COMMISSION_BPS) {
      return `Commission must be between 0% and ${MAX_COMMISSION_BPS / 100}%`;
    }
    if (Number.isNaN(fee) || fee < 0 || fee * 100 > MAX_FLAT_FEE_CENTS) {
      return `Flat fee must be between $0.00 and $${(MAX_FLAT_FEE_CENTS / 100).toFixed(2)}`;
    }
    return null;
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaveOk(false);
    const validationError = validate();
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    const bps = Math.round(parseFloat(commissionPct) * 100);
    const feeCents = Math.round(parseFloat(flatFeeDollars) * 100);
    setSaving(true);
    try {
      const res = await apiFetch('/api/analytics/delivery-economics', {
        method: 'PATCH',
        body: JSON.stringify({
          doordash_commission_bps: bps,
          doordash_flat_fee_cents: feeCents,
        }),
      });
      const body = (await res.json()) as {
        data: DeliverySettings | null;
        error: string | null;
      };
      if (!res.ok || body.error) throw new Error(body.error ?? `Request failed (${res.status})`);
      if (body.data) {
        onSaved(body.data);
        setSaveOk(true);
        setTimeout(() => setSaveOk(false), 3000);
      }
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface border border-line rounded px-6 py-5">
      <h2 className="text-base font-bold text-ink mb-1">DoorDash Commission Settings</h2>
      <p className="text-[13px] text-ink-3 mb-4">
        These values are used to compute true delivery-channel margin for every item.
      </p>
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label htmlFor="commission-pct" className="block text-xs font-semibold text-ink-2 mb-1">
            Commission rate (%)
          </label>
          <input
            id="commission-pct"
            type="number"
            min="0"
            max="50"
            step="0.1"
            value={commissionPct}
            onChange={(e) => { setCommissionPct(e.target.value); setSaveOk(false); }}
            className="mt-1 block w-32 px-3 py-2 border border-line rounded-sm text-sm focus:ring-navy-700 focus:border-navy-700"
          />
        </div>
        <div>
          <label htmlFor="flat-fee" className="block text-xs font-semibold text-ink-2 mb-1">
            Flat fee per order ($)
          </label>
          <input
            id="flat-fee"
            type="number"
            min="0"
            max="20"
            step="0.01"
            value={flatFeeDollars}
            onChange={(e) => { setFlatFeeDollars(e.target.value); setSaveOk(false); }}
            className="mt-1 block w-32 px-3 py-2 border border-line rounded-sm text-sm focus:ring-navy-700 focus:border-navy-700"
          />
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-navy-700 text-white text-sm font-bold rounded-sm hover:bg-navy-800 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {saveError && (
        <p className="mt-3 text-sm text-neg bg-neg-bg border border-neg/20 rounded-sm px-3 py-2">
          {saveError}
        </p>
      )}
      {saveOk && (
        <p className="mt-3 text-sm text-pos bg-pos-bg border border-pos/20 rounded-sm px-3 py-2">
          Settings saved — margins recalculated.
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Per-item grouped bar chart
// ---------------------------------------------------------------------------

interface ChartItem {
  name: string;
  in_house: number | null;
  delivery: number | null;
  gap: number | null;
}

const ChannelBarChart = ({ items }: { items: ChartItem[] }) => {
  const chartData = items.slice(0, 12).map((item) => ({
    name: item.name.length > 16 ? item.name.slice(0, 14) + '…' : item.name,
    'In-house': item.in_house ?? undefined,
    'Delivery': item.delivery ?? undefined,
  }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart
        data={chartData}
        margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
        barCategoryGap="30%"
        barGap={4}
      >
        <XAxis
          dataKey="name"
          tick={{ fontSize: 11, fill: '#76808f', fontWeight: 600 }}
          tickLine={false}
          axisLine={false}
          interval={0}
          angle={-30}
          textAnchor="end"
          height={56}
        />
        <YAxis
          domain={[(dataMin: number) => Math.min(0, dataMin), 100]}
          tickFormatter={(v: number) => `${v}%`}
          tick={{ fontSize: 11, fill: '#76808f', fontWeight: 600 }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <Tooltip
          formatter={(value, name) => {
            const pct = Number(value);
            return [Number.isFinite(pct) ? `${pct.toFixed(1)}%` : '—', String(name)];
          }}
          contentStyle={{
            borderRadius: '10px',
            border: '1px solid #e4e7ec',
            fontSize: '13px',
          }}
          labelStyle={{ color: '#1f2733', fontWeight: 600 }}
        />
        <Legend
          iconType="square"
          iconSize={10}
          wrapperStyle={{ fontSize: '12px', paddingTop: '4px' }}
        />
        <Bar dataKey="In-house" fill="#1e3a5f" radius={[3, 3, 0, 0]} />
        <Bar dataKey="Delivery" fill="#9a7320" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
};

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type SortKey = 'gap' | 'in_house' | 'delivery' | 'name';

const ChannelMargins = () => {
  const [data, setData] = useState<ChannelMarginsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('gap');
  const [sortAsc, setSortAsc] = useState(false);
  const [refetchKey, setRefetchKey] = useState(0);

  const fetchData = useCallback(async (signal: AbortSignal) => {
    const res = await apiFetch('/api/analytics/channel-margins', { signal });
    const body = (await res.json()) as { data: ChannelMarginsData; error: string | null };
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
        const result = await fetchData(controller.signal);
        if (!cancelled) setData(result);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load channel margins');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetchData, refetchKey]);

  // Saving settings re-runs the fetch effect (via refetchKey) so the in-flight
  // request is properly cancelled if the component unmounts mid-refetch.
  const handleSettingsSaved = useCallback((updated: DeliverySettings) => {
    setData(prev => (prev ? { ...prev, settings: updated } : prev));
    setRefetchKey(k => k + 1);
  }, []);

  // -------------------------------------------------------------------------
  // Sorted items for table + chart
  // -------------------------------------------------------------------------
  const sortedItems: ChannelItem[] = data
    ? [...data.items].sort((a, b) => {
        let diff = 0;
        if (sortKey === 'gap') {
          diff = (b.margin_gap_percent ?? -Infinity) - (a.margin_gap_percent ?? -Infinity);
        } else if (sortKey === 'in_house') {
          diff =
            (b.in_house?.margin_percent ?? -Infinity) -
            (a.in_house?.margin_percent ?? -Infinity);
        } else if (sortKey === 'delivery') {
          diff =
            (b.delivery?.margin_percent ?? -Infinity) -
            (a.delivery?.margin_percent ?? -Infinity);
        } else {
          diff = a.name.localeCompare(b.name);
        }
        return sortAsc ? -diff : diff;
      })
    : [];

  const handleSortClick = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const SortHeader = ({
    label,
    sortKeyValue,
    className,
  }: {
    label: string;
    sortKeyValue: SortKey;
    className?: string;
  }) => (
    <th
      className={`px-4 py-2 text-xs font-bold text-ink-3 uppercase tracking-wide cursor-pointer select-none hover:text-ink whitespace-nowrap ${className ?? ''}`}
      onClick={() => handleSortClick(sortKeyValue)}
    >
      {label}
      {sortKey === sortKeyValue && (
        <span className="ml-1 text-navy-700">{sortAsc ? '↑' : '↓'}</span>
      )}
    </th>
  );

  // -------------------------------------------------------------------------
  // Render states
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="max-w-5xl space-y-4">
        <div className="animate-pulse bg-gray-200 rounded h-28" />
        <div className="animate-pulse bg-gray-200 rounded h-28" />
        <div className="animate-pulse bg-gray-200 rounded h-64" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-5xl space-y-6">
        <header>
          <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">Channel Margins</h1>
          <p className="mt-[5px] text-[13.5px] font-medium text-ink-3">
            In-house vs DoorDash — true margin after commission
          </p>
        </header>
        <div className="rounded-sm bg-neg-bg border border-neg/30 px-4 py-3 text-sm text-neg">
          {error}
        </div>
      </div>
    );
  }

  const isEmpty =
    data !== null &&
    data.items.length === 0 &&
    data.missingCostItems.length === 0;

  if (isEmpty) {
    return (
      <div className="max-w-5xl space-y-6">
        <header>
          <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">Channel Margins</h1>
          <p className="mt-[5px] text-[13.5px] font-medium text-ink-3">
            In-house vs DoorDash — true margin after commission
          </p>
        </header>
        {data && (
          <SettingsPanel settings={data.settings} onSaved={handleSettingsSaved} />
        )}
        <div className="bg-surface border border-line rounded p-12 text-center">
          <p className="text-xl font-extrabold text-ink">No channel data yet</p>
          <p className="text-sm text-ink-3 mt-2 max-w-md mx-auto">
            Sync your Square and DoorDash integrations and add item costs to see
            cross-channel margin analysis.
          </p>
          <Link
            to="/integrations"
            className="inline-flex items-center mt-6 px-4 h-[46px] bg-navy-700 text-white text-sm font-bold rounded-[9px] hover:bg-navy-800 transition-colors"
          >
            Go to Integrations
          </Link>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Full render
  // -------------------------------------------------------------------------

  const { summary, settings, missingCostItems } = data!;

  const inHouseNetPct =
    summary.in_house.gross_cents > 0
      ? (summary.in_house.net_cents / summary.in_house.gross_cents) * 100
      : 0;
  const deliveryNetPct =
    summary.delivery.gross_cents > 0
      ? (summary.delivery.net_cents / summary.delivery.gross_cents) * 100
      : 0;

  const chartItems: ChartItem[] = sortedItems.map((item) => ({
    name: item.name,
    in_house: item.in_house?.margin_percent ?? null,
    delivery: item.delivery?.margin_percent ?? null,
    gap: item.margin_gap_percent,
  }));

  return (
    <div className="max-w-5xl space-y-8">
      {/* Page header */}
      <header>
        <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">Channel Margins</h1>
        <p className="mt-[5px] text-[13.5px] font-medium text-ink-3">
          In-house vs DoorDash — true margin after commission · Last 30 days
        </p>
      </header>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label="In-house net margin"
          value={fmtPct(inHouseNetPct)}
          sub={`${summary.in_house.order_count} orders · ${fmtK(summary.in_house.net_cents)} net`}
          valueClass={marginColorClass(inHouseNetPct)}
        />
        <SummaryCard
          label="Delivery net margin"
          value={fmtPct(deliveryNetPct)}
          sub={`${summary.delivery.order_count} orders · ${fmtK(summary.delivery.net_cents)} net`}
          valueClass={marginColorClass(deliveryNetPct)}
        />
        <SummaryCard
          label="Delivery tax paid (30d)"
          value={fmtK(summary.delivery.delivery_tax_cents)}
          sub="DoorDash commission + fees"
          valueClass="text-warn"
        />
        {summary.biggest_margin_gap_item ? (
          <div className="bg-surface border border-line rounded px-5 py-4">
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-ink-3">Biggest gap item</p>
            <p className="text-base font-extrabold mt-1 text-ink truncate" title={summary.biggest_margin_gap_item.name}>
              {summary.biggest_margin_gap_item.name}
            </p>
            <p className="text-xs text-warn mt-0.5">
              {fmtPct(summary.biggest_margin_gap_item.margin_gap_percent)} margin gap
            </p>
          </div>
        ) : (
          <SummaryCard
            label="Biggest gap item"
            value="—"
            sub="Needs data on both channels"
          />
        )}
      </div>

      {/* Commission settings */}
      <SettingsPanel settings={settings} onSaved={handleSettingsSaved} />

      {/* Grouped bar chart */}
      {sortedItems.length > 0 && (
        <div className="bg-surface border border-line rounded px-6 py-5">
          <h2 className="text-base font-bold text-ink mb-1">Margin by Item — In-house vs Delivery</h2>
          <p className="text-[13px] text-ink-3 mb-4">
            Navy = in-house margin %, amber = delivery margin % after DoorDash commission.
            Sorted by gap descending by default.
          </p>
          <ChannelBarChart items={chartItems} />
        </div>
      )}

      {/* Per-item comparison table */}
      {sortedItems.length > 0 && (
        <div className="bg-surface border border-line rounded overflow-hidden">
          <div className="px-6 py-4 border-b border-line flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-ink">Per-Item Channel Comparison</h2>
              <p className="text-[13px] text-ink-3 mt-0.5">
                Click column headers to sort. Null values = no sales on that channel in 30d.
              </p>
            </div>
            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-navy-100 text-navy-700">
              {sortedItems.length} items
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-canvas">
                  <SortHeader label="Item" sortKeyValue="name" className="text-left" />
                  <th className="px-4 py-2 text-xs font-bold text-ink-3 uppercase tracking-wide">
                    Price
                  </th>
                  <SortHeader label="In-house %" sortKeyValue="in_house" />
                  <th className="px-4 py-2 text-xs font-bold text-ink-3 uppercase tracking-wide">
                    In-house units
                  </th>
                  <SortHeader label="Delivery %" sortKeyValue="delivery" />
                  <th className="px-4 py-2 text-xs font-bold text-ink-3 uppercase tracking-wide">
                    Delivery units
                  </th>
                  <th className="px-4 py-2 text-xs font-bold text-ink-3 uppercase tracking-wide">
                    Delivery tax
                  </th>
                  <SortHeader label="Margin gap" sortKeyValue="gap" />
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => (
                  <tr key={item.id} className="border-t border-line hover:bg-canvas transition-colors">
                    <td className="px-4 py-3 text-sm font-semibold text-ink max-w-[180px] truncate" title={item.name}>
                      {item.name}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-2">{fmt(item.price_cents)}</td>
                    <td className={`px-4 py-3 text-sm font-semibold ${item.in_house ? marginColorClass(item.in_house.margin_percent) : 'text-ink-3'}`}>
                      {item.in_house ? fmtPct(item.in_house.margin_percent) : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-2">
                      {item.in_house ? item.in_house.units : '—'}
                    </td>
                    <td className={`px-4 py-3 text-sm font-semibold ${item.delivery ? marginColorClass(item.delivery.margin_percent) : 'text-ink-3'}`}>
                      {item.delivery ? fmtPct(item.delivery.margin_percent) : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-2">
                      {item.delivery ? item.delivery.units : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-2">
                      {item.delivery ? fmt(item.delivery.delivery_tax_cents) : '—'}
                    </td>
                    <td className={`px-4 py-3 text-sm ${item.margin_gap_percent !== null ? gapColorClass(item.margin_gap_percent) : 'text-ink-3'}`}>
                      {item.margin_gap_percent !== null
                        ? `${item.margin_gap_percent > 0 ? '+' : ''}${fmtPct(item.margin_gap_percent)}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Missing cost items */}
      {missingCostItems.length > 0 && (
        <div className="bg-surface border border-line rounded overflow-hidden">
          <div className="px-6 py-4 border-b border-line flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-ink">Missing Cost Items</h2>
              <p className="text-[13px] text-ink-3 mt-0.5">
                Add item costs to include these in channel margin analysis.
              </p>
            </div>
            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">
              {missingCostItems.length} items
            </span>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="bg-canvas">
                <th className="px-4 py-2 text-xs font-bold text-ink-3 uppercase tracking-wide">Item</th>
                <th className="px-4 py-2 text-xs font-bold text-ink-3 uppercase tracking-wide">Price</th>
                <th className="px-4 py-2 text-xs font-bold text-ink-3 uppercase tracking-wide">Status</th>
              </tr>
            </thead>
            <tbody>
              {missingCostItems.map((item) => (
                <tr key={item.id} className="border-t border-line hover:bg-canvas transition-colors">
                  <td className="px-4 py-3 text-sm font-semibold text-ink">{item.name}</td>
                  <td className="px-4 py-3 text-sm text-ink-2">{fmt(item.price_cents)}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-warn-bg text-warn">
                      Cost missing
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ChannelMargins;
