import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from 'recharts';

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
  <div className="h-[280px] bg-gray-100 rounded-lg animate-pulse" />
);

const Empty = () => (
  <div className="h-[280px] flex items-center justify-center text-sm text-gray-400">
    No item data available
  </div>
);

const formatDollars = (cents: number): string =>
  `$${(cents / 100).toFixed(2)}`;

const TopItemsChart = ({ data, loading }: Props) => {
  if (loading) return <Skeleton />;
  if (!data || data.length === 0) return <Empty />;

  const chartData = data.map((d) => ({
    name: d.name,
    revenue: d.revenue_cents,
    orders: d.orders,
    label: formatDollars(d.revenue_cents),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 4, right: 80, left: 8, bottom: 4 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={(value: number) => `$${Math.round(value / 100)}`}
          tick={{ fontSize: 12, fill: '#6b7280' }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={140}
          tick={{ fontSize: 12, fill: '#374151' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(name: string) =>
            name.length > 20 ? `${name.slice(0, 19)}…` : name
          }
        />
        <Tooltip
          formatter={(value, name) => {
            if (name === 'revenue' && typeof value === 'number') return [formatDollars(value), 'Revenue'];
            return [String(value), 'Orders'];
          }}
          contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '13px' }}
        />
        <Bar dataKey="revenue" fill="#6366f1" radius={[0, 4, 4, 0]}>
          <LabelList
            dataKey="label"
            position="right"
            style={{ fontSize: '12px', fill: '#374151' }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
};

export default TopItemsChart;
