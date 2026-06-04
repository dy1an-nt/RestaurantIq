import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useRestaurant } from '../components/restaurant/RestaurantContext';

const STEPS = ['Create Restaurant', 'Connect Square', 'Import Data'] as const;

type StepIndex = 0 | 1 | 2;

interface SyncSuccess {
  catalogCount: number;
  orderCount: number;
}

const StepCircle = ({ index, current }: { index: number; current: number }) => {
  const done = index < current;
  const active = index === current;
  if (done) {
    return (
      <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center">
        <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }
  if (active) {
    return (
      <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center">
        <span className="text-white text-sm font-semibold">{index + 1}</span>
      </div>
    );
  }
  return (
    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
      <span className="text-gray-500 text-sm font-semibold">{index + 1}</span>
    </div>
  );
};

const Stepper = ({ current }: { current: number }) => (
  <div className="flex items-center mb-8">
    {STEPS.map((label, i) => (
      <div key={label} className="flex items-center flex-1 last:flex-none">
        <div className="flex flex-col items-center">
          <StepCircle index={i} current={current} />
          <span className={`mt-1 text-xs font-medium whitespace-nowrap ${i <= current ? 'text-navy-700' : 'text-gray-400'}`}>
            {label}
          </span>
        </div>
        {i < STEPS.length - 1 && (
          <div className={`flex-1 h-px mx-2 mb-4 ${i < current ? 'bg-navy-700' : 'bg-gray-200'}`} />
        )}
      </div>
    ))}
  </div>
);

const Onboarding = () => {
  const { restaurant, loading, refresh } = useRestaurant();
  const navigate = useNavigate();

  const [step, setStep] = useState<StepIndex>(0);

  const [restaurantName, setRestaurantName] = useState('');
  const [location, setLocation] = useState('');
  const [step1Loading, setStep1Loading] = useState(false);
  const [step1Error, setStep1Error] = useState('');

  const [locationId, setLocationId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [step2Loading, setStep2Loading] = useState(false);
  const [step2Error, setStep2Error] = useState('');

  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncSuccess, setSyncSuccess] = useState<SyncSuccess | null>(null);

  useEffect(() => {
    if (!loading && restaurant && step === 0) {
      navigate('/', { replace: true });
    }
  }, [restaurant, loading, navigate, step]);

  const handleCreateRestaurant = async (e: React.FormEvent) => {
    e.preventDefault();
    setStep1Loading(true);
    setStep1Error('');
    try {
      const res = await apiFetch('/api/restaurant', {
        method: 'POST',
        body: JSON.stringify({ name: restaurantName, location }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`);
      await refresh();
      setStep(1);
    } catch (err: any) {
      setStep1Error(err.message);
    } finally {
      setStep1Loading(false);
    }
  };

  const handleConnectSquare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restaurant) return;
    setStep2Loading(true);
    setStep2Error('');
    try {
      const res = await apiFetch('/api/integrations/square/connect', {
        method: 'POST',
        body: JSON.stringify({
          restaurant_id: restaurant.id,
          location_id: locationId.trim(),
          access_token: accessToken.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`);
      setAccessToken('');
      await refresh();
      setStep(2);
    } catch (err: any) {
      setStep2Error(err.message);
    } finally {
      setStep2Loading(false);
    }
  };

  const handleSync = async () => {
    if (!restaurant) return;
    setSyncLoading(true);
    setSyncError('');
    setSyncSuccess(null);
    try {
      const res = await apiFetch('/api/integrations/square/sync', {
        method: 'POST',
        body: JSON.stringify({ restaurant_id: restaurant.id }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`);
      setSyncSuccess({ catalogCount: body.data.catalogCount, orderCount: body.data.orderCount });
    } catch (err: any) {
      setSyncError(err.message);
    } finally {
      setSyncLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-lg w-full px-4">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-extrabold text-gray-900">Set up your restaurant</h1>
          <p className="mt-2 text-sm text-gray-600">Get up and running in a few steps</p>
        </div>

        <div className="bg-white rounded-xl shadow p-8">
          <Stepper current={step} />

          {step === 0 && (
            <form onSubmit={handleCreateRestaurant} className="space-y-5">
              {step1Error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md text-sm">
                  {step1Error}
                </div>
              )}
              <div>
                <label htmlFor="restaurantName" className="block text-sm font-medium text-gray-700">
                  Restaurant Name
                </label>
                <input
                  id="restaurantName"
                  name="restaurantName"
                  type="text"
                  required
                  placeholder="Your Restaurant Name"
                  value={restaurantName}
                  onChange={(e) => setRestaurantName(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-navy-500 focus:border-navy-500"
                />
              </div>
              <div>
                <label htmlFor="location" className="block text-sm font-medium text-gray-700">
                  Location
                </label>
                <input
                  id="location"
                  name="location"
                  type="text"
                  required
                  placeholder="123 Main St, City, State"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-navy-500 focus:border-navy-500"
                />
              </div>
              <button
                type="submit"
                disabled={step1Loading}
                className="w-full px-4 py-2 bg-navy-700 text-white text-sm font-medium rounded-md hover:bg-navy-800 disabled:opacity-50"
              >
                {step1Loading ? 'Creating…' : 'Continue'}
              </button>
            </form>
          )}

          {step === 1 && (
            <form onSubmit={handleConnectSquare} className="space-y-5">
              {step2Error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md text-sm">
                  {step2Error}
                </div>
              )}
              <div>
                <label htmlFor="locId" className="block text-sm font-medium text-gray-700">
                  Location ID
                </label>
                <input
                  id="locId"
                  type="text"
                  required
                  placeholder="L1PME46WZHPZE"
                  value={locationId}
                  disabled={step2Loading}
                  onChange={(e) => setLocationId(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-navy-500 focus:border-navy-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label htmlFor="accessToken" className="block text-sm font-medium text-gray-700">
                  Sandbox Access Token
                </label>
                <input
                  id="accessToken"
                  type="password"
                  required
                  placeholder="EAAA…"
                  autoComplete="off"
                  value={accessToken}
                  disabled={step2Loading}
                  onChange={(e) => setAccessToken(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-navy-500 focus:border-navy-500 disabled:opacity-50"
                />
              </div>
              <button
                type="submit"
                disabled={step2Loading}
                className="w-full px-4 py-2 bg-navy-700 text-white text-sm font-medium rounded-md hover:bg-navy-800 disabled:opacity-50"
              >
                {step2Loading ? 'Connecting…' : 'Connect Square'}
              </button>
              <button
                type="button"
                onClick={() => setStep(2)}
                className="w-full text-sm text-navy-700 hover:underline"
              >
                Skip for now →
              </button>
            </form>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <p className="text-sm text-gray-600">
                Syncing pulls your Square catalog and the last 30 days of orders so RestaurantIQ can start surfacing analytics and insights.
              </p>
              {syncError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md text-sm">
                  {syncError}
                </div>
              )}
              {syncSuccess ? (
                <div className="space-y-4">
                  <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-md text-sm">
                    Synced {syncSuccess.catalogCount} menu items and {syncSuccess.orderCount} orders.
                  </div>
                  <button
                    onClick={() => navigate('/')}
                    className="w-full px-4 py-2 bg-navy-700 text-white text-sm font-medium rounded-md hover:bg-navy-800"
                  >
                    Go to dashboard →
                  </button>
                </div>
              ) : (
                <>
                  <button
                    onClick={handleSync}
                    disabled={syncLoading}
                    className="w-full px-4 py-2 bg-navy-700 text-white text-sm font-medium rounded-md hover:bg-navy-800 disabled:opacity-50"
                  >
                    {syncLoading ? 'Syncing…' : 'Run sync'}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/')}
                    className="w-full text-sm text-navy-700 hover:underline"
                  >
                    Skip →
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Onboarding;