import { Link, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { useUnreadAlerts } from '../lib/useUnreadAlerts';
import Icon from './Icons';

/** Maps the active route to a topbar breadcrumb. */
const ROUTE_META: Record<string, { crumb: string; title: string }> = {
  '/': { crumb: 'Dashboard', title: 'Menu Performance' },
  '/analytics': { crumb: 'Analytics', title: 'Analytics' },
  '/margins': { crumb: 'Margins', title: 'Margins' },
  '/ai': { crumb: 'AI Assistant', title: 'AI Assistant' },
  '/advisor': { crumb: 'Forecast', title: 'Demand Forecast' },
  '/alerts': { crumb: 'Alerts', title: 'Alerts' },
  '/marketing': { crumb: 'Marketing', title: 'Marketing' },
  '/integrations': { crumb: 'Integrations', title: 'Integrations' },
  '/settings': { crumb: 'Settings', title: 'Settings' },
  '/sync-health': { crumb: 'Sync Health', title: 'Sync Health' },
};

function avatarInitials(email: string | undefined): string {
  if (!email) return 'RIQ'.slice(0, 2);
  const name = email.split('@')[0];
  const parts = name.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const Topbar = () => {
  const location = useLocation();
  const { user } = useAuth();
  const unread = useUnreadAlerts();

  const meta = ROUTE_META[location.pathname] ?? { crumb: 'Dashboard', title: '' };
  const isDashboard = location.pathname === '/';

  return (
    <header className="h-16 flex-shrink-0 bg-surface border-b border-line flex items-center gap-[14px] px-[26px]">
      {/* Breadcrumb */}
      <div className="text-[13.5px] font-semibold text-ink-3 whitespace-nowrap">
        <b className="text-ink font-bold">{meta.crumb}</b>
        {meta.title && meta.title !== meta.crumb && (
          <>&nbsp;/&nbsp;{meta.title}</>
        )}
      </div>

      <div className="flex-1" />

      {/* Analysis window — every surface uses a fixed trailing-30-day window.
          Shown as a static badge (not a control) so it doesn't imply a date
          picker the product doesn't have. */}
      <div className="hidden sm:flex items-center gap-2 h-[38px] px-[13px] border border-line rounded-[9px] text-[13.5px] font-semibold text-ink-2 bg-surface whitespace-nowrap">
        <Icon name="calendar" size={16} className="text-ink-3" />
        <span>Last 30 days</span>
      </div>

      {/* Primary action */}
      {isDashboard ? (
        <Link
          to="/integrations"
          className="flex items-center gap-2 h-[38px] px-4 rounded-[9px] bg-navy-700 text-white text-[13.5px] font-bold hover:bg-navy-800 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 focus-visible:ring-offset-2"
        >
          <Icon name="sync" size={17} />
          Run sync
        </Link>
      ) : (
        <Link
          to="/alerts"
          className="relative w-[38px] h-[38px] rounded-[9px] border border-line bg-surface flex items-center justify-center text-ink-2 hover:bg-canvas transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500"
          aria-label={unread > 0 ? `Alerts, ${unread} unread` : 'Alerts'}
        >
          <Icon name="bell" size={18} />
          {unread > 0 && (
            <span className="absolute top-2 right-[9px] w-1.5 h-1.5 rounded-full bg-neg" />
          )}
        </Link>
      )}

      {/* Avatar → Settings */}
      <Link
        to="/settings"
        aria-label="Settings and account"
        className="w-[38px] h-[38px] rounded-full bg-navy-100 text-navy-700 text-[13px] font-extrabold flex items-center justify-center flex-shrink-0 hover:bg-navy-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 focus-visible:ring-offset-2"
      >
        {avatarInitials(user?.email)}
      </Link>
    </header>
  );
};

export default Topbar;
