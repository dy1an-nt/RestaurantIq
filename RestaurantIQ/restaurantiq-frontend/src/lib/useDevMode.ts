import { useCallback, useEffect, useState } from 'react';

/**
 * Developer-mode flag (Sprint S, review R14 / §5).
 *
 * Engineering-only surfaces (Sync Health — a distributed-scheduler observability
 * page that's for the engineer, not the restaurant owner) are hidden from the
 * owner-facing nav by default. Flipping this flag in Settings reveals them. It
 * lives in localStorage (no backend, no schema change — appropriate for a polish
 * sprint) and broadcasts a custom event so the Sidebar re-renders immediately,
 * plus the native `storage` event so it stays in sync across tabs.
 */
const KEY = 'riq_dev_mode';
const EVENT = 'riq-dev-mode-change';

export function isDevModeEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function useDevMode(): [boolean, (on: boolean) => void] {
  const [enabled, setEnabled] = useState(isDevModeEnabled);

  useEffect(() => {
    const sync = () => setEnabled(isDevModeEnabled());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const set = useCallback((on: boolean) => {
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* localStorage unavailable (private mode) — non-fatal */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [enabled, set];
}
