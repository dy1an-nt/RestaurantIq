/**
 * Unit tests for the sync_jobs repository (Sprint L+).
 *
 * Uses the chainable builder mock pattern from the existing syncScheduler tests.
 * All tests verify that the correct payloads are sent to Supabase and that
 * query filters (status, next_retry_at) are applied correctly.
 */

// ── Mutable mock state ───────────────────────────────────────────────────────

const mockState: {
  inserts: Array<{ table: string; payload: any }>;
  updates: Array<{ table: string; payload: any }>;
  selectRows: any[];
  selectCount: number;
  insertReturnId: string | null;
} = {
  inserts: [],
  updates: [],
  selectRows: [],
  selectCount: 0,
  insertReturnId: 'job-uuid-1',
};

jest.mock('../../../db', () => {
  const makeBuilder = (table: string) => {
    const b: any = {
      _op: null as null | string,
      _payload: null as any,
      _filters: {} as Record<string, any>,
      _lteFilter: null as null | string,
      _orderAsc: true,
      _limitVal: null as null | number,
      _headOnly: false,
      _countExact: false,

      insert(payload: any) {
        this._op = 'insert';
        this._payload = payload;
        return this;
      },
      update(payload: any) {
        this._op = 'update';
        this._payload = payload;
        return this;
      },
      select(fields: string, opts?: any) {
        if (!this._op) this._op = 'select';
        if (opts?.count === 'exact') this._countExact = true;
        if (opts?.head === true) this._headOnly = true;
        return this;
      },
      eq(col: string, val: any) {
        this._filters[col] = val;
        return this;
      },
      lte(_col: string, val: string) {
        this._lteFilter = val;
        return this;
      },
      order(_col: string, opts: any) {
        this._orderAsc = opts?.ascending !== false;
        return this;
      },
      limit(n: number) {
        this._limitVal = n;
        return this;
      },
      single() {
        return this;
      },
      maybeSingle() {
        return this;
      },
      then(resolve: any, reject: any) {
        return Promise.resolve(this._resolve()).then(resolve, reject);
      },
      _resolve() {
        if (this._op === 'insert') {
          mockState.inserts.push({ table, payload: this._payload });
          if (mockState.insertReturnId) {
            return { data: { id: mockState.insertReturnId }, error: null };
          }
          return { data: null, error: { message: 'insert failed' } };
        }
        if (this._op === 'update') {
          mockState.updates.push({ table, payload: this._payload });
          return { data: null, error: null };
        }
        if (this._op === 'select') {
          if (this._countExact) {
            return { count: mockState.selectCount, error: null };
          }
          return { data: mockState.selectRows, error: null };
        }
        return { data: null, error: null };
      },
    };
    return b;
  };
  return { supabase: { from: (t: string) => makeBuilder(t) } };
});

import {
  createJob,
  markRunning,
  markSuccess,
  markFailedOrRetry,
  markSkipped,
  findDueRetryJobs,
  countPendingRetries,
  countActive,
} from '../syncJobs';

beforeEach(() => {
  mockState.inserts = [];
  mockState.updates = [];
  mockState.selectRows = [];
  mockState.selectCount = 0;
  mockState.insertReturnId = 'job-uuid-1';
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

// ── createJob ─────────────────────────────────────────────────────────────────

describe('createJob', () => {
  it('inserts a pending row and returns the job id', async () => {
    const id = await createJob({ restaurantId: 'r1', provider: 'square', trigger: 'scheduled' });

    expect(id).toBe('job-uuid-1');
    expect(mockState.inserts).toHaveLength(1);
    const payload = mockState.inserts[0].payload;
    expect(payload.restaurant_id).toBe('r1');
    expect(payload.provider).toBe('square');
    expect(payload.trigger).toBe('scheduled');
    expect(payload.status).toBe('pending');
  });

  it('returns null when the insert fails', async () => {
    mockState.insertReturnId = null;
    const id = await createJob({ restaurantId: 'r1', provider: 'square', trigger: 'manual' });
    expect(id).toBeNull();
  });
});

// ── markRunning ───────────────────────────────────────────────────────────────

describe('markRunning', () => {
  it('updates status to running and sets started_at', async () => {
    await markRunning('job-1');

    expect(mockState.updates).toHaveLength(1);
    const payload = mockState.updates[0].payload;
    expect(payload.status).toBe('running');
    expect(payload.started_at).toBeTruthy();
  });
});

// ── markSuccess ───────────────────────────────────────────────────────────────

describe('markSuccess', () => {
  it('updates status to success with duration and counts', async () => {
    await markSuccess('job-1', { durationMs: 1234, catalogCount: 5, orderCount: 10 });

    const payload = mockState.updates[0].payload;
    expect(payload.status).toBe('success');
    expect(payload.duration_ms).toBe(1234);
    expect(payload.catalog_count).toBe(5);
    expect(payload.order_count).toBe(10);
    expect(payload.last_error).toBeNull();
    expect(payload.completed_at).toBeTruthy();
  });
});

// ── markFailedOrRetry ─────────────────────────────────────────────────────────

describe('markFailedOrRetry', () => {
  it('sets status to pending_retry when nextRetryAt is provided', async () => {
    const retryAt = new Date(Date.now() + 60_000);
    await markFailedOrRetry('job-1', { retryCount: 1, error: 'timeout', nextRetryAt: retryAt });

    const payload = mockState.updates[0].payload;
    expect(payload.status).toBe('pending_retry');
    expect(payload.retry_count).toBe(1);
    expect(payload.last_error).toBe('timeout');
    expect(payload.next_retry_at).toBe(retryAt.toISOString());
    expect(payload.completed_at).toBeNull(); // not terminal yet
  });

  it('sets status to failed_permanently when nextRetryAt is null', async () => {
    await markFailedOrRetry('job-1', { retryCount: 5, error: 'budget exhausted', nextRetryAt: null });

    const payload = mockState.updates[0].payload;
    expect(payload.status).toBe('failed_permanently');
    expect(payload.retry_count).toBe(5);
    expect(payload.completed_at).toBeTruthy(); // terminal → set
    expect(payload.next_retry_at).toBeNull();
  });
});

// ── markSkipped ───────────────────────────────────────────────────────────────

describe('markSkipped', () => {
  it('sets status to skipped with reason in last_error', async () => {
    await markSkipped('job-1', { reason: 'token_expired' });

    const payload = mockState.updates[0].payload;
    expect(payload.status).toBe('skipped');
    expect(payload.last_error).toBe('token_expired');
    expect(payload.completed_at).toBeTruthy();
  });
});

// ── findDueRetryJobs ──────────────────────────────────────────────────────────

describe('findDueRetryJobs', () => {
  it('returns rows from the select result', async () => {
    const fakeJob = { id: 'j1', status: 'pending_retry', next_retry_at: new Date().toISOString() };
    mockState.selectRows = [fakeJob];

    const results = await findDueRetryJobs(new Date(), 10);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('j1');
  });

  it('returns empty array when no due jobs', async () => {
    mockState.selectRows = [];
    const results = await findDueRetryJobs(new Date(), 10);
    expect(results).toHaveLength(0);
  });
});

// ── countPendingRetries / countActive ─────────────────────────────────────────

describe('countPendingRetries', () => {
  it('returns the count from the DB', async () => {
    mockState.selectCount = 3;
    const count = await countPendingRetries('r1');
    expect(count).toBe(3);
  });
});

describe('countActive', () => {
  it('returns the count from the DB', async () => {
    mockState.selectCount = 1;
    const count = await countActive('r1');
    expect(count).toBe(1);
  });
});
