import { useEffect, useState } from 'react';
import { apiFetch } from './api';
import { useAuth } from '../components/auth/AuthContext';

interface AlertRow {
  is_read: boolean;
}

/**
 * Returns the count of unread alerts for the signed-in user, used to drive the
 * sidebar "Alerts" badge and the topbar bell pip. Peripheral UI — failures are
 * swallowed and simply leave the count at 0.
 */
export function useUnreadAlerts(): number {
  const { session } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!session) {
      setCount(0);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await apiFetch('/api/alerts', { signal: controller.signal });
        if (cancelled) return;
        const body: { data: AlertRow[] | null; error: string | null } = await res.json();
        if (cancelled || !res.ok || body.error || !body.data) return;
        setCount(body.data.filter((a) => !a.is_read).length);
      } catch {
        // peripheral UI — ignore
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [session]);

  return count;
}
