import type { ForecastItem } from '../../lib/advisorApi';
import Icon from '../Icons';

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const confidenceBadge: Record<ForecastItem['confidence'], string> = {
  high: 'bg-green-100 text-green-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-gray-100 text-gray-500',
};

interface Props {
  items: ForecastItem[];
}

export default function ForecastTable({ items }: Props) {
  if (items.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
          <tr>
            <th className="px-4 py-3 text-left font-semibold">Item</th>
            <th className="px-4 py-3 text-left font-semibold">Category</th>
            <th className="px-4 py-3 text-right font-semibold">Projected (next 7d)</th>
            <th className="px-4 py-3 text-right font-semibold">Actual (last 7d)</th>
            <th className="px-4 py-3 text-right font-semibold">Change</th>
            <th className="px-4 py-3 text-center font-semibold">Confidence</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {items.map((item) => (
            <tr key={item.menu_item_id} className="hover:bg-gray-50 transition-colors">
              <td className="px-4 py-3 font-medium text-gray-900">{item.name}</td>
              <td className="px-4 py-3 text-gray-500">{item.category}</td>
              <td className="px-4 py-3 text-right">
                <span className="font-semibold text-gray-900">{item.projected_units_next_7d}</span>
                <span className="text-gray-400 ml-1 text-xs">
                  {formatCents(item.projected_revenue_next_7d_cents)}
                </span>
              </td>
              <td className="px-4 py-3 text-right">
                <span className="text-gray-700">{item.actual_units_last_7d}</span>
                <span className="text-gray-400 ml-1 text-xs">
                  {formatCents(item.actual_revenue_last_7d_cents)}
                </span>
              </td>
              <td className="px-4 py-3 text-right">
                <span
                  className={`inline-flex items-center gap-0.5 font-semibold ${
                    item.trend_direction === 'up'
                      ? 'text-green-600'
                      : item.trend_direction === 'down'
                      ? 'text-red-500'
                      : 'text-gray-400'
                  }`}
                >
                  <Icon
                    name={item.trend_direction === 'up' ? 'arrowUp' : item.trend_direction === 'down' ? 'arrowDown' : 'flat'}
                    size={13}
                    strokeWidth={2.5}
                  />
                  {item.percent_change > 0 ? '+' : ''}{item.percent_change}%
                </span>
              </td>
              <td className="px-4 py-3 text-center">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${confidenceBadge[item.confidence]}`}>
                  {item.confidence}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
