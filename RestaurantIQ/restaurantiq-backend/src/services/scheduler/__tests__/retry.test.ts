/**
 * Unit tests for the retry backoff policy (Sprint L+).
 *
 * These are pure function tests — no I/O, no mocks. They verify the exact
 * delay schedule, budget exhaustion, and the isPermanent helper.
 */

import { nextRetryDelayMs, isPermanent, maxSyncRetries } from '../retry';

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

  it('beyond the retry budget → null (budget exhausted)', () => {
    expect(nextRetryDelayMs(maxSyncRetries() + 1)).toBeNull();
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

describe('maxSyncRetries', () => {
  it('defaults to 5 when env var is unset', () => {
    delete process.env.MAX_SYNC_RETRIES;
    expect(maxSyncRetries()).toBe(5);
  });

  it('honors an env override set after module load', () => {
    // The whole reason this is a function: dotenv.config() runs in server.ts
    // after every import has already executed.
    process.env.MAX_SYNC_RETRIES = '2';
    try {
      expect(maxSyncRetries()).toBe(2);
      expect(nextRetryDelayMs(3)).toBeNull();
    } finally {
      delete process.env.MAX_SYNC_RETRIES;
    }
  });
});
