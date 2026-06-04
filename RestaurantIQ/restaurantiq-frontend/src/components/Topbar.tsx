import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { useUnreadAlerts } from '../lib/useUnreadAlerts';
import Icon from './Icons';

/** Maps the active route to a topbar breadcrumb. */
const ROUTE_META: Record<string, { crumb: string; title: string }> = {
  '/': { crumb: 'Dashboard', title: 'Menu Performance' },
  '/analytics': { crumb: 'Analytics', title: 'Analytics' },
  '/margins': { crumb: 'Margins', title: 'Margins' },
  '/insights': { crumb: 'AI Insights', title: 'AI Insights' },
  '/alerts': { crumb: 'Alerts', title: 'Alerts' },
  '/marketing': { crumb: 'Marketing', title: 'Marketing' },
  '/integrations': { crumb: 'Integrations', title: 'Integrations' },
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
  const [search, setSearch] = useState('');

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

      {/* Search (menu items) */}
      <div className="hidden md:flex items-center gap-[9px] h-[38px] w-[248px] px-[13px] border border-line rounded-[9px] text-ink-3 bg-surface focus-within:border-navy-500 focus-within:shadow-[0_0_0_3px_#f1f5fa]">
        <Icon name="search" size={17} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search menu items…"
          className="border-0 outline-none bg-transparent w-full text-[13.5px] text-ink placeholder:text-ink-3"
        />
      </div>

      {/* Date range (fixed 30-day window) */}
      <div className="hidden sm:flex items-center gap-2 h-[38px] px-[13px] border border-line rounded-[9px] text-[13.5px] font-semibold text-ink-2 bg-surface whitespace-nowrap">
        <Icon name="calendar" size={16} className="text-ink-3" />
        <span>Last 30 days</span>
        <Icon name="chevron" size={15} className="text-ink-3" />
      </div>

      {/* Primary action */}
      {isDashboard ? (
        <Link
          to="/integrations"
          className="flex items-center gap-2 h-[38px] px-4 rounded-[9px] bg-navy-700 text-white text-[13.5px] font-bold hover:bg-navy-800 transition-colors whitespace-nowrap"
        >
          <Icon name="sync" size={17} />
          Run sync
        </Link>
      ) : (
        <Link
          to="/alerts"
          className="relative w-[38px] h-[38px] rounded-[9px] border border-line bg-surface flex items-center justify-center text-ink-2 hover:bg-canvas transition-colors"
          aria-label="Alerts"
        >
          <Icon name="bell" size={18} />
          {unread > 0 && (
            <span className="absolute top-2 right-[9px] w-1.5 h-1.5 rounded-full bg-neg" />
          )}
        </Link>
      )}

      {/* Avatar */}
      <div className="w-[38px] h-[38px] rounded-full bg-navy-100 text-navy-700 text-[13px] font-extrabold flex items-center justify-center flex-shrink-0">
        {avatarInitials(user?.email)}
      </div>
    </header>
  );
};

export default Topbar;
