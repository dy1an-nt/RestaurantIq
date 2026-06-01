/**
 * Retry backoff policy for failed sync jobs (Sprint L+).
 *
 * These are pure functions with no I/O — they compute what should happen next
 * based on a retry count. The actual durable state (next_retry_at, retry_count)
 * lives in sync_jobs and is discovered by DB query each scheduler tick, so
 * there are no in-memory queues and no state lost across process restarts.
 *
 * Backoff schedule (attempt = retry_count after the current failure, 1-based):
 *   Attempt 1 →  0 ms  (immediate — the first retry happens right away)
 *   Attempt 2 →  1 min
 *   Attempt 3 →  5 min
 *   Attempt 4 → 15 min
 *   Attempt 5 → 60 min
 *   Beyond MAX → null (budget exhausted → failed_permanently)
 *
 * "Permanent" failures (auth errors, disconnected integrations) bypass this
 * schedule entirely — isPermanent() returns true and the caller marks the job
 * failed_permanently without ever computing a next_retry_at.
 */

import { IntegrationState } from '../syncScheduler';

/**
 * Maximum number of retry attempts, read lazily from the environment.
 *
 * This MUST be a runtime read: module-level imports execute before
 * server.ts calls dotenv.config(), so reading process.env at module-load time
 * would always see undefined and silently lock in the default. Reading inside
 * the function lets operators actually tune MAX_SYNC_RETRIES via .env.
 */
export const maxSyncRetries = (): number => {
  const n = Number(process.env.MAX_SYNC_RETRIES);
  return Number.isFinite(n) && n > 0 ? n : 5;
};

/**
 * Static default exposed for display/back-compat. Prefer maxSyncRetries() for
 * any runtime budget decision so .env overrides are honored.
 */
export const MAX_SYNC_RETRIES: number = maxSyncRetries();

/** Delay in milliseconds for each retry attempt (1-indexed). */
const BACKOFF_SCHEDULE_MS: number[] = [
  0,           // attempt 1: immediate
  60_000,      // attempt 2: 1 min
  300_000,     // attempt 3: 5 min
  900_000,     // attempt 4: 15 min
  3_600_000,   // attempt 5: 60 min
];

/**
 * Compute the delay (ms) before the next retry attempt.
 *
 * @param retryCount - the number of retries that have already occurred
 *                     (so the first call after a fresh failure passes 1).
 * @returns delay in ms, or null when the retry budget is exhausted.
 */
export const nextRetryDelayMs = (retryCount: number): number | null => {
  if (retryCount > maxSyncRetries()) return null;
  // Use the schedule entry for this attempt, clamped to the last entry.
  const idx = Math.min(retryCount - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx];
};

/**
 * Whether a failure is permanent and should never be auto-retried.
 *
 * Auth/connectivity failures need human action (re-connect the integration);
 * hammering the provider with retries would be pointless and noisy.
 *
 * @param state - the IntegrationState classification from classifyIntegration(),
 *                OR the string 'exhausted' when the retry budget is consumed.
 */
export const isPermanent = (state: IntegrationState | 'exhausted'): boolean =>
  state === 'disconnected' || state === 'token_expired' || state === 'exhausted';
