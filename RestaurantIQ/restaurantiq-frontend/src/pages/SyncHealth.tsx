import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useRestaurant } from '../components/restaurant/RestaurantContext';

// ---------- types ----------------------------------------------------------

type SyncStatus =
  | 'connected'
  | 'syncing'
  | 'success'
  | 'failed'
  | 'disconnected'
  | 'token_expired';

interface ProviderHealth {
  provider: 'square' | 'doordash';
  connected: boolean;
  status: SyncStatus;
  last_success_at: string | null;
  last_attempted_at: string | null;
  last_error: string | null;
  retry_count: number;
  next_retry_at: string | null;
}

interface SchedulerInfo {
  is_leader: boolean;
  leader_instance_id: string | null;
  leader_acquired_at: string | null;
  last_tick_at: string | null;
  last_tick_jobs_processed: number;
  pending_retries: number;
}

interface MetricsSummary {
  total_syncs: number;
  successful_syncs: number;
  failed_syncs: number;
  success_rate: number;
  average_duration_ms: number;
  retry_count: number;
  active_sync_count: number;
  last_successful_sync_at: string | null;
  last_failed_sync_at: string | null;
}

interface RecentJob {
  id: string;
  provider: string;
  trigger: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  retry_count: number;
  last_error: string | null;
  next_retry_at: string | null;
  created_at: string;
}

interface SyncMetricsData {
  scheduler: SchedulerInfo;
  metrics: MetricsSummary;
  integrations: { square: ProviderHealth; doordash: ProviderHealth };
  recent_jobs: RecentJob[];
}

// ---------- helpers --------------------------------------------------------

const relativeTime = (iso: string | null): string => {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const formatDuration = (ms: number | null): string => {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const formatPercent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

const STATUS_DISPLAY: Record<SyncStatus, { tone: 'green' | 'gray' | 'yellow' | 'red'; label: string }> = {
  success: { tone: 'green', label: 'Up to date' },
  connected: { tone: 'gray', label: 'Connected' },
  syncing: { tone: 'yellow', label: 'Syncing…' },
  failed: { tone: 'red', label: 'Sync failed' },
  token_expired: { tone: 'red', label: 'Reconnect required' },
  disconnected: { tone: 'gray', label: 'Disconnected' },
};

// job status → pill tone (open-ended strings from the API)
const jobStatusTone = (status: string): 'green' | 'gray' | 'yellow' | 'red' => {
  if (status === 'success' || status === 'completed') return 'green';
  if (status === 'running' || status === 'syncing' || status === 'pending_retry') return 'yellow';
  if (status === 'failed' || status === 'error' || status === 'failed_permanently') return 'red';
  return 'gray';
};

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

// ---------- shared UI primitives -------------------------------------------

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
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
};

const StatTile = ({ label, value }: { label: string; value: string | number }) => (
  <div className="bg-gray-50 rounded-lg p-4 space-y-1">
    <div className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</div>
    <div className="text-2xl font-bold text-gray-900">{value}</div>
  </div>
);

// ---------- section components ---------------------------------------------

const SchedulerSection = ({ scheduler }: { scheduler: SchedulerInfo }) => (
  <Card title="Scheduler Health">
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-3">
        <span className="text-gray-600 w-40 flex-shrink-0">Leader status</span>
        <Pill tone={scheduler.is_leader ? 'green' : 'gray'}>
          {scheduler.is_leader ? 'Leader' : 'Standby'}
        </Pill>
        {scheduler.leader_instance_id && (
          <span className="text-gray-400 text-xs font-mono truncate" title={scheduler.leader_instance_id}>
            {scheduler.leader_instance_id}
          </span>
        )}
      </div>
      {scheduler.leader_acquired_at && (
        <div className="flex items-center gap-3">
          <span className="text-gray-600 w-40 flex-shrink-0">Leader since</span>
          <span className="text-gray-700" title={scheduler.leader_acquired_at}>
            {relativeTime(scheduler.leader_acquired_at)}
          </span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <span className="text-gray-600 w-40 flex-shrink-0">Last scheduler tick</span>
        <span className="text-gray-700" title={scheduler.last_tick_at ?? undefined}>
          {relativeTime(scheduler.last_tick_at)}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-gray-600 w-40 flex-shrink-0">Jobs (last tick)</span>
        <span className="text-gray-700">{scheduler.last_tick_jobs_processed}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-gray-600 w-40 flex-shrink-0">Pending retries</span>
        <span className={scheduler.pending_retries > 0 ? 'text-yellow-700 font-semibold' : 'text-gray-700'}>
          {scheduler.pending_retries}
        </span>
      </div>
    </div>
  </Card>
);

const MetricsSection = ({ metrics }: { metrics: MetricsSummary }) => (
  <Card title="Metrics Overview">
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      <StatTile label="Total syncs" value={metrics.total_syncs} />
      <StatTile label="Successful" value={metrics.successful_syncs} />
      <StatTile label="Failed" value={metrics.failed_syncs} />
      <StatTile label="Success rate" value={formatPercent(metrics.success_rate)} />
      <StatTile label="Avg duration" value={formatDuration(metrics.average_duration_ms)} />
      <StatTile label="Active syncs" value={metrics.active_sync_count} />
      <StatTile label="Total retries" value={metrics.retry_count} />
    </div>
    <div className="border-t border-gray-100 pt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
      <div className="flex justify-between text-gray-600">
        <span>Last successful sync</span>
        <span className="text-gray-800" title={metrics.last_successful_sync_at ?? undefined}>
          {relativeTime(metrics.last_successful_sync_at)}
        </span>
      </div>
      <div className="flex justify-between text-gray-600">
        <span>Last failed sync</span>
        <span className="text-gray-800" title={metrics.last_failed_sync_at ?? undefined}>
          {relativeTime(metrics.last_failed_sync_at)}
        </span>
      </div>
    </div>
  </Card>
);

const ProviderHealthRow = ({ health, providerLabel }: { health: ProviderHealth; providerLabel: string }) => {
  const display = STATUS_DISPLAY[health.status] ?? { tone: 'gray' as const, label: health.status };
  const showFailureDetails =
    (health.status === 'failed' || health.status === 'token_expired' || !!health.last_error);

  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">{providerLabel}</span>
          <Pill tone={health.connected ? 'green' : 'gray'}>
            {health.connected ? 'Connected' : 'Not connected'}
          </Pill>
        </div>
        <Pill tone={display.tone}>{display.label}</Pill>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
        <div>
          <span className="text-gray-400">Last successful sync</span>
          <div className="text-gray-700 mt-0.5" title={health.last_success_at ?? undefined}>
            {relativeTime(health.last_success_at)}
          </div>
        </div>
        <div>
          <span className="text-gray-400">Last attempted</span>
          <div className="text-gray-700 mt-0.5" title={health.last_attempted_at ?? undefined}>
            {relativeTime(health.last_attempted_at)}
          </div>
        </div>
      </div>

      {showFailureDetails && (
        <div className="border-t border-gray-200 pt-3 space-y-1.5 text-xs">
          {health.last_error && (
            <div className="text-red-600 break-words">{health.last_error}</div>
          )}
          <div className="flex gap-4 text-gray-500">
            <span>Retries: <span className="text-gray-700 font-medium">{health.retry_count}</span></span>
            {health.next_retry_at && (
              <span>
                Next retry:{' '}
                <span className="text-gray-700 font-medium" title={health.next_retry_at}>
                  {relativeTime(health.next_retry_at)}
                </span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const IntegrationHealthSection = ({
  integrations,
}: {
  integrations: { square: ProviderHealth; doordash: ProviderHealth };
}) => (
  <Card title="Integration Health">
    <div className="space-y-3">
      <ProviderHealthRow health={integrations.square} providerLabel="Square" />
      <ProviderHealthRow health={integrations.doordash} providerLabel="DoorDash" />
    </div>
  </Card>
);

const RecentJobsSection = ({ jobs }: { jobs: RecentJob[] }) => (
  <Card title="Recent Jobs">
    {jobs.length === 0 ? (
      <p className="text-sm text-gray-500">No jobs recorded yet.</p>
    ) : (
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100">
              <th className="text-left py-2 pr-4 font-medium">Provider</th>
              <th className="text-left py-2 pr-4 font-medium">Trigger</th>
              <th className="text-left py-2 pr-4 font-medium">Status</th>
              <th className="text-left py-2 pr-4 font-medium">Started</th>
              <th className="text-left py-2 pr-4 font-medium">Duration</th>
              <th className="text-left py-2 pr-4 font-medium">Retries</th>
              <th className="text-left py-2 font-medium">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {jobs.map((job) => (
              <tr key={job.id} className="hover:bg-gray-50 transition-colors">
                <td className="py-2.5 pr-4 font-medium text-gray-800 capitalize">{job.provider}</td>
                <td className="py-2.5 pr-4 text-gray-600 capitalize">{job.trigger}</td>
                <td className="py-2.5 pr-4">
                  <Pill tone={jobStatusTone(job.status)}>{job.status}</Pill>
                </td>
                <td className="py-2.5 pr-4 text-gray-600" title={job.started_at ?? undefined}>
                  {relativeTime(job.started_at)}
                </td>
                <td className="py-2.5 pr-4 text-gray-600">{formatDuration(job.duration_ms)}</td>
                <td className="py-2.5 pr-4 text-gray-600">{job.retry_count}</td>
                <td className="py-2.5 text-red-600 text-xs max-w-xs truncate" title={job.last_error ?? undefined}>
                  {job.last_error ?? <span className="text-gray-300">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Card>
);

// ---------- page -----------------------------------------------------------

const SyncHealth = () => {
  const { restaurant } = useRestaurant();
  const [data, setData] = useState<SyncMetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async (isInitial = false) => {
    if (!restaurant) return;
    if (isInitial) setLoading(true);
    try {
      const res = await authedFetch('/api/integrations/sync-metrics');
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`);
      setData(body.data as SyncMetricsData);
      setError(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load sync metrics';
      // On a poll failure, keep prior data visible; only show error on initial load
      if (isInitial) setError(msg);
      // On subsequent polls, silently leave stale data — best-effort
    } finally {
      if (isInitial) setLoading(false);
    }
  }, [restaurant]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    if (!restaurant) return;

    (async () => {
      setLoading(true);
      try {
        const res = await authedFetch('/api/integrations/sync-metrics');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`);
        setData(body.data as SyncMetricsData);
        setError(null);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load sync metrics');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [restaurant]);

  // Poll every 30s — best-effort, keep prior data on failure
  useEffect(() => {
    if (!restaurant) return;
    const id = setInterval(() => fetchMetrics(false), 30_000);
    return () => clearInterval(id);
  }, [restaurant, fetchMetrics]);

  if (loading) {
    return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  }

  if (error) {
    return (
      <div className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sync Health</h1>
          <p className="text-sm text-gray-500 mt-1">Real-time visibility into integration sync jobs and scheduler state.</p>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sync Health</h1>
        </div>
        <div className="p-8 text-sm text-gray-500">No sync data available yet.</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sync Health</h1>
          <p className="text-sm text-gray-500 mt-1">Real-time visibility into integration sync jobs and scheduler state. Auto-refreshes every 30s.</p>
        </div>
      </div>

      <SchedulerSection scheduler={data.scheduler} />
      <MetricsSection metrics={data.metrics} />
      <IntegrationHealthSection integrations={data.integrations} />
      <RecentJobsSection jobs={data.recent_jobs} />
    </div>
  );
};

export default SyncHealth;
