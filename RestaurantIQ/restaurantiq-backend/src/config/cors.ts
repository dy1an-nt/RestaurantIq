import type { CorsOptions } from 'cors';
import { loadEnv } from './env';

// Origins always permitted in development, regardless of FRONTEND_URL. Covers
// the default Vite dev server (5173) and a common alternate (3000).
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

/**
 * Build the set of allowed browser origins from the environment.
 *
 * - FRONTEND_URL may contain a comma-separated list (e.g. a Vercel prod URL
 *   plus a preview URL). Each entry is trimmed and trailing slashes removed so
 *   it matches the `Origin` header exactly.
 * - Localhost dev origins are added unless NODE_ENV === 'production', so local
 *   development works without extra configuration but production stays locked
 *   to the explicit allowlist.
 */
function buildAllowlist(): Set<string> {
  const env = loadEnv();
  const fromEnv = (env.FRONTEND_URL ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const origins = new Set(fromEnv);
  if (env.NODE_ENV !== 'production') {
    for (const o of DEV_ORIGINS) origins.add(o);
  }
  return origins;
}

/**
 * CORS options enforcing an origin allowlist.
 *
 * Requests with no `Origin` header (same-origin, curl, server-to-server,
 * health checks) are allowed through — CORS only governs browser cross-origin
 * requests. Browser requests from an unlisted origin are rejected.
 */
export function corsOptions(): CorsOptions {
  const allowlist = buildAllowlist();

  return {
    origin(origin, callback) {
      // Allow if no Origin header (same-origin / curl / server-to-server) or
      // the origin is on the allowlist. Otherwise deny by omitting CORS
      // headers (callback(null, false)) rather than throwing — the browser
      // still blocks the response, and we avoid noisy 500s in the logs.
      callback(null, !origin || allowlist.has(origin));
    },
    credentials: true,
  };
}
