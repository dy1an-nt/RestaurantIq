import { NavLink } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';

const navItems = [
  { label: 'Dashboard', path: '/', icon: '📊' },
  { label: 'Analytics', path: '/analytics', icon: '📈' },
  { label: 'Margins', path: '/margins', icon: '💰' },
  { label: 'AI Insights', path: '/insights', icon: '🤖' },
  { label: 'Alerts', path: '/alerts', icon: '🔔' },
  { label: 'Marketing', path: '/marketing', icon: '📢' },
  { label: 'Integrations', path: '/integrations', icon: '🔌' },
];

const Sidebar = () => {
  const { signOut } = useAuth();

  return (
    <div className="flex flex-col w-64 min-h-screen bg-gray-900 text-white flex-shrink-0">
      <div className="px-6 py-5 border-b border-gray-700">
        <span className="text-xl font-bold tracking-tight">RestaurantIQ</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`
            }
          >
            <span>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-gray-700">
        <button
          onClick={() => signOut()}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <span>🚪</span>
          Sign Out
        </button>
      </div>
    </div>
  );
};

export default Sidebar;
