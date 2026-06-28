import { Link } from 'react-router-dom';
import Icon, { IconName } from './Icons';

/**
 * Standard empty state (Sprint S, review L8).
 *
 * The review found only 6/18 data views had explicit empty-state handling, and
 * those that did were styled ad hoc. This is the one shared treatment: an icon,
 * a plain-language title, a sentence on *why* it's empty and what to do, and an
 * optional primary action — so an empty screen reads as "here's your next step,"
 * not "the product is broken."
 */
interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: string;
  action?: { label: string; to: string };
}

const EmptyState = ({ icon, title, description, action }: EmptyStateProps) => (
  <div className="bg-surface border border-line rounded p-12 text-center">
    {icon && (
      <div className="w-12 h-12 rounded-xl bg-navy-50 text-navy-700 flex items-center justify-center mx-auto mb-4">
        <Icon name={icon} size={24} />
      </div>
    )}
    <p className="text-lg font-extrabold text-ink">{title}</p>
    {description && (
      <p className="text-sm text-ink-3 mt-2 max-w-md mx-auto leading-relaxed">{description}</p>
    )}
    {action && (
      <Link
        to={action.to}
        className="inline-flex items-center mt-6 px-4 h-[44px] bg-navy-700 text-white text-sm font-bold rounded-[9px] hover:bg-navy-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 focus-visible:ring-offset-2"
      >
        {action.label}
      </Link>
    )}
  </div>
);

export default EmptyState;
