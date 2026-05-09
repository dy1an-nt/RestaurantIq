import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';

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

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fireNotification(count: number): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (sessionStorage.getItem('riq_alerts_notified')) return;

  const body =
    count === 1 ? '1 new operational alert' : `${count} new operational alerts`;
  const notification = new Notification('RestaurantIQ Alerts', { body });
  sessionStorage.setItem('riq_alerts_notified', '1');
  setTimeout(() => notification.close(), 5000);
}

async function maybeNotify(count: number): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (count === 0) return;

  if (Notification.permission === 'granted') {
    fireNotification(count);
  } else if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      fireNotification(count);
    }
  }
  // 'denied' → do nothing
}

// ─── Component ─────────────────────────────────────────────────────────────────

const AlertsBanner = () => {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [dismissed, setDismissed] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch('/api/alerts', {
          headers: { Authorization: `Bearer ${session.access_token}` },
          signal: controller.signal,
        });

        if (cancelled) return;

        const body: { data: Alert[] | null; error: string | null } = await res.json();

        if (cancelled) return;

        if (!res.ok || body.error || !body.data) return;

        const count = body.data.filter((a) => !a.is_read).length;
        setUnreadCount(count);

        // Browser push notification — only for authenticated users
        await maybeNotify(count);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        // Silently do nothing — banner is peripheral UI
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [session]);

  const handleDismissAll = async () => {
    if (!session || isDismissing) return;

    // Save prior state for rollback
    const priorDismissed = dismissed;
    const priorCount = unreadCount;

    // Optimistic update — hide the banner immediately
    setIsDismissing(true);
    setDismissError(null);
    setDismissed(true);
    setUnreadCount(0);

    try {
      const res = await fetch('/api/alerts/read-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body: { data: unknown; error: string | null } = await res.json();

      if (!res.ok || body.error) {
        // Rollback on failure
        setDismissed(priorDismissed);
        setUnreadCount(priorCount);
        setDismissError('Failed to dismiss alerts. Please try again.');
      }
    } catch {
      // Network error — rollback
      setDismissed(priorDismissed);
      setUnreadCount(priorCount);
      setDismissError('Failed to dismiss alerts. Please try again.');
    } finally {
      setIsDismissing(false);
    }
  };

  if (dismissed || unreadCount === 0) return null;

  return (
    <div className="mb-6 bg-amber-50 border border-amber-200 px-4 py-3 rounded-lg">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-amber-800">
          <span className="mr-2" aria-hidden="true">&#9888;</span>
          You have {unreadCount} unread alert{unreadCount !== 1 ? 's' : ''} &mdash; review your menu performance.
        </span>
        <div className="flex items-center gap-3 ml-4 flex-shrink-0">
          <button
            onClick={() => navigate('/alerts')}
            className="px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-md hover:bg-amber-700 transition-colors"
          >
            View alerts
          </button>
          <button
            onClick={handleDismissAll}
            disabled={isDismissing}
            className="px-3 py-1.5 bg-white border border-amber-300 text-amber-800 text-xs font-medium rounded-md hover:bg-amber-100 transition-colors disabled:opacity-50"
          >
            {isDismissing ? 'Dismissing…' : 'Dismiss all'}
          </button>
        </div>
      </div>
      {dismissError && (
        <p className="mt-2 text-xs text-red-600">{dismissError}</p>
      )}
    </div>
  );
};

export default AlertsBanner;
