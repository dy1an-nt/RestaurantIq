/**
 * Unit tests for the scheduler tick logic (Sprint L+).
 *
 * leaderElection, syncScheduler, and syncJobs are fully mocked so no pg
 * connection or Supabase calls are made. Tests verify:
 *   - Non-leader instances return early without dispatching.
 *   - Leader calls discoverActiveIntegrations and dispatches syncs.
 *   - Due retry jobs are fetched each tick.
 *   - An integration the retry phase just ran is not dispatched again by
 *     discovery in the same tick (per provider, not per restaurant).
 *   - One integration failing does not stop the rest of the batch.
 *   - The batch cap rotates: least-recently-attempted integrations go first.
 */

// ── Module-level mocks (must be defined before imports) ──────────────────────

const mockIsLeader = jest.fn(() => false);
const mockVerifyLeadership = jest.fn(async () => false);
const mockAcquireLeadership = jest.fn(async () => false);
const mockReleaseLeadership = jest.fn(async () => {});
const MOCK_INSTANCE_ID = 'test-instance-1';

jest.mock('../leaderElection', () => ({
  isLeader: () => mockIsLeader(),
  verifyLeadership: (...a: any[]) => mockVerifyLeadership(...a),
  acquireLeadership: (...a: any[]) => mockAcquireLeadership(...a),
  releaseLeadership: (...a: any[]) => mockReleaseLeadership(...a),
  INSTANCE_ID: MOCK_INSTANCE_ID,
}));

const mockSyncIntegration = jest.fn(async () => ({ ok: true, status: 'success' }));
const mockDiscoverActiveIntegrations = jest.fn(async () => []);

jest.mock('../../syncScheduler', () => ({
  syncIntegration: (...a: any[]) => mockSyncIntegration(...a),
  discoverActiveIntegrations: (...a: any[]) => mockDiscoverActiveIntegrations(...a),
}));

const mockFindDueRetryJobs = jest.fn(async () => []);

jest.mock('../syncJobs', () => ({
  findDueRetryJobs: (...a: any[]) => mockFindDueRetryJobs(...a),
}));

// Rows the mocked `restaurants` table returns. The retry phase looks up each
// job's restaurant before dispatching, so a retry test that leaves this empty
// silently exercises the "row not found" early return instead.
let mockRestaurantRows: any[] = [];

// Rows the mocked `integration_sync_status` table returns, used to order the
// discovery batch by staleness.
let mockSyncStatusRows: any[] = [];

// Supabase mock: supports the scheduler_state upsert AND the restaurants .select().in() chain
// used when processing retry jobs.
jest.mock('../../../db', () => {
  const makeChainable = (finalValue: (from?: number, to?: number) => any): any => {
    const proxy: any = {
      upsert: () => Promise.resolve({ error: null }),
      select: () => proxy,
      eq: () => proxy,
      order: () => proxy,
      // The status read is range-paged, so the mock slices like PostgREST does.
      // A short page ends the walk.
      range: (from: number, to: number) => Promise.resolve(finalValue(from, to)),
      in: () => Promise.resolve(finalValue()),
      then: (resolve: any, reject: any) => Promise.resolve(finalValue()).then(resolve, reject),
    };
    return proxy;
  };
  return {
    supabase: {
      from: (table: string) =>
        makeChainable((from?: number, to?: number) => {
          if (table === 'restaurants') return { data: mockRestaurantRows, error: null };
          if (table === 'integration_sync_status') {
            // PostgREST silently caps an unranged select at max-rows. Emulating
            // that is what makes the paging test below discriminate.
            const rows =
              from === undefined
                ? mockSyncStatusRows.slice(0, 1000)
                : mockSyncStatusRows.slice(from, to! + 1);
            return { data: rows, error: null };
          }
          return { data: [], error: null };
        }),
    },
  };
});

import { runSchedulerTick } from '../index';

beforeEach(() => {
  mockIsLeader.mockReturnValue(false);
  mockVerifyLeadership.mockResolvedValue(false);
  mockAcquireLeadership.mockResolvedValue(false);
  mockSyncIntegration.mockResolvedValue({ ok: true, status: 'success' } as any);
  mockDiscoverActiveIntegrations.mockResolvedValue([]);
  mockFindDueRetryJobs.mockResolvedValue([]);
  mockRestaurantRows = [];
  mockSyncStatusRows = [];
  delete process.env.SYNC_BATCH_SIZE;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

// ── Non-leader ────────────────────────────────────────────────────────────────

describe('runSchedulerTick — non-leader', () => {
  it('returns 0 and does not dispatch any syncs when not the leader', async () => {
    mockIsLeader.mockReturnValue(false);
    mockAcquireLeadership.mockResolvedValue(false);

    const processed = await runSchedulerTick();

    expect(processed).toBe(0);
    expect(mockSyncIntegration).not.toHaveBeenCalled();
    expect(mockDiscoverActiveIntegrations).not.toHaveBeenCalled();
  });
});

// ── Leader ────────────────────────────────────────────────────────────────────

describe('runSchedulerTick — leader', () => {
  beforeEach(() => {
    // Already the leader — verifyLeadership is called (not acquireLeadership).
    mockIsLeader.mockReturnValue(true);
    mockVerifyLeadership.mockResolvedValue(true);
  });

  it('calls findDueRetryJobs on every tick', async () => {
    await runSchedulerTick();
    expect(mockFindDueRetryJobs).toHaveBeenCalled();
  });

  it('discovers integrations and dispatches syncs', async () => {
    mockFindDueRetryJobs.mockResolvedValue([]);
    const fakeRow = {
      id: 'r1', pos_connected: true, square_location_id: 'loc1',
      square_access_token: 'tok', square_refresh_token: null,
      square_token_expires_at: null, delivery_connected: false,
      doordash_store_id: null, doordash_access_token: null,
      doordash_refresh_token: null, doordash_token_expires_at: null,
    };
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: fakeRow as any, provider: 'square' as any },
    ]);

    await runSchedulerTick();

    expect(mockDiscoverActiveIntegrations).toHaveBeenCalled();
    expect(mockSyncIntegration).toHaveBeenCalledWith(fakeRow, 'square', 'scheduled');
  });

  it('returns the number of jobs processed (one integration dispatched)', async () => {
    mockFindDueRetryJobs.mockResolvedValue([]);
    const fakeRow = { id: 'r1', pos_connected: true, square_location_id: 'loc1',
      square_access_token: 'tok', square_refresh_token: null, square_token_expires_at: null,
      delivery_connected: false, doordash_store_id: null, doordash_access_token: null,
      doordash_refresh_token: null, doordash_token_expires_at: null };
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: fakeRow as any, provider: 'square' as any },
    ]);

    const count = await runSchedulerTick();

    expect(count).toBe(1);
  });

  it('calls discoverActiveIntegrations even when retries are present', async () => {
    // Even with retry jobs, fresh discovery should still run.
    const retryJob = {
      id: 'job-1', restaurant_id: 'r1', provider: 'square', retry_count: 1,
      next_retry_at: new Date().toISOString(), status: 'pending_retry',
    };
    mockFindDueRetryJobs.mockResolvedValue([retryJob as any]);
    mockDiscoverActiveIntegrations.mockResolvedValue([]);

    await runSchedulerTick();

    expect(mockDiscoverActiveIntegrations).toHaveBeenCalled();
  });
});

// ── Retry / discovery de-duplication ─────────────────────────────────────────

const rowFor = (id: string, over: Record<string, any> = {}) => ({
  id,
  pos_connected: true,
  square_location_id: 'loc1',
  square_access_token: 'tok',
  square_refresh_token: null,
  square_token_expires_at: null,
  delivery_connected: false,
  doordash_store_id: null,
  doordash_access_token: null,
  doordash_refresh_token: null,
  doordash_token_expires_at: null,
  ...over,
});

const retryJobFor = (restaurantId: string, provider: string, id = 'job-1') => ({
  id,
  restaurant_id: restaurantId,
  provider,
  retry_count: 1,
  next_retry_at: new Date().toISOString(),
  status: 'pending_retry',
});

describe('runSchedulerTick: retry and discovery de-duplication', () => {
  beforeEach(() => {
    mockIsLeader.mockReturnValue(true);
    mockVerifyLeadership.mockResolvedValue(true);
  });

  it('does not also dispatch a fresh sync for an integration the retry phase ran', async () => {
    const row = rowFor('r1');
    mockRestaurantRows = [row];
    mockFindDueRetryJobs.mockResolvedValue([retryJobFor('r1', 'square') as any]);
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: row as any, provider: 'square' as any },
    ]);

    await runSchedulerTick();

    // The retry ran and released its lock, so an unfiltered discovery pass
    // would sync the same integration a second time in this tick.
    expect(mockSyncIntegration).toHaveBeenCalledTimes(1);
    expect(mockSyncIntegration).toHaveBeenCalledWith(row, 'square', 'retry', 1, 'job-1');
  });

  it('still dispatches a different provider on the same restaurant', async () => {
    // The skip key is (restaurant, provider). A per-restaurant key would
    // wrongly starve DoorDash whenever Square happened to be retrying.
    const row = rowFor('r1', { delivery_connected: true, doordash_store_id: 'store1' });
    mockRestaurantRows = [row];
    mockFindDueRetryJobs.mockResolvedValue([retryJobFor('r1', 'square') as any]);
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: row as any, provider: 'square' as any },
      { row: row as any, provider: 'doordash' as any },
    ]);

    await runSchedulerTick();

    expect(mockSyncIntegration).toHaveBeenCalledTimes(2);
    expect(mockSyncIntegration).toHaveBeenCalledWith(row, 'square', 'retry', 1, 'job-1');
    expect(mockSyncIntegration).toHaveBeenCalledWith(row, 'doordash', 'scheduled');
  });

  it('does not skip an integration whose retry job had no restaurant row', async () => {
    // The retry task returns early when the row lookup misses, so nothing was
    // synced and discovery must still get its chance.
    const row = rowFor('r1');
    mockRestaurantRows = [];
    mockFindDueRetryJobs.mockResolvedValue([retryJobFor('r1', 'square') as any]);
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: row as any, provider: 'square' as any },
    ]);

    await runSchedulerTick();

    expect(mockSyncIntegration).toHaveBeenCalledTimes(1);
    expect(mockSyncIntegration).toHaveBeenCalledWith(row, 'square', 'scheduled');
  });
});

// ── Failure isolation ────────────────────────────────────────────────────────

describe('runSchedulerTick: failure isolation', () => {
  beforeEach(() => {
    mockIsLeader.mockReturnValue(true);
    mockVerifyLeadership.mockResolvedValue(true);
  });

  it('one integration failing does not stop the others', async () => {
    const r1 = rowFor('r1');
    const r2 = rowFor('r2');
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: r1 as any, provider: 'square' as any },
      { row: r2 as any, provider: 'square' as any },
    ]);
    mockSyncIntegration
      .mockRejectedValueOnce(new Error('r1 boom'))
      .mockResolvedValueOnce({ ok: true, status: 'success' } as any);

    const count = await runSchedulerTick();

    // Both were attempted, the tick did not throw, and only the survivor counted.
    expect(mockSyncIntegration).toHaveBeenCalledTimes(2);
    expect(count).toBe(1);
  });
});

// ── Batch rotation ───────────────────────────────────────────────────────────

describe('runSchedulerTick: batch rotation', () => {
  beforeEach(() => {
    mockIsLeader.mockReturnValue(true);
    mockVerifyLeadership.mockResolvedValue(true);
  });

  const statusRow = (restaurantId: string, minutesAgo: number | null) => ({
    restaurant_id: restaurantId,
    provider: 'square',
    last_attempted_at:
      minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });

  it('dispatches the least-recently-attempted integrations first', async () => {
    process.env.SYNC_BATCH_SIZE = '2';
    // Discovery order is deliberately the opposite of the desired sync order.
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: rowFor('fresh') as any, provider: 'square' as any },
      { row: rowFor('stale') as any, provider: 'square' as any },
      { row: rowFor('stalest') as any, provider: 'square' as any },
    ]);
    mockSyncStatusRows = [
      statusRow('fresh', 1),
      statusRow('stale', 60),
      statusRow('stalest', 600),
    ];

    await runSchedulerTick();

    const dispatched = mockSyncIntegration.mock.calls.map((c: any[]) => c[0].id);
    expect(dispatched).toEqual(['stalest', 'stale']);
    // The batch cap held: 'fresh' waits for a later tick rather than being
    // dropped permanently, which is what an unordered prefix used to do.
    expect(dispatched).not.toContain('fresh');
  });

  it('puts a never-attempted integration ahead of every attempted one', async () => {
    process.env.SYNC_BATCH_SIZE = '1';
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: rowFor('attempted') as any, provider: 'square' as any },
      { row: rowFor('brand-new') as any, provider: 'square' as any },
    ]);
    // 'brand-new' has no status row at all, the state of an integration that
    // has never run.
    mockSyncStatusRows = [statusRow('attempted', 5)];

    await runSchedulerTick();

    expect(mockSyncIntegration).toHaveBeenCalledTimes(1);
    expect(mockSyncIntegration.mock.calls[0][0].id).toBe('brand-new');
  });

  it('reads past the first status page instead of being truncated', async () => {
    // PostgREST caps an unranged select (commonly at 1000 rows). A pair missing
    // from a truncated page reads as never-attempted and jumps to the head of
    // the batch, so the read has to page or the ordering inverts at exactly the
    // scale it exists for. 'deep' is freshly synced but sits on page 2.
    process.env.SYNC_BATCH_SIZE = '1';
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: rowFor('deep') as any, provider: 'square' as any },
      { row: rowFor('stale') as any, provider: 'square' as any },
    ]);
    const filler = Array.from({ length: 999 }, (_, i) => statusRow(`filler-${i}`, 30));
    mockSyncStatusRows = [statusRow('stale', 600), ...filler, statusRow('deep', 1)];
    expect(mockSyncStatusRows).toHaveLength(1001);

    await runSchedulerTick();

    // Page 2 was read, so 'deep' is known to be fresh and 'stale' goes first.
    expect(mockSyncIntegration).toHaveBeenCalledTimes(1);
    expect(mockSyncIntegration.mock.calls[0][0].id).toBe('stale');
  });

  it('falls back to discovery order when the status lookup is unavailable', async () => {
    process.env.SYNC_BATCH_SIZE = '5';
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: rowFor('r1') as any, provider: 'square' as any },
      { row: rowFor('r2') as any, provider: 'square' as any },
    ]);
    mockSyncStatusRows = [];

    const count = await runSchedulerTick();

    // Ordering is best effort. With no status rows every integration ties and
    // the tick must still dispatch all of them.
    expect(count).toBe(2);
  });
});
