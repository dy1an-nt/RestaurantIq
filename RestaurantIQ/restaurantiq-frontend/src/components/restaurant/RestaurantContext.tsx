import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../../lib/supabase';

export interface Restaurant {
  id: string;
  name: string;
  location: string | null;
  square_location_id: string | null;
  doordash_store_id: string | null;
  pos_connected: boolean;
  delivery_connected: boolean;
}

interface RestaurantContextType {
  restaurant: Restaurant | null;
  loading: boolean;
  /** Re-fetch from /api/restaurant/me. Call after onboarding completes. */
  refresh: () => Promise<void>;
}

const RestaurantContext = createContext<RestaurantContextType | undefined>(undefined);

export const useRestaurant = () => {
  const ctx = useContext(RestaurantContext);
  if (!ctx) throw new Error('useRestaurant must be used inside RestaurantProvider');
  return ctx;
};

export const RestaurantProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { session, loading: authLoading } = useAuth();
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMe = useCallback(async () => {
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    if (!currentSession) {
      setRestaurant(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/restaurant/me', {
        headers: { Authorization: `Bearer ${currentSession.access_token}` },
      });
      if (res.status === 404) {
        setRestaurant(null);
      } else if (res.ok) {
        const body = await res.json();
        setRestaurant(body.data as Restaurant);
      } else {
        setRestaurant(null);
      }
    } catch {
      setRestaurant(null);
    } finally {
      setLoading(false);
    }
  }, []); // no deps — reads session at call time via getSession()

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    (async () => {
      if (!session) {
        if (!cancelled) {
          setRestaurant(null);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      try {
        const res = await fetch('/api/restaurant/me', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (cancelled) return;
        if (res.status === 404) {
          setRestaurant(null);
        } else if (res.ok) {
          const body = await res.json();
          if (!cancelled) setRestaurant(body.data as Restaurant);
        } else {
          setRestaurant(null);
        }
      } catch {
        if (!cancelled) setRestaurant(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, session]);

  return (
    <RestaurantContext.Provider value={{ restaurant, loading, refresh: fetchMe }}>
      {children}
    </RestaurantContext.Provider>
  );
};
