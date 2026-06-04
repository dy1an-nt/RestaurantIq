interface TopItemDataPoint {
  name: string;
  revenue_cents: number;
  orders: number;
}

interface Props {
  data: TopItemDataPoint[] | undefined;
  loading: boolean;
}

const Skeleton = () => (
  <div className="h-[280px] bg-canvas rounded animate-pulse" />
);

const Empty = () => (
  <div className="h-[280px] flex items-center justify-center text-sm text-ink-3">
    No item data available
  </div>
);

const formatDollars = (cents: number): string =>
  `$${Math.round(cents / 100).toLocaleString('en-US')}`;

const TopItemsChart = ({ data, loading }: Props) => {
  if (loading) return <Skeleton />;
  if (!data || data.length === 0) return <Empty />;

  const rows = [...data].sort((a, b) => b.revenue_cents - a.revenue_cents).slice(0, 6);
  const max = Math.max(...rows.map((r) => r.revenue_cents), 1);

  return (
    <div className="flex flex-col gap-[13px] mt-1.5">
      {rows.map((r) => (
        <div
          key={r.name}
          className="grid items-center gap-[14px]"
          style={{ gridTemplateColumns: '160px 1fr auto' }}
        >
          <span className="text-[13px] font-semibold text-ink whitespace-nowrap overflow-hidden text-ellipsis" title={r.name}>
            {r.name}
          </span>
          <span className="block h-[14px] bg-canvas rounded-sm overflow-hidden">
            <span
              className="block h-full rounded-sm"
              style={{
                width: `${(r.revenue_cents / max) * 100}%`,
                background: 'linear-gradient(90deg, #2b4a72, #1e3a5f)',
              }}
            />
          </span>
          <span className="text-[13px] font-bold text-ink tnum">{formatDollars(r.revenue_cents)}</span>
        </div>
      ))}
    </div>
  );
};

export default TopItemsChart;
