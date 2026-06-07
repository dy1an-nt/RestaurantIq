import { Session } from '@supabase/supabase-js';
import { apiFetch } from './api';

export interface ForecastItem {
  menu_item_id: string;
  name: string;
  category: string;
  projected_units_next_7d: number;
  projected_revenue_next_7d_cents: number;
  actual_units_last_7d: number;
  actual_revenue_last_7d_cents: number;
  trend_direction: 'up' | 'down' | 'flat';
  percent_change: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface InsufficientItem {
  menu_item_id: string;
  name: string;
  days_of_data: number;
}

export interface ForecastNarrative {
  summary: string;
  callouts: Array<{ title: string; detail: string }>;
}

export interface ForecastResult {
  cached: boolean;
  generated_at?: string;
  trailing_days?: number;
  projection_days?: number;
  items: ForecastItem[];
  insufficient_history_items: InsufficientItem[];
  narrative: ForecastNarrative | null;
}

async function parseBody<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`);
  return body.data as T;
}

export async function getForecast(_session: Session): Promise<ForecastResult> {
  const res = await apiFetch('/api/advisor/forecast');
  return parseBody<ForecastResult>(res);
}

export async function refreshForecast(_session: Session): Promise<ForecastResult> {
  const res = await apiFetch('/api/advisor/forecast/refresh', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return parseBody<ForecastResult>(res);
}
