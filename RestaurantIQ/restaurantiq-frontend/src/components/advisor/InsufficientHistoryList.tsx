import { useState } from 'react';
import type { InsufficientItem } from '../../lib/advisorApi';
import Icon from '../Icons';

interface Props {
  items: InsufficientItem[];
}

export default function InsufficientHistoryList({ items }: Props) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
      >
        <span>Not enough history yet ({items.length} item{items.length !== 1 ? 's' : ''})</span>
        <Icon name="chevron" size={16} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-50">
          {items.map((item) => (
            <div key={item.menu_item_id} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="text-gray-700">{item.name}</span>
              <span className="text-gray-400 text-xs">{item.days_of_data} day{item.days_of_data !== 1 ? 's' : ''} of data (need 14+)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
