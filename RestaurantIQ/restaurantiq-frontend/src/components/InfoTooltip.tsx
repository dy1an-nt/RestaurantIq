import { useId, useState } from 'react';

/**
 * Accessible info tooltip (Sprint S, review R8 / trust).
 *
 * Used to answer "what does this number mean / where did it come from" right
 * next to the metric, so an owner never has to guess. Built for keyboard and
 * screen-reader users, not just hover: the trigger is a real focusable button,
 * the bubble opens on focus as well as hover, Escape dismisses it, and the
 * bubble is wired to the button via `aria-describedby` so assistive tech reads
 * the explanation.
 */
interface InfoTooltipProps {
  /** Plain-text explanation shown in the bubble (and announced to screen readers). */
  text: string;
  /** Accessible name for the trigger. Defaults to "More information". */
  label?: string;
  className?: string;
}

const InfoTooltip = ({ text, label = 'More information', className = '' }: InfoTooltipProps) => {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className={`relative inline-flex align-middle ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        className="inline-flex items-center justify-center w-[15px] h-[15px] rounded-full text-ink-3 hover:text-navy-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="11" x2="12" y2="16" strokeLinecap="round" />
          <circle cx="12" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="absolute z-30 left-1/2 -translate-x-1/2 bottom-full mb-2 w-56 rounded-lg bg-ink text-white text-[12px] font-medium leading-snug px-3 py-2 shadow-lg pointer-events-none"
        >
          {text}
        </span>
      )}
    </span>
  );
};

export default InfoTooltip;
