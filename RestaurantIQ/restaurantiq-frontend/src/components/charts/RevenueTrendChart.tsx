import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface RevenueTrendDataPoint {
  date: string;
  revenue_cents: number;
}

interface Props {
  data: RevenueTrendDataPoint[] | undefined;
  loading: boolean;
}

const formatDate = (dateStr: string): string => {
  // Parse YYYY-MM-DD as local midnight to avoid UTC-offset day shift.
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const formatDollars = (cents: number): string => {
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${Math.round(dollars / 100) / 10}k`;
  return `$${Math.round(dollars)}`;
};

const Skeleton = () => (
  <div className="h-[280px] bg-canvas rounded animate-pulse" />
);

const Empty = () => (
  <div className="h-[280px] flex items-center justify-center text-sm text-ink-3">
    No revenue data for this period
  </div>
);

const RevenueTrendChart = ({ data, loading }: Props) => {
  if (loading) return <Skeleton />;
  if (!data || data.length === 0) return <Empty />;

  const chartData = data.map((d) => ({
    date: d.date,
    label: formatDate(d.date),
    revenue: d.revenue_cents,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={chartData} margin={{ top: 6, right: 16, left: 8, bottom: 4 }}>
        <defs>
          <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1e3a5f" stopOpacity={0.14} />
            <stop offset="100%" stopColor="#1e3a5f" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#eef0f3" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: '#76808f', fontWeight: 600 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={(value: number) => formatDollars(value)}
          tick={{ fontSize: 11, fill: '#76808f', fontWeight: 600 }}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip
          formatter={(value) => {
            const dollars = typeof value === 'number' ? `$${(value / 100).toFixed(2)}` : String(value);
            return [dollars, 'Revenue'];
          }}
          labelStyle={{ color: '#1f2733', fontWeight: 600 }}
          contentStyle={{ borderRadius: '10px', border: '1px solid #e4e7ec', fontSize: '13px' }}
        />
        <Area
          type="monotone"
          dataKey="revenue"
          stroke="#1e3a5f"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="url(#revFill)"
          activeDot={{ r: 4.5, fill: '#1e3a5f', stroke: '#fff', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
};

export default RevenueTrendChart;
