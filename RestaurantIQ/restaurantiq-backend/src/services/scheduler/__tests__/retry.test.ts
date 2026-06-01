/**
 * Unit tests for the retry backoff policy (Sprint L+).
 *
 * These are pure function tests — no I/O, no mocks. They verify the exact
 * delay schedule, budget exhaustion, and the isPermanent helper.
 */

import { nextRetryDelayMs, isPermanent, MAX_SYNC_RETRIES } from '../retry';

describe('nextRetryDelayMs — backoff schedule', () => {
  it('attempt 1 → immediate (0 ms)', () => {
    expect(nextRetryDelayMs(1)).toBe(0);
  });

  it('attempt 2 → 1 minute', () => {
    expect(nextRetryDelayMs(2)).toBe(60_000);
  });

  it('attempt 3 → 5 minutes', () => {
    expect(nextRetryDelayMs(3)).toBe(300_000);
  });

  it('attempt 4 → 15 minutes', () => {
    expect(nextRetryDelayMs(4)).toBe(900_000);
  });

  it('attempt 5 → 60 minutes', () => {
    expect(nextRetryDelayMs(5)).toBe(3_600_000);
  });

  it('beyond MAX_SYNC_RETRIES → null (budget exhausted)', () => {
    expect(nextRetryDelayMs(MAX_SYNC_RETRIES + 1)).toBeNull();
  });

  it('returns null for any attempt count > max', () => {
    expect(nextRetryDelayMs(100)).toBeNull();
  });
});

describe('isPermanent', () => {
  it('disconnected is permanent', () => {
    expect(isPermanent('disconnected')).toBe(true);
  });

  it('token_expired is permanent', () => {
    expect(isPermanent('token_expired')).toBe(true);
  });

  it('exhausted is permanent', () => {
    expect(isPermanent('exhausted')).toBe(true);
  });

  it('syncable is NOT permanent', () => {
    expect(isPermanent('syncable')).toBe(false);
  });
});

describe('MAX_SYNC_RETRIES', () => {
  it('defaults to 5 when env var is unset', () => {
    // In test env MAX_SYNC_RETRIES env var is not set, so it defaults to 5.
    expect(MAX_SYNC_RETRIES).toBe(5);
  });
});
