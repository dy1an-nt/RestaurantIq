import * as Sentry from '@sentry/node';
import { loadEnv } from './env';
import { scrubString, scrubDeep, sanitizeEvent } from './sentryScrub';

// Re-exported so callers have a single import site for the integration.
export { scrubString, scrubDeep, sanitizeEvent } from './sentryScrub';

/**
 * Sentry error tracking (optional, off by default).
 *
 * Closes the "no integrated error tracking" gap in docs/known-limitations.md.
 * Without SENTRY_DSN this module is completely inert - no network calls, no
 * behaviour change - so development, tests, and any deploy that hasn't been
 * given a DSN run exactly as before.
 *
 * Why init happens here and not at the very top of the process
 * -----------------------------------------------------------
 * Sentry's docs recommend calling init() before any other import so its
 * auto-instrumentation can patch libraries as they load. This project reads its
 * configuration through config/env.ts, which calls dotenv.config() on import -
 * so at true module-load time SENTRY_DSN is still undefined (see the "env vars
 * are read lazily" entry in docs/sharp-edges.md). We therefore init immediately
 * after loadEnv(), and accept the tradeoff: error capture works fully, while
 * performance tracing would be partial. Tracing is disabled by default anyway
 * (SENTRY_TRACES_SAMPLE_RATE=0), so nothing is lost until someone opts in.
 *
 * Scrubbing
 * ---------
 * This backend handles Square/DoorDash access tokens, Supabase JWTs, an
 * Anthropic key, and an AES-256 encryption key. Sentry's defaults are NOT
 * sufficient to keep those out of an error report: request headers and bodies
 * are attached to events, and onboarding posts an access token in a JSON body.
 * So we do three things, in order of how much they are relied upon:
 *
 *   1. sendDefaultPii: false            - no IPs, cookies, or user identifiers.
 *   2. Structural stripping             - drop the request body outright and
 *                                         allowlist a handful of safe headers.
 *   3. Pattern scrub over the whole event - a final net for secrets that leaked
 *                                         into an exception message or stack.
 *
 * Layer 3 exists because layers 1 and 2 only cover fields we predicted.
 */

let initialized = false;

/**
 * Initialize Sentry if a DSN is configured. Returns whether it is now active.
 * Safe to call more than once; only the first call does anything.
 */
export function initSentry(): boolean {
  if (initialized) return Sentry.isInitialized();

  // Read env inside the function, not at module load - see the sharp-edges note
  // at the top of this file.
  const env = loadEnv();
  const dsn = env.SENTRY_DSN;

  initialized = true;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    release: env.APP_VERSION ?? process.env.npm_package_version,
    // No IPs, cookies, or user identifiers attached to events.
    sendDefaultPii: false,
    // Errors-only by default; tracing is opt-in because init runs after the
    // app's imports (see header) and because spans cost quota.
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    beforeSend: (event) =>
      sanitizeEvent(event as unknown as Record<string, unknown>) as unknown as typeof event,
    // Breadcrumbs record prior HTTP calls and log lines, which can embed
    // credentials; scrub them on the same path as events.
    beforeBreadcrumb: (breadcrumb) =>
      scrubDeep(breadcrumb as unknown as Record<string, unknown>) as unknown as typeof breadcrumb,
  });

  return Sentry.isInitialized();
}

/**
 * Report an error raised outside a request - scheduler ticks, sync jobs,
 * unhandled rejections. Request-scoped errors are captured by the Express
 * error handler instead. No-op when Sentry is not configured.
 */
export function captureBackgroundError(
  err: unknown,
  context?: Record<string, string>,
): void {
  if (!Sentry.isInitialized()) return;
  Sentry.withScope((scope) => {
    scope.setTag('source', 'background');
    for (const [key, value] of Object.entries(context ?? {})) {
      scope.setTag(key, scrubString(value));
    }
    Sentry.captureException(err);
  });
}

/**
 * Flush buffered events before the process exits. Called from the shutdown
 * path so a crash-triggered SIGTERM doesn't discard the error that caused it.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!Sentry.isInitialized()) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Never let telemetry teardown block or fail shutdown.
  }
}
