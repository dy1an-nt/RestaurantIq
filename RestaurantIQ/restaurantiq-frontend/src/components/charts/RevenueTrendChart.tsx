import {
  LineChart,
  Line,
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
  <div className="h-[280px] bg-gray-100 rounded-lg animate-pulse" />
);

const Empty = () => (
  <div className="h-[280px] flex items-center justify-center text-sm text-gray-400">
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
      <LineChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 12, fill: '#6b7280' }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={(value: number) => formatDollars(value)}
          tick={{ fontSize: 12, fill: '#6b7280' }}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip
          formatter={(value) => {
            const dollars = typeof value === 'number' ? `$${(value / 100).toFixed(2)}` : String(value);
            return [dollars, 'Revenue'];
          }}
          labelStyle={{ color: '#111827', fontWeight: 600 }}
          contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '13px' }}
        />
        <Line
          type="monotone"
          dataKey="revenue"
          stroke="#6366f1"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: '#6366f1' }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
};

export default RevenueTrendChart;
