import { NavLink } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { useRestaurant } from './restaurant/RestaurantContext';
import { useUnreadAlerts } from '../lib/useUnreadAlerts';
import Icon, { IconName } from './Icons';
import Logo from './Logo';

interface NavItem {
  label: string;
  path: string;
  icon: IconName;
  end?: boolean;
}

const navItems: NavItem[] = [
  { label: 'Dashboard', path: '/', icon: 'dashboard', end: true },
  { label: 'Analytics', path: '/analytics', icon: 'analytics' },
  { label: 'Margins', path: '/margins', icon: 'margins' },
  { label: 'AI Insights', path: '/insights', icon: 'insights' },
  { label: 'Alerts', path: '/alerts', icon: 'alerts' },
  { label: 'Marketing', path: '/marketing', icon: 'marketing' },
  { label: 'Integrations', path: '/integrations', icon: 'integrations' },
  { label: 'Sync Health', path: '/sync-health', icon: 'sync' },
  { label: 'AI Chat', path: '/chat', icon: 'chat' },
  { label: 'Purchasing Advisor', path: '/advisor', icon: 'advisor' },
];

/** Two-letter initials from a restaurant name ("Bella Trattoria" → "BT"). */
function initials(name: string | undefined): string {
  if (!name) return 'RIQ'.slice(0, 2);
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'R';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const Sidebar = () => {
  const { signOut } = useAuth();
  const { restaurant } = useRestaurant();
  const unread = useUnreadAlerts();

  const source = restaurant?.pos_connected ? 'Square' : 'Not connected';
  const metaLine = [restaurant?.location, source].filter(Boolean).join(' · ');

  return (
    <aside className="w-[248px] flex-shrink-0 bg-surface border-r border-line flex flex-col h-screen sticky top-0 z-10">
      {/* Brand */}
      <div className="flex items-center gap-[11px] px-5 pt-5 pb-[18px]">
        <Logo size={30} on="navy" />
        <span className="text-[18px] font-extrabold tracking-[-0.03em] text-ink">
          Restaurant<span className="text-navy-700">IQ</span>
        </span>
      </div>

      {/* Section label */}
      <div className="px-[14px] pt-1 pb-1.5 mt-1.5 text-[11px] font-bold tracking-[0.09em] uppercase text-ink-3">
        Overview
      </div>

      {/* Nav */}
      <nav className="px-[14px] py-1.5 flex flex-col gap-[3px] flex-1">
        {navItems.map((item) => {
          const showBadge = item.path === '/alerts' && unread > 0;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
              className={({ isActive }) =>
                `group relative flex items-center gap-3 px-3 py-[9px] rounded-lg text-sm font-semibold whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-navy-700 text-white'
                    : 'text-ink-2 hover:bg-navy-50 hover:text-ink'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    name={item.icon}
                    size={19}
                    className={
                      isActive ? 'text-white' : 'text-ink-3 group-hover:text-navy-600'
                    }
                  />
                  <span>{item.label}</span>
                  {showBadge && (
                    <span
                      className={`ml-auto inline-flex items-center justify-center min-w-[19px] h-[19px] px-[5px] rounded-[10px] text-[11px] font-bold ${
                        isActive ? 'bg-white/[0.18] text-white' : 'bg-neg-bg text-neg'
                      }`}
                    >
                      {unread}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-[14px] border-t border-line flex flex-col gap-1">
        <NavLink
          to="/integrations"
          className="flex items-center gap-[11px] px-[10px] py-[9px] rounded-[9px] border border-line hover:bg-canvas transition-colors"
        >
          <span className="w-[30px] h-[30px] rounded-lg bg-navy-700 text-white text-xs font-extrabold flex items-center justify-center flex-shrink-0">
            {initials(restaurant?.name)}
          </span>
          <span className="min-w-0 leading-[1.25]">
            <span className="block text-[13px] font-bold text-ink whitespace-nowrap truncate">
              {restaurant?.name ?? 'Your restaurant'}
            </span>
            <span className="block text-[11.5px] text-ink-3 whitespace-nowrap truncate">
              {metaLine || '—'}
            </span>
          </span>
          <Icon name="chevron" size={16} className="ml-auto text-ink-3 flex-shrink-0" />
        </NavLink>

        <button
          onClick={() => signOut()}
          className="flex items-center gap-3 px-3 py-[9px] rounded-lg text-[13.5px] font-semibold text-ink-3 hover:bg-canvas hover:text-ink-2 transition-colors"
        >
          <Icon name="signout" size={18} />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
