import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Alert {
  id: string;
  restaurant_id: string;
  menu_item_id: string | null;
  type: 'no_sales' | 'trending_down' | 'new_top_performer';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

const AlertsBanner = () => {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [dismissed, setDismissed] = useState(false);

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
    if (!session) return;
    // Optimistic update — hide the banner immediately
    setDismissed(true);
    setUnreadCount(0);

    try {
      await fetch('/api/alerts/read-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
    } catch (err: unknown) {
      console.error('[AlertsBanner] dismiss-all error:', err);
    }
  };

  if (dismissed || unreadCount === 0) return null;

  return (
    <div className="mb-6 bg-amber-50 border border-amber-200 px-4 py-3 rounded-lg flex items-center justify-between">
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
          className="px-3 py-1.5 bg-white border border-amber-300 text-amber-800 text-xs font-medium rounded-md hover:bg-amber-100 transition-colors"
        >
          Dismiss all
        </button>
      </div>
    </div>
  );
};

export default AlertsBanner;
