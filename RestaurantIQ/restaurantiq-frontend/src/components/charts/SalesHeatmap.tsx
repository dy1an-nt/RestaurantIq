import { useMemo, useState } from 'react';

interface HeatmapDataPoint {
  day: number;   // 0 = Sunday … 6 = Saturday
  hour: number;  // 0–23
  revenue_cents: number;
  orders: number;
}

interface Props {
  data: HeatmapDataPoint[] | undefined;
  loading?: boolean;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

// Per the approved tweak: exactly 3 navy shades (5 looked jumbled).
const SHADES = ['rgba(30,58,95,0.10)', 'rgba(30,58,95,0.42)', 'rgba(30,58,95,0.82)'] as const;
const EMPTY = '#f6f7f9'; // canvas — no orders in this hour

const formatHour = (h: number): string => {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
};

const formatDollars = (cents: number): string =>
  `$${(cents / 100).toFixed(2)}`;

/** Bucket an order count into one of 3 navy shades by share of the busiest hour. */
const orderColor = (orders: number, maxOrders: number): string => {
  if (orders === 0 || maxOrders === 0) return EMPTY;
  const ratio = orders / maxOrders;
  if (ratio < 0.34) return SHADES[0];
  if (ratio < 0.67) return SHADES[1];
  return SHADES[2];
};

interface TooltipState {
  day: number;
  hour: number;
  orders: number;
  revenue_cents: number;
}

const Skeleton = () => (
  <div className="h-[196px] bg-canvas rounded animate-pulse" />
);

const Empty = () => (
  <div className="flex items-center justify-center py-16 text-sm text-ink-3">
    No sales data to display
  </div>
);

const SalesHeatmap = ({ data, loading }: Props) => {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  // Build a 7×24 matrix: matrix[day][hour] = { orders, revenue_cents }
  const matrix = useMemo(() => {
    const m: Array<Array<{ orders: number; revenue_cents: number }>> = Array.from(
      { length: 7 },
      () => Array.from({ length: 24 }, () => ({ orders: 0, revenue_cents: 0 }))
    );
    if (!data) return m;
    for (const point of data) {
      if (point.day >= 0 && point.day < 7 && point.hour >= 0 && point.hour < 24) {
        m[point.day][point.hour].orders += point.orders;
        m[point.day][point.hour].revenue_cents += point.revenue_cents;
      }
    }
    return m;
  }, [data]);

  const maxOrders = useMemo(() => {
    let max = 0;
    for (const row of matrix) {
      for (const cell of row) {
        if (cell.orders > max) max = cell.orders;
      }
    }
    return max;
  }, [matrix]);

  if (loading) return <Skeleton />;
  const isEmpty = !data || data.length === 0;
  if (isEmpty) return <Empty />;

  return (
    <div className="overflow-x-auto relative">
      {/* Tooltip overlay */}
      {tooltip && (
        <div className="absolute top-0 right-0 bg-surface border border-line rounded shadow p-3 text-xs text-ink-2 z-10 pointer-events-none">
          <div className="font-bold text-ink mb-1">
            {DAY_LABELS[tooltip.day]} · {formatHour(tooltip.hour)}
          </div>
          <div>Orders: <span className="font-semibold">{tooltip.orders}</span></div>
          <div>Revenue: <span className="font-semibold">{formatDollars(tooltip.revenue_cents)}</span></div>
        </div>
      )}

      <div style={{ minWidth: '640px' }}>
        {/* Hour column headers — every 3rd hour */}
        <div className="flex ml-10 mb-1">
          {HOURS.map((h) => (
            <div
              key={h}
              className="flex-1 text-center"
              style={{ minWidth: '24px', height: '16px' }}
            >
              {h % 3 === 0 ? (
                <span className="text-[10.5px] font-semibold text-ink-3">{formatHour(h)}</span>
              ) : null}
            </div>
          ))}
        </div>

        {/* Grid rows */}
        {DAY_LABELS.map((dayLabel, day) => (
          <div key={day} className="flex items-center mb-1">
            {/* Row label */}
            <div className="w-10 shrink-0 text-[11.5px] text-ink-2 font-bold pr-1 text-right">
              {dayLabel}
            </div>
            {/* Hour cells */}
            {HOURS.map((hour) => {
              const cell = matrix[day][hour];
              const bg = orderColor(cell.orders, maxOrders);
              return (
                <div
                  key={hour}
                  className="flex-1 rounded-[5px] cursor-default transition-opacity hover:opacity-75"
                  style={{
                    minWidth: '24px',
                    height: '26px',
                    backgroundColor: bg,
                    marginRight: '4px',
                  }}
                  onMouseEnter={() =>
                    setTooltip({
                      day,
                      hour,
                      orders: cell.orders,
                      revenue_cents: cell.revenue_cents,
                    })
                  }
                  onMouseLeave={() => setTooltip(null)}
                />
              );
            })}
          </div>
        ))}

        {/* Legend */}
        <div className="flex items-center gap-2 mt-[14px] ml-10 text-[11.5px] font-semibold text-ink-3">
          <span>Quieter</span>
          <span className="flex gap-[3px]">
            {SHADES.map((color) => (
              <i
                key={color}
                className="rounded-[3px]"
                style={{ width: '18px', height: '11px', display: 'inline-block', background: color }}
              />
            ))}
          </span>
          <span>Busier</span>
        </div>
      </div>
    </div>
  );
};

export default SalesHeatmap;
