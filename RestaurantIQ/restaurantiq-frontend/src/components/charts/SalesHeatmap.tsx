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

const formatHour = (h: number): string => {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
};

const formatDollars = (cents: number): string =>
  `$${(cents / 100).toFixed(2)}`;

/** Map an order count to a hex background color via intensity thresholds. */
const orderColor = (orders: number, maxOrders: number): string => {
  if (orders === 0 || maxOrders === 0) return '#f3f4f6'; // gray-100
  const ratio = orders / maxOrders;
  if (ratio < 0.15) return '#e0e7ff'; // indigo-100
  if (ratio < 0.35) return '#a5b4fc'; // indigo-300
  if (ratio < 0.6) return '#818cf8';  // indigo-400
  if (ratio < 0.8) return '#6366f1';  // indigo-500
  return '#4f46e5';                    // indigo-600
};

interface TooltipState {
  day: number;
  hour: number;
  orders: number;
  revenue_cents: number;
}

const Skeleton = () => (
  <div className="h-[196px] bg-gray-100 rounded-lg animate-pulse" />
);

const Empty = () => (
  <div className="flex items-center justify-center py-16 text-sm text-gray-400">
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
        <div className="absolute top-0 right-0 bg-white border border-gray-200 rounded-lg shadow-md p-3 text-xs text-gray-700 z-10 pointer-events-none">
          <div className="font-semibold text-gray-900 mb-1">
            {DAY_LABELS[tooltip.day]} · {formatHour(tooltip.hour)}
          </div>
          <div>Orders: <span className="font-medium">{tooltip.orders}</span></div>
          <div>Revenue: <span className="font-medium">{formatDollars(tooltip.revenue_cents)}</span></div>
        </div>
      )}

      <div style={{ minWidth: '640px' }}>
        {/* Hour column headers — every 3rd hour */}
        <div className="flex ml-10 mb-1">
          {HOURS.map((h) => (
            <div
              key={h}
              className="flex-1 text-center"
              style={{ minWidth: '28px', height: '16px' }}
            >
              {h % 3 === 0 ? (
                <span className="text-xs text-gray-400">{formatHour(h)}</span>
              ) : null}
            </div>
          ))}
        </div>

        {/* Grid rows */}
        {DAY_LABELS.map((dayLabel, day) => (
          <div key={day} className="flex items-center mb-0.5">
            {/* Row label */}
            <div className="w-10 shrink-0 text-xs text-gray-500 font-medium pr-1 text-right">
              {dayLabel}
            </div>
            {/* Hour cells */}
            {HOURS.map((hour) => {
              const cell = matrix[day][hour];
              const bg = orderColor(cell.orders, maxOrders);
              return (
                <div
                  key={hour}
                  className="flex-1 rounded-sm cursor-default transition-opacity hover:opacity-75"
                  style={{
                    minWidth: '28px',
                    height: '24px',
                    backgroundColor: bg,
                    marginRight: '1px',
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
        <div className="flex items-center gap-2 mt-3 ml-10">
          <span className="text-xs text-gray-400">Less</span>
          {(['#f3f4f6', '#e0e7ff', '#a5b4fc', '#818cf8', '#6366f1', '#4f46e5'] as const).map((color) => (
            <div
              key={color}
              className="rounded-sm"
              style={{ width: '16px', height: '16px', backgroundColor: color }}
            />
          ))}
          <span className="text-xs text-gray-400">More</span>
        </div>
      </div>
    </div>
  );
};

export default SalesHeatmap;
