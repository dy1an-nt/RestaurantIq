/**
 * Unit tests for the automated sync scheduler (Sprint L).
 *
 * The Supabase client is replaced with a purpose-built chainable mock that
 * records every update/upsert and lets each test script the result of the
 * conditional lock-acquire UPDATE (the `.or(...).select('id')` chain). That's
 * enough to drive the four behaviours the sprint cares about: locking, status
 * tracking, expired-credential skipping, and failure isolation.
 */

// ── Mutable mock state (must be prefixed `mock` to be used in jest.mock factory)
const mockState: {
  restaurants: any[];
  /** Queue of acquireLock outcomes; empty → granted. */
  lockResults: boolean[];
  updates: Array<{ table: string; payload: any }>;
  upserts: Array<{ table: string; payload: any; opts: any }>;
  inserts: Array<{ table: string; payload: any }>;
} = { restaurants: [], lockResults: [], updates: [], upserts: [], inserts: [] };

jest.mock('../../db', () => {
  const makeBuilder = (table: string) => {
    const b: any = {
      _op: null as null | string,
      _select: false,
      _payload: null as any,
      select() {
        if (this._op) this._select = true;
        else this._op = 'select';
        return this;
      },
      upsert(payload: any, opts: any) {
        this._op = 'upsert';
        mockState.upserts.push({ table, payload, opts });
        return this;
      },
      update(payload: any) {
        this._op = 'update';
        this._payload = payload;
        return this;
      },
      insert(payload: any) {
        this._op = 'insert';
        this._payload = payload;
        mockState.inserts.push({ table, payload });
        return this;
      },
      single() {
        // After insert, return the inserted row with a fake id.
        return Promise.resolve({ data: { id: 'job-mock-id' }, error: null });
      },
      eq() {
        return this;
      },
      or() {
        return this;
      },
      then(resolve: any, reject: any) {
        return Promise.resolve(this._resolve()).then(resolve, reject);
      },
      _resolve() {
        if (this._op === 'select' && table === 'restaurants') {
          return { data: mockState.restaurants, error: null };
        }
        if (this._op === 'update') {
          mockState.updates.push({ table, payload: this._payload });
          if (this._select) {
            // acquireLock — granted unless the test scripted a refusal.
            const granted = mockState.lockResults.length ? mockState.lockResults.shift() : true;
            return { data: granted ? [{ id: 'status-1' }] : [], error: null };
          }
          return { data: null, error: null };
        }
        if (this._op === 'upsert') return { error: null };
        if (this._op === 'insert') return { data: { id: 'job-mock-id' }, error: null };
        return { data: null, error: null };
      },
    };
    return b;
  };
  return { supabase: { from: (t: string) => makeBuilder(t) } };
});

const ingestSquareMock = jest.fn();
const ingestDoorDashMock = jest.fn();
jest.mock('../square/ingestSquare', () => ({ ingestSquare: (...a: any[]) => ingestSquareMock(...a) }));
jest.mock('../doordash/ingestDoorDash', () => ({
  ingestDoorDash: (...a: any[]) => ingestDoorDashMock(...a),
}));

const squareMock = jest.fn(() => false);
const doordashMock = jest.fn(() => false);
jest.mock('../square/squareClient', () => ({ isMockMode: () => squareMock() }));
jest.mock('../doordash/doordashClient', () => ({ isMockMode: () => doordashMock() }));

import {
  classifyIntegration,
  syncIntegration,
  runScheduledSync,
} from '../syncScheduler';

const squareRow = (over: Record<string, any> = {}) => ({
  id: 'r1',
  pos_connected: true,
  square_location_id: 'loc-1',
  square_access_token: 'enc-access',
  square_refresh_token: 'enc-refresh',
  square_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  delivery_connected: false,
  doordash_store_id: null,
  doordash_access_token: null,
  doordash_refresh_token: null,
  doordash_token_expires_at: null,
  ...over,
});

const lastUpdate = (predicate: (p: any) => boolean, table?: string) =>
  [...mockState.updates]
    .reverse()
    .find((u) => predicate(u.payload) && (!table || u.table === table))?.payload;

beforeEach(() => {
  mockState.restaurants = [];
  mockState.lockResults = [];
  mockState.updates = [];
  mockState.upserts = [];
  mockState.inserts = [];
  ingestSquareMock.mockReset();
  ingestDoorDashMock.mockReset();
  squareMock.mockReturnValue(false);
  doordashMock.mockReturnValue(false);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe('classifyIntegration', () => {
  it('marks a fully-credentialed integration syncable', () => {
    expect(classifyIntegration(squareRow(), 'square')).toBe('syncable');
  });

  it('marks an unconnected integration disconnected', () => {
    expect(classifyIntegration(squareRow({ pos_connected: false }), 'square')).toBe('disconnected');
    expect(classifyIntegration(squareRow({ square_location_id: null }), 'square')).toBe(
      'disconnected',
    );
  });

  it('marks a connected integration with no access token disconnected', () => {
    expect(classifyIntegration(squareRow({ square_access_token: null }), 'square')).toBe(
      'disconnected',
    );
  });

  it('marks an expired token with no refresh token token_expired', () => {
    const row = squareRow({
      square_token_expires_at: new Date(Date.now() - 1000).toISOString(),
      square_refresh_token: null,
    });
    expect(classifyIntegration(row, 'square')).toBe('token_expired');
  });

  it('stays syncable when expired but a refresh token is present', () => {
    const row = squareRow({ square_token_expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(classifyIntegration(row, 'square')).toBe('syncable');
  });

  it('is always syncable in mock mode regardless of tokens', () => {
    squareMock.mockReturnValue(true);
    const row = squareRow({ square_access_token: null, square_token_expires_at: null });
    expect(classifyIntegration(row, 'square')).toBe('syncable');
  });
});

describe('syncIntegration — status tracking', () => {
  it('runs ingest and records success, clearing any prior error', async () => {
    ingestSquareMock.mockResolvedValue({ ok: true, catalogCount: 4, orderCount: 9 });

    const outcome = await syncIntegration(squareRow(), 'square', 'manual');

    expect(ingestSquareMock).toHaveBeenCalledWith('r1');
    expect(outcome).toMatchObject({ ok: true, status: 'success', catalogCount: 4, orderCount: 9 });

    // Look specifically at the integration_sync_status table update (releaseLock).
    const success = lastUpdate((p) => p.status === 'success', 'integration_sync_status');
    expect(success).toBeDefined();
    expect(success.locked_at).toBeNull(); // lock released
    expect(success.last_error).toBeNull(); // prior failures cleared
    expect(success.last_success_at).toBeTruthy();
  });

  it('records a failed status + error when ingest throws', async () => {
    ingestSquareMock.mockRejectedValue(new Error('Square API 500'));

    const outcome = await syncIntegration(squareRow(), 'square', 'scheduled');

    expect(outcome).toMatchObject({ ok: false, status: 'failed', error: 'Square API 500' });
    const failed = lastUpdate((p) => p.status === 'failed', 'integration_sync_status');
    expect(failed.last_error).toBe('Square API 500');
    expect(failed.locked_at).toBeNull(); // lock released on failure
  });

  it('maps an auth/refresh failure to token_expired', async () => {
    ingestSquareMock.mockRejectedValue(
      new Error('Square integration disconnected — reconnect required.'),
    );

    const outcome = await syncIntegration(squareRow(), 'square', 'scheduled');

    expect(outcome.status).toBe('token_expired');
  });
});

describe('syncIntegration — respecting integration state', () => {
  it('skips a disconnected integration without calling ingest', async () => {
    const outcome = await syncIntegration(squareRow({ pos_connected: false }), 'square');

    expect(ingestSquareMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ skipped: true, reason: 'disconnected', ok: false });
  });

  it('skips an expired integration without calling ingest', async () => {
    const row = squareRow({
      square_token_expires_at: new Date(Date.now() - 1000).toISOString(),
      square_refresh_token: null,
    });
    const outcome = await syncIntegration(row, 'square');

    expect(ingestSquareMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ skipped: true, reason: 'token_expired' });
  });
});

describe('syncIntegration — overlap prevention', () => {
  it('does not run ingest when the lock cannot be acquired', async () => {
    mockState.lockResults = [false]; // simulate a sync already holding the lock

    const outcome = await syncIntegration(squareRow(), 'square', 'manual');

    expect(ingestSquareMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ skipped: true, reason: 'locked' });
  });
});

/**
 * Regression coverage for the Sprint L+ retry pipeline — these guard the two
 * bugs QA caught: (1) a tautological permanent-failure branch that marked every
 * failure failed_permanently (dead retry path), and (2) dispatched retries
 * spawning a new job row instead of consuming their own, looping forever.
 */
describe('syncIntegration — durable retry pipeline', () => {
  const syncJobUpdate = (predicate: (p: any) => boolean) =>
    lastUpdate(predicate, 'sync_jobs');

  it('schedules a backoff retry (pending_retry) for a transient failure', async () => {
    ingestSquareMock.mockRejectedValue(new Error('Square API 500'));

    const outcome = await syncIntegration(squareRow(), 'square', 'scheduled');

    expect(outcome).toMatchObject({ ok: false, status: 'failed' });
    const retry = syncJobUpdate((p) => p.status === 'pending_retry');
    expect(retry).toBeDefined();
    expect(retry.next_retry_at).not.toBeNull(); // a retry was actually scheduled
    expect(retry.retry_count).toBe(1);
    // It must NOT have been marked permanently failed.
    expect(syncJobUpdate((p) => p.status === 'failed_permanently')).toBeUndefined();
  });

  it('marks an auth/credential failure failed_permanently (no retry)', async () => {
    ingestSquareMock.mockRejectedValue(
      new Error('Square integration disconnected — reconnect required.'),
    );

    const outcome = await syncIntegration(squareRow(), 'square', 'scheduled');

    expect(outcome.status).toBe('token_expired');
    const perm = syncJobUpdate((p) => p.status === 'failed_permanently');
    expect(perm).toBeDefined();
    expect(perm.next_retry_at).toBeNull();
    expect(syncJobUpdate((p) => p.status === 'pending_retry')).toBeUndefined();
  });

  it('marks failed_permanently once the retry budget is exhausted', async () => {
    ingestSquareMock.mockRejectedValue(new Error('Square API 500'));

    // retryCount=5 means this is the 6th attempt → beyond MAX_SYNC_RETRIES.
    await syncIntegration(squareRow(), 'square', 'retry', 5, 'existing-job-1');

    const perm = syncJobUpdate((p) => p.status === 'failed_permanently');
    expect(perm).toBeDefined();
    expect(perm.next_retry_at).toBeNull();
  });

  it('a dispatched retry reuses its own job row instead of creating a new one', async () => {
    ingestSquareMock.mockResolvedValue({ ok: true, catalogCount: 1, orderCount: 1 });

    await syncIntegration(squareRow(), 'square', 'retry', 1, 'existing-job-1');

    // No new sync_jobs row was inserted — the existing one was continued.
    const jobInserts = mockState.inserts.filter((i) => i.table === 'sync_jobs');
    expect(jobInserts).toHaveLength(0);
    // The existing row was flipped to running (leaves pending_retry → not re-due).
    expect(syncJobUpdate((p) => p.status === 'running')).toBeDefined();
    expect(syncJobUpdate((p) => p.status === 'success')).toBeDefined();
  });
});

describe('runScheduledSync — failure isolation', () => {
  it('one restaurant failing does not stop the others', async () => {
    mockState.restaurants = [
      squareRow({ id: 'r1' }),
      squareRow({ id: 'r2' }),
    ];
    ingestSquareMock
      .mockRejectedValueOnce(new Error('r1 boom'))
      .mockResolvedValueOnce({ ok: true, catalogCount: 1, orderCount: 2 });

    const outcomes = await runScheduledSync();

    // Both restaurants were attempted despite the first throwing.
    expect(ingestSquareMock).toHaveBeenCalledTimes(2);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((o) => o.restaurantId === 'r1')!.status).toBe('failed');
    expect(outcomes.find((o) => o.restaurantId === 'r2')!.status).toBe('success');
  });
});
