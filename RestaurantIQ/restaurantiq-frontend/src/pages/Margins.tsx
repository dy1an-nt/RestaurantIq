import { useState } from 'react';
import MarginAnalysis from './MarginAnalysis';
import ChannelMargins from './ChannelMargins';
import LastSyncedIndicator from '../components/LastSyncedIndicator';

/**
 * Consolidated Margins page (Sprint S, review R14).
 *
 * Previously "Margins" (item-level profitability) and "Channel Margins"
 * (in-house vs DoorDash) were two separate nav destinations whose distinction
 * an owner wouldn't grasp. They're now two tabs under one "Margins" page: the
 * relationship is obvious, the nav is one item shorter, and each tab reuses its
 * original page component unchanged (rendered with `embedded` so it drops its
 * own title in favor of this shell's).
 */
type TabKey = 'item' | 'channel';

const TABS: { key: TabKey; label: string; subtitle: string }[] = [
  {
    key: 'item',
    label: 'Item Margins',
    subtitle: 'Profitability by item — margins, repricing opportunities, and top contributors',
  },
  {
    key: 'channel',
    label: 'Channel Margins',
    subtitle: 'In-house vs DoorDash — true margin after delivery commission · Last 30 days',
  },
];

const Margins = () => {
  const [tab, setTab] = useState<TabKey>('item');
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <div className="max-w-5xl">
      <div className="mb-[18px] flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">Margins</h1>
          <p className="mt-[5px] text-[13.5px] font-medium text-ink-3">{active.subtitle}</p>
        </div>
        <LastSyncedIndicator />
      </div>

      {/* Tab bar */}
      <div role="tablist" aria-label="Margin views" className="flex gap-1 border-b border-line mb-6">
        {TABS.map((t) => {
          const isActive = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`margins-tab-${t.key}`}
              aria-selected={isActive}
              aria-controls="margins-tabpanel"
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 -mb-px border-b-2 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 rounded-t ${
                isActive
                  ? 'border-navy-700 text-navy-700'
                  : 'border-transparent text-ink-3 hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="margins-tabpanel" aria-labelledby={`margins-tab-${tab}`}>
        {tab === 'item' ? <MarginAnalysis embedded /> : <ChannelMargins embedded />}
      </div>
    </div>
  );
};

export default Margins;
