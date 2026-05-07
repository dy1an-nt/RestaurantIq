import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useRestaurant } from '../components/restaurant/RestaurantContext';

interface SyncResult {
  ok: boolean;
  mock?: boolean;
  catalogCount: number;
  orderCount: number;
  fallbackUsedPayments?: boolean;
  message?: string;
}

interface SquareStatus {
  mock: boolean;
  environment: string;
}

const authedFetch = async (url: string, init: RequestInit = {}) => {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  return fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
      Authorization: `Bearer ${session.access_token}`,
    },
  });
};

const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="bg-white rounded-xl shadow p-6 space-y-4">
    <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
    {children}
  </div>
);

const Pill = ({ tone, children }: { tone: 'green' | 'gray' | 'yellow' | 'red'; children: React.ReactNode }) => {
  const tones = {
    green: 'bg-green-100 text-green-700',
    gray: 'bg-gray-100 text-gray-600',
    yellow: 'bg-yellow-100 text-yellow-700',
    red: 'bg-red-100 text-red-700',
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${tones[tone]}`}>{children}</span>;
};

const Integrations = () => {
  const { restaurant, refresh } = useRestaurant();

  // Square form state
  const [locationId, setLocationId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectMsg, setConnectMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // Sync state
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncErr, setSyncErr] = useState<string | null>(null);

  // Backend status
  const [status, setStatus] = useState<SquareStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch('/api/integrations/square/status');
        const body = await res.json();
        if (!cancelled && res.ok && !body.error) setStatus(body.data as SquareStatus);
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restaurant) return;
    setConnectBusy(true);
    setConnectMsg(null);
    try {
      const res = await authedFetch('/api/integrations/square/connect', {
        method: 'POST',
        body: JSON.stringify({
          restaurant_id: restaurant.id,
          location_id: locationId.trim(),
          access_token: accessToken.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `Connect failed (${res.status})`);
      setConnectMsg({ tone: 'ok', text: 'Connected. Square credentials saved.' });
      setAccessToken(''); // don't keep token in DOM
      await refresh();
    } catch (err: any) {
      setConnectMsg({ tone: 'err', text: err.message });
    } finally {
      setConnectBusy(false);
    }
  };

  const handleSync = async () => {
    if (!restaurant) return;
    setSyncBusy(true);
    setSyncErr(null);
    setSyncResult(null);
    try {
      const res = await authedFetch('/api/integrations/square/sync', {
        method: 'POST',
        body: JSON.stringify({ restaurant_id: restaurant.id }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `Sync failed (${res.status})`);
      setSyncResult(body.data as SyncResult);
    } catch (err: any) {
      setSyncErr(err.message);
    } finally {
      setSyncBusy(false);
    }
  };

  const connected = !!restaurant?.square_location_id;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
        <p className="text-sm text-gray-500 mt-1">Connect a POS to start pulling live menu and order data.</p>
      </div>

      <Card title="Square">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-600">Status:</span>
          {connected
            ? <Pill tone="green">Connected · {restaurant.square_location_id}</Pill>
            : <Pill tone="gray">Not connected</Pill>}
          {status && (
            <Pill tone={status.mock ? 'yellow' : 'gray'}>
              {status.mock ? 'mock mode' : 'live'} · {status.environment}
            </Pill>
          )}
        </div>

        <form onSubmit={handleConnect} className="space-y-3 pt-2">
          <div>
            <label htmlFor="locId" className="block text-sm font-medium text-gray-700">Location ID</label>
            <input
              id="locId"
              type="text"
              required
              placeholder="L1PME46WZHPZE"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="tok" className="block text-sm font-medium text-gray-700">Sandbox Access Token</label>
            <input
              id="tok"
              type="password"
              required
              placeholder="EAAA…"
              autoComplete="off"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              Get one from <a href="https://developer.squareup.com/apps" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">developer.squareup.com</a> → your app → Sandbox → Credentials.
            </p>
          </div>
          <button
            type="submit"
            disabled={connectBusy || !restaurant}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {connectBusy ? 'Saving…' : connected ? 'Update credentials' : 'Connect Square'}
          </button>
          {connectMsg && (
            <div className={`text-sm ${connectMsg.tone === 'ok' ? 'text-green-700' : 'text-red-600'}`}>
              {connectMsg.text}
            </div>
          )}
        </form>

        <div className="border-t border-gray-100 pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-900">Pull catalog + orders</div>
              <div className="text-xs text-gray-500">Refreshes menu items, orders, and the last 30 days of summaries.</div>
            </div>
            <button
              onClick={handleSync}
              disabled={syncBusy || !connected}
              className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-800 disabled:opacity-50"
            >
              {syncBusy ? 'Syncing…' : 'Run sync'}
            </button>
          </div>
          {syncErr && <div className="text-sm text-red-600">{syncErr}</div>}
          {syncResult && (
            <div className="text-sm text-gray-700 bg-gray-50 rounded-md p-3 space-y-1">
              <div>
                <Pill tone={syncResult.ok ? 'green' : 'red'}>{syncResult.ok ? 'success' : 'failed'}</Pill>
                {syncResult.mock && <span className="ml-2"><Pill tone="yellow">mock</Pill></span>}
                {syncResult.fallbackUsedPayments && <span className="ml-2"><Pill tone="gray">payments fallback</Pill></span>}
              </div>
              <div>Catalog items: <strong>{syncResult.catalogCount}</strong></div>
              <div>New orders: <strong>{syncResult.orderCount}</strong></div>
              {syncResult.message && <div className="text-xs text-gray-500">{syncResult.message}</div>}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

export default Integrations;
