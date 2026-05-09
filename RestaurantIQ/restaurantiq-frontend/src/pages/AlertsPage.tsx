import { useEffect, useState } from 'react';
import { useAuth } from '../components/auth/AuthContext';
import { useRestaurant } from '../components/restaurant/RestaurantContext';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Alert {
  id: string;
  restaurant_id: string;
  menu_item_id: string | null;
  type: 'no_sales' | 'trending_down' | 'new_top_performer' | 'unusual_spike' | 'traffic_drop';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'data'; alerts: Alert[] };

// ─── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Severity border ───────────────────────────────────────────────────────────

const SEVERITY_BORDER: Record<Alert['severity'], string> = {
  info: 'border-l-4 border-blue-400',
  warning: 'border-l-4 border-amber-400',
  critical: 'border-l-4 border-red-500',
};

// ─── Type badge ────────────────────────────────────────────────────────────────

interface TypeBadgeStyle {
  classes: string;
  label: string;
}

const TYPE_BADGE: Record<Alert['type'], TypeBadgeStyle> = {
  no_sales: { classes: 'bg-red-100 text-red-700', label: 'No Sales' },
  trending_down: { classes: 'bg-amber-100 text-amber-700', label: 'Trending Down' },
  new_top_performer: { classes: 'bg-green-100 text-green-700', label: 'New Top Performer' },
  unusual_spike: { classes: 'bg-purple-100 text-purple-700', label: 'Unusual Spike' },
  traffic_drop: { classes: 'bg-orange-100 text-orange-700', label: 'Traffic Drop' },
};

// ─── Sub-components ────────────────────────────────────────────────────────────

const SkeletonRow = () => (
  <div className="bg-white rounded-xl shadow-sm border border-gray-100 border-l-4 border-l-gray-200 p-4 space-y-2 animate-pulse">
    <div className="flex items-center justify-between">
      <div className="h-4 w-32 bg-gray-200 rounded" />
      <div className="h-4 w-16 bg-gray-200 rounded" />
    </div>
    <div className="h-5 w-2/3 bg-gray-200 rounded" />
    <div className="h-4 w-full bg-gray-200 rounded" />
    <div className="h-4 w-5/6 bg-gray-200 rounded" />
  </div>
);

interface AlertCardProps {
  alert: Alert;
  onMarkRead: (id: string) => void;
}

const AlertCard = ({ alert, onMarkRead }: AlertCardProps) => {
  const badge = TYPE_BADGE[alert.type];
  const borderClass = SEVERITY_BORDER[alert.severity];
  const bgClass = alert.is_read ? 'bg-white' : 'bg-amber-50/40';

  return (
    <div
      className={`${bgClass} rounded-xl shadow-sm border border-gray-100 ${borderClass} p-4 space-y-2`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.classes}`}
          >
            {badge.label}
          </span>
          <span className="text-xs text-gray-400">{relativeTime(alert.created_at)}</span>
        </div>
        {!alert.is_read && (
          <button
            onClick={() => onMarkRead(alert.id)}
            className="px-2.5 py-1 bg-white border border-gray-200 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors flex-shrink-0"
          >
            Mark read
          </button>
        )}
      </div>
      <p className="text-sm font-semibold text-gray-900">{alert.title}</p>
      <p className="text-sm text-gray-500 leading-relaxed">{alert.message}</p>
    </div>
  );
};

// ─── Main component ────────────────────────────────────────────────────────────

const AlertsPage = () => {
  const { session } = useAuth();
  const { restaurant } = useRestaurant();
  const [pageState, setPageState] = useState<PageState>({ status: 'loading' });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isMarkingAll, setIsMarkingAll] = useState(false);

  useEffect(() => {
    if (!session) {
      setPageState({ status: 'error', message: 'Not authenticated. Please sign in again.' });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setPageState({ status: 'loading' });
    setErrorMsg(null);

    (async () => {
      try {
        const res = await fetch('/api/alerts', {
          headers: { Authorization: `Bearer ${session.access_token}` },
          signal: controller.signal,
        });

        if (cancelled) return;

        const body: { data: Alert[] | null; error: string | null } = await res.json();

        if (cancelled) return;

        if (!res.ok || body.error) {
          setPageState({
            status: 'error',
            message: body.error ?? `Request failed (${res.status})`,
          });
          return;
        }

        if (!body.data || body.data.length === 0) {
          setPageState({ status: 'empty' });
          return;
        }

        setPageState({ status: 'data', alerts: body.data });
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setPageState({
          status: 'error',
          message: err instanceof Error ? err.message : 'An unexpected error occurred.',
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [session]);

  const handleMarkRead = async (id: string) => {
    if (!session || isMarkingAll) return;

    // Save prior state for rollback
    const priorState = pageState;

    // Optimistic update
    setPageState((prev) => {
      if (prev.status !== 'data') return prev;
      return {
        ...prev,
        alerts: prev.alerts.map((a) => (a.id === id ? { ...a, is_read: true } : a)),
      };
    });

    try {
      const res = await fetch(`/api/alerts/${id}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body: { data: { id: string } | null; error: string | null } = await res.json();
      if (!res.ok || body.error) {
        setPageState(priorState);
        setErrorMsg('Failed to mark alert as read. Please try again.');
      }
    } catch {
      setPageState(priorState);
      setErrorMsg('Failed to mark alert as read. Please try again.');
    }
  };

  const handleMarkAllRead = async () => {
    if (!session || isMarkingAll) return;

    setIsMarkingAll(true);

    // Save prior state for rollback
    const priorState = pageState;

    // Optimistic update
    setPageState((prev) => {
      if (prev.status !== 'data') return prev;
      return {
        ...prev,
        alerts: prev.alerts.map((a) => ({ ...a, is_read: true })),
      };
    });

    try {
      const res = await fetch('/api/alerts/read-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body: { data: { updated: number } | null; error: string | null } = await res.json();
      if (!res.ok || body.error) {
        setPageState(priorState);
        setErrorMsg('Failed to mark all alerts as read. Please try again.');
      }
    } catch {
      setPageState(priorState);
      setErrorMsg('Failed to mark all alerts as read. Please try again.');
    } finally {
      setIsMarkingAll(false);
    }
  };

  const hasUnread =
    pageState.status === 'data' && pageState.alerts.some((a) => !a.is_read);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Alerts</h1>
          <p className="text-sm text-gray-500 mt-1">
            {restaurant ? `${restaurant.name} · ` : ''}Menu performance notifications
          </p>
        </div>
        {hasUnread && (
          <button
            onClick={handleMarkAllRead}
            disabled={isMarkingAll}
            className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            {isMarkingAll ? 'Marking…' : 'Mark all read'}
          </button>
        )}
      </div>

      {/* Inline error banner for mutation failures */}
      {errorMsg && (
        <div className="flex items-center justify-between bg-red-50 border border-red-200 px-4 py-3 rounded-lg">
          <p className="text-sm text-red-700">{errorMsg}</p>
          <button
            onClick={() => setErrorMsg(null)}
            className="text-red-500 hover:text-red-700 text-xs ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Loading state */}
      {pageState.status === 'loading' && (
        <div className="space-y-3">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      )}

      {/* Error state */}
      {pageState.status === 'error' && (
        <div className="bg-white rounded-xl shadow p-8 text-center space-y-2">
          <p className="text-sm font-medium text-red-600">{pageState.message}</p>
        </div>
      )}

      {/* Empty state */}
      {pageState.status === 'empty' && (
        <div className="bg-white rounded-xl shadow p-8 text-center space-y-2">
          <p className="text-base font-semibold text-gray-700">No alerts</p>
          <p className="text-sm text-gray-400">
            You are all caught up. Alerts will appear here when your menu data has something worth
            flagging.
          </p>
        </div>
      )}

      {/* Data state */}
      {pageState.status === 'data' && (
        <div className="space-y-3">
          {pageState.alerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} onMarkRead={handleMarkRead} />
          ))}
        </div>
      )}
    </div>
  );
};

export default AlertsPage;
