import { supabase } from './supabase';

/**
 * Base URL for the backend API.
 *
 * Configurable via `VITE_API_URL` so the same build can target localhost,
 * staging, or production without code changes. Falls back to the local backend
 * port for development. Trailing slashes are stripped so joining with a
 * leading-slash path never produces a double slash.
 *
 * In production this MUST be set (e.g. https://restaurantiq.up.railway.app),
 * otherwise the deployed frontend would try to reach localhost.
 */
export const API_BASE_URL = (
  import.meta.env.VITE_API_URL || 'http://localhost:3001'
).replace(/\/$/, '');

/** Join the API base URL with a request path (which should start with '/'). */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Shared authenticated fetch helper — the single source of truth for talking
 * to the backend.
 *
 * - Prepends `API_BASE_URL` to `path`, so call sites pass app-relative paths
 *   like `/api/alerts` and never hardcode an origin.
 * - Attaches the current Supabase access token as a Bearer header when a
 *   session exists, so protected routes authenticate automatically.
 * - Defaults `Content-Type` to `application/json` (overridable via `init`).
 *
 * Returns the raw `Response`; callers parse the `{ data, error }` body and
 * handle status codes as before.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (session) {
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }

  return fetch(apiUrl(path), { ...init, headers });
}
