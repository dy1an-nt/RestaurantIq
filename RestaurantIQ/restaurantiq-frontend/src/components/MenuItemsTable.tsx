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

const MOCK_ITEMS: MenuItem[] = [
  { id: '1', name: 'Wagyu Burger', category: 'Mains', price_cents: 2800, cost_cents: 1200, revenue_30d_cents: 89600, orders_30d: 320, trend: 'up' },
  { id: '2', name: 'Grilled Salmon', category: 'Mains', price_cents: 3200, cost_cents: 1400, revenue_30d_cents: 73600, orders_30d: 230, trend: 'up' },
  { id: '3', name: 'Truffle Fries', category: 'Appetizers', price_cents: 1200, cost_cents: 350, revenue_30d_cents: 62400, orders_30d: 520, trend: 'up' },
  { id: '4', name: 'Chocolate Lava Cake', category: 'Desserts', price_cents: 1100, cost_cents: 250, revenue_30d_cents: 44000, orders_30d: 400, trend: 'up' },
  { id: '5', name: 'BBQ Ribs', category: 'Mains', price_cents: 3600, cost_cents: 1600, revenue_30d_cents: 39600, orders_30d: 110, trend: 'down' },
  { id: '6', name: 'Caesar Salad', category: 'Appetizers', price_cents: 1100, cost_cents: 300, revenue_30d_cents: 33000, orders_30d: 300, trend: 'flat' },
  { id: '7', name: 'Mushroom Risotto', category: 'Mains', price_cents: 2400, cost_cents: 800, revenue_30d_cents: 28800, orders_30d: 120, trend: 'flat' },
  { id: '8', name: 'Chicken Tenders', category: 'Mains', price_cents: 1800, cost_cents: 500, revenue_30d_cents: 25200, orders_30d: 140, trend: 'flat' },
  { id: '9', name: 'Tiramisu', category: 'Desserts', price_cents: 1000, cost_cents: 250, revenue_30d_cents: 15000, orders_30d: 150, trend: 'flat' },
  { id: '10', name: 'Cheesecake', category: 'Desserts', price_cents: 900, cost_cents: 200, revenue_30d_cents: 9000, orders_30d: 100, trend: 'down' },
];

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const TrendBadge = ({ trend }: { trend: MenuItem['trend'] }) => {
  if (trend === 'up') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">↑ Trending</span>;
  if (trend === 'down') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">↓ Declining</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">— Stable</span>;
};

const sorted = [...MOCK_ITEMS].sort((a, b) => b.revenue_30d_cents - a.revenue_30d_cents);
const topPerformers = sorted.slice(0, 4);
const middle = sorted.slice(4, 7);
const needsAttention = sorted.slice(7);

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

const MenuItemsTable = () => (
  <div className="bg-white rounded-xl shadow overflow-hidden">
    <table className="w-full text-left">
      <thead>
        <tr className="bg-gray-50 border-b border-gray-200">
          {['Item Name', 'Category', 'Price', 'Cost', '30d Revenue', 'Orders', 'Trend'].map((h) => (
            <th key={h} className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        <SectionHeader label="⭐ Top Performers" />
        {topPerformers.map((item) => <Row key={item.id} item={item} accent="green" />)}
        {middle.map((item) => <Row key={item.id} item={item} />)}
        <SectionHeader label="⚠️ Needs Attention" />
        {needsAttention.map((item) => <Row key={item.id} item={item} accent="red" />)}
      </tbody>
    </table>
  </div>
);

export default MenuItemsTable;
