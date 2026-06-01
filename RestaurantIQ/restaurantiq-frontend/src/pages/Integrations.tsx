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

interface IntegrationStatus {
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

/**
 * Per-provider configuration. Everything that differs between Square and
 * DoorDash lives here; the IntegrationCard below renders identical UI/behavior
 * for both, so the DoorDash flow mirrors Square 1:1 by construction.
 */
interface IntegrationConfig {
  title: string;
  /** API base, e.g. '/api/integrations/square'. */
  basePath: string;
  /** Body key for the store/location identifier on /connect. */
  idField: string;
  idLabel: string;
  idPlaceholder: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenHelp: React.ReactNode;
  /** Whether the provider is currently connected (derived from restaurant row). */
  connected: boolean;
  /** Short identifier to show next to the "Connected" pill. */
  connectedLabel: string | null;
  /** Whether to render a disconnect button (provider must back /disconnect). */
  supportsDisconnect?: boolean;
}

const IntegrationCard = ({ config }: { config: IntegrationConfig }) => {
  const { restaurant, refresh } = useRestaurant();

  // Connect form state
  const [idValue, setIdValue] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectMsg, setConnectMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // Sync state
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncErr, setSyncErr] = useState<string | null>(null);

  // Disconnect state
  const [disconnectBusy, setDisconnectBusy] = useState(false);

  // Backend status
  const [status, setStatus] = useState<IntegrationStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(`${config.basePath}/status`);
        const body = await res.json();
        if (!cancelled && res.ok && !body.error) setStatus(body.data as IntegrationStatus);
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, [config.basePath]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restaurant) return;
    setConnectBusy(true);
    setConnectMsg(null);
    try {
      const res = await authedFetch(`${config.basePath}/connect`, {
        method: 'POST',
        body: JSON.stringify({
          restaurant_id: restaurant.id,
          [config.idField]: idValue.trim(),
          access_token: accessToken.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `Connect failed (${res.status})`);
      setConnectMsg({ tone: 'ok', text: `Connected. ${config.title} credentials saved.` });
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
      const res = await authedFetch(`${config.basePath}/sync`, {
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

  const handleDisconnect = async () => {
    if (!restaurant) return;
    setDisconnectBusy(true);
    setConnectMsg(null);
    try {
      const res = await authedFetch(`${config.basePath}/disconnect`, {
        method: 'POST',
        body: JSON.stringify({ restaurant_id: restaurant.id }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `Disconnect failed (${res.status})`);
      setSyncResult(null);
      setConnectMsg({ tone: 'ok', text: `${config.title} disconnected.` });
      await refresh();
    } catch (err: any) {
      setConnectMsg({ tone: 'err', text: err.message });
    } finally {
      setDisconnectBusy(false);
    }
  };

  const connected = config.connected;

  return (
    <Card title={config.title}>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-600">Status:</span>
        {connected
          ? <Pill tone="green">Connected · {config.connectedLabel}</Pill>
          : <Pill tone="gray">Not connected</Pill>}
        {status && (
          <Pill tone={status.mock ? 'yellow' : 'gray'}>
            {status.mock ? 'mock mode' : 'live'} · {status.environment}
          </Pill>
        )}
      </div>

      <form onSubmit={handleConnect} className="space-y-3 pt-2">
        <div>
          <label htmlFor={`${config.basePath}-id`} className="block text-sm font-medium text-gray-700">{config.idLabel}</label>
          <input
            id={`${config.basePath}-id`}
            type="text"
            required
            placeholder={config.idPlaceholder}
            value={idValue}
            disabled={connectBusy}
            onChange={(e) => setIdValue(e.target.value)}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
          />
        </div>
        <div>
          <label htmlFor={`${config.basePath}-tok`} className="block text-sm font-medium text-gray-700">{config.tokenLabel}</label>
          <input
            id={`${config.basePath}-tok`}
            type="password"
            required
            placeholder={config.tokenPlaceholder}
            autoComplete="off"
            value={accessToken}
            disabled={connectBusy}
            onChange={(e) => setAccessToken(e.target.value)}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-gray-500">{config.tokenHelp}</p>
        </div>
        <button
          type="submit"
          disabled={connectBusy || !restaurant}
          className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
        >
          {connectBusy ? 'Saving…' : connected ? 'Update credentials' : `Connect ${config.title}`}
        </button>
        {connected && config.supportsDisconnect && (
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={disconnectBusy}
            className="ml-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 disabled:opacity-50"
          >
            {disconnectBusy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
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
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={handleSync}
              disabled={syncBusy || !connected}
              className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-800 disabled:opacity-50"
            >
              {syncBusy ? 'Syncing…' : 'Run sync'}
            </button>
            {!connected && (
              <p className="text-xs text-gray-400">Connect {config.title} first to enable sync.</p>
            )}
          </div>
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
  );
};

const Integrations = () => {
  const { restaurant } = useRestaurant();

  const squareConfig: IntegrationConfig = {
    title: 'Square',
    basePath: '/api/integrations/square',
    idField: 'location_id',
    idLabel: 'Location ID',
    idPlaceholder: 'L1PME46WZHPZE',
    tokenLabel: 'Sandbox Access Token',
    tokenPlaceholder: 'EAAA…',
    tokenHelp: (
      <>
        Get one from <a href="https://developer.squareup.com/apps" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">developer.squareup.com</a> → your app → Sandbox → Credentials.
      </>
    ),
    connected: !!restaurant?.square_location_id,
    connectedLabel: restaurant?.square_location_id ?? null,
  };

  const doordashConfig: IntegrationConfig = {
    title: 'DoorDash',
    basePath: '/api/integrations/doordash',
    idField: 'store_id',
    idLabel: 'Store ID',
    idPlaceholder: 'st_1a2b3c4d',
    tokenLabel: 'Access Token',
    tokenPlaceholder: 'ddx_…',
    tokenHelp: (
      <>
        Get one from <a href="https://developer.doordash.com" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">developer.doordash.com</a> → your app → Credentials.
      </>
    ),
    connected: !!restaurant?.doordash_store_id,
    connectedLabel: restaurant?.doordash_store_id ?? null,
    supportsDisconnect: true,
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
        <p className="text-sm text-gray-500 mt-1">Connect a POS or delivery app to start pulling live menu and order data.</p>
      </div>

      <IntegrationCard config={squareConfig} />
      <IntegrationCard config={doordashConfig} />
    </div>
  );
};

export default Integrations;
