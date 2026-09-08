export type AnalyticsWindow = 7 | 30 | 90;

const OPTIONS: { value: AnalyticsWindow; label: string }[] = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
];

interface Props {
  value: AnalyticsWindow;
  onChange: (value: AnalyticsWindow) => void;
}

/**
 * Segmented control for choosing the analytics time window (7 / 30 / 90 days).
 * Controlled component: the caller owns the selected value and URL sync.
 */
const WindowSelector = ({ value, onChange }: Props) => {
  return (
    <div role="radiogroup" aria-label="Analytics time window" className="inline-flex rounded-[9px] border border-line bg-surface p-[3px] gap-[2px]">
      {OPTIONS.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(opt.value)}
            className={`px-3 h-[30px] text-[12.5px] font-bold rounded-[7px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 ${
              isActive
                ? 'bg-navy-700 text-white'
                : 'text-ink-3 hover:text-ink'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
};

export default WindowSelector;
