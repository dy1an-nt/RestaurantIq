import { Link } from 'react-router-dom';
import { useAuth } from '../components/auth/AuthContext';
import { useRestaurant } from '../components/restaurant/RestaurantContext';
import { useDevMode } from '../lib/useDevMode';
import Icon from '../components/Icons';

/**
 * Settings (Sprint S).
 *
 * A lightweight account/restaurant hub reached from the sidebar's account card —
 * deliberately NOT a top-level nav item, so it doesn't add to the owner's daily
 * navigation. It also hosts the developer-mode toggle that reveals engineering
 * surfaces (Sync Health), keeping those out of the owner's way by default.
 */
const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between px-5 py-3.5 border-t border-line first:border-t-0">
    <span className="text-[13px] font-semibold text-ink-3">{label}</span>
    <span className="text-sm font-semibold text-ink text-right truncate ml-4">{value}</span>
  </div>
);

const Settings = () => {
  const { user, signOut } = useAuth();
  const { restaurant } = useRestaurant();
  const [devMode, setDevMode] = useDevMode();

  const posStatus = restaurant?.pos_connected ? 'Square connected' : 'Not connected';
  const deliveryStatus = restaurant?.delivery_connected ? 'DoorDash connected' : 'Not connected';

  return (
    <div className="max-w-2xl">
      <div className="mb-[22px]">
        <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">Settings</h1>
        <p className="mt-[5px] text-[13.5px] font-medium text-ink-3">
          Account, restaurant, and developer options
        </p>
      </div>

      {/* Account */}
      <section className="bg-surface border border-line rounded shadow-sm mb-5">
        <div className="px-5 py-3 border-b border-line">
          <h2 className="text-[11px] font-bold tracking-[0.07em] uppercase text-ink-3">Account</h2>
        </div>
        <Row label="Email" value={user?.email ?? '—'} />
      </section>

      {/* Restaurant */}
      <section className="bg-surface border border-line rounded shadow-sm mb-5">
        <div className="px-5 py-3 border-b border-line flex items-center justify-between">
          <h2 className="text-[11px] font-bold tracking-[0.07em] uppercase text-ink-3">Restaurant</h2>
          <Link to="/integrations" className="text-[12px] font-bold text-navy-700 hover:underline">
            Manage integrations →
          </Link>
        </div>
        <Row label="Name" value={restaurant?.name ?? '—'} />
        <Row label="Location" value={restaurant?.location ?? '—'} />
        <Row label="Point of sale" value={posStatus} />
        <Row label="Delivery" value={deliveryStatus} />
      </section>

      {/* Developer */}
      <section className="bg-surface border border-line rounded shadow-sm mb-5">
        <div className="px-5 py-3 border-b border-line">
          <h2 className="text-[11px] font-bold tracking-[0.07em] uppercase text-ink-3">Developer</h2>
        </div>
        <div className="flex items-center justify-between px-5 py-4">
          <div className="pr-4">
            <p className="text-sm font-bold text-ink">Show developer tools</p>
            <p className="text-[12.5px] text-ink-3 mt-0.5">
              Reveals engineering surfaces like Sync Health in the sidebar. Off by default —
              these are diagnostics, not business analytics.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={devMode}
            aria-label="Show developer tools"
            onClick={() => setDevMode(!devMode)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 focus-visible:ring-offset-2 ${
              devMode ? 'bg-navy-700' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                devMode ? 'translate-x-[22px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </section>

      <button
        onClick={() => signOut()}
        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-line text-sm font-semibold text-ink-2 hover:bg-canvas transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500"
      >
        <Icon name="signout" size={18} />
        Sign out
      </button>
    </div>
  );
};

export default Settings;
